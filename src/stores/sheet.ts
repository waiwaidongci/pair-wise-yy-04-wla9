import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { CellCoord, CellMap, CellRange, CellRecord, CellValue } from '../types/sheet'
import type { CellConflict, CellOp, CellVersion, SessionId, VersionVector } from '../types/revision'
import { cellId, columnIndex, displayValue, literalValue, normalizeRange, rangeContains } from '../utils/cells'
import { FormulaError, evaluateAst, formulaDependencies, parseFormula } from '../utils/formula'
import {
  applyOp,
  clearAllSessionOps,
  cloneVV,
  conflictsOf,
  createSessionId,
  displayVersion,
  emptyVV,
  loadAllSessionOps,
  makeOp,
  replayOps,
  saveSessionOps,
  vvEqual,
} from '../utils/revision'

const ROWS = 1000
const COLS = 26
const CHANNEL_NAME = 'gridformula-revision'

function createStarterCells(): CellMap {
  const cells: CellMap = {}
  const put = (id: string, raw: string) => { cells[id] = { raw, value: raw.startsWith('=') ? null : literalValue(raw) } }
  put('A1', '区域')
  put('B1', '一月')
  put('C1', '二月')
  put('D1', '三月')
  put('E1', '季度合计')
  put('A2', '华北')
  put('B2', '128000')
  put('C2', '143500')
  put('D2', '151200')
  put('A3', '华东')
  put('B3', '186000')
  put('C3', '193400')
  put('D3', '205800')
  put('A4', '华南')
  put('B4', '97000')
  put('C4', '118600')
  put('D4', '126900')
  put('A5', '西南')
  put('B5', '76000')
  put('C5', '83400')
  put('D5', '92100')
  put('E2', '=SUM(B2:D2)')
  put('E3', '=SUM(B3:D3)')
  put('E4', '=SUM(B4:D4)')
  put('E5', '=SUM(B5:D5)')
  put('A6', '合计')
  put('B6', '=SUM(B2:B5)')
  put('C6', '=SUM(C2:C5)')
  put('D6', '=SUM(D2:D5)')
  put('E6', '=SUM(E2:E5)')
  put('A8', '月均销售')
  put('B8', '=ROUND(AVERAGE(B2:B5),0)')
  put('C8', '=ROUND(AVERAGE(C2:C5),0)')
  put('D8', '=ROUND(AVERAGE(D2:D5),0)')
  put('E8', '=ROUND(AVERAGE(E2:E5),0)')
  put('A10', '最高区域')
  put('B10', '=MAX(E2:E5)')
  put('A11', '最低区域')
  put('B11', '=MIN(E2:E5)')
  put('A13', '达标说明')
  put('B13', '=IF(E6>1500000,"达成季度目标","需要关注")')
  return cells
}

interface UndoEntry {
  undo: Array<{ cellId: string; raw: string }>
  redo: Array<{ cellId: string; raw: string }>
}

export const useSheetStore = defineStore('sheet', () => {
  const rows = ROWS
  const cols = COLS
  const cells = ref<CellMap>(createStarterCells())
  const active = ref<CellCoord>({ row: 1, col: 4 })
  const selection = ref<CellRange>({ start: { row: 1, col: 4 }, end: { row: 1, col: 4 } })
  const freezeRows = ref(1)
  const freezeCols = ref(1)
  const lastRecalculated = ref<string[]>([])
  const status = ref('工作簿已加载，公式引擎待命')

  // ---- 修订记录 ----
  const sessionId = ref<SessionId>('')
  const baseVV = ref<VersionVector>(emptyVV())
  const vv = ref<VersionVector>(emptyVV())
  const heads = ref<Map<string, CellVersion[]>>(new Map())
  const conflicts = ref<CellConflict[]>([])
  const opLog = ref<CellOp[]>([])
  const undoStack = ref<UndoEntry[]>([])
  const redoStack = ref<UndoEntry[]>([])

  // ---- 公式重算（批次围栏 + 重试 + 上次有效值）----
  const recalcGeneration = ref(0)
  const dirtyCells = ref<Set<string>>(new Set())
  const recalcState = ref<'idle' | 'running' | 'retrying' | 'failed'>('idle')
  const lastGood = ref<Map<string, CellValue>>(new Map())
  let recalcLoopRunning = false

  // ---- UI ----
  const revisionPanelOpen = ref(false)

  const activeRaw = computed(() => getRaw(active.value.row, active.value.col))
  const activeValue = computed(() => cells.value[cellId(active.value.row, active.value.col)]?.value ?? null)
  const canUndo = computed(() => undoStack.value.length > 0)
  const canRedo = computed(() => redoStack.value.length > 0)
  const localSeq = computed(() => vv.value[sessionId.value] ?? 0)
  const dirtyCount = computed(() => dirtyCells.value.size)

  function idFor(row: number, col: number) {
    return cellId(row, col)
  }

  function getRaw(row: number, col: number) {
    return cells.value[idFor(row, col)]?.raw ?? ''
  }

  function getRecord(row: number, col: number): CellRecord | undefined {
    return cells.value[idFor(row, col)]
  }

  function dependencyMap() {
    const map = new Map<string, Set<string>>()
    Object.entries(cells.value).forEach(([id, cell]) => {
      if (!cell.raw.startsWith('=')) return
      const deps = formulaDependencies(cell.raw)
      deps.forEach((dep) => map.set(dep, new Set([...(map.get(dep) ?? []), id])))
    })
    return map
  }

  function affectedCells(startIds: string[]) {
    const map = dependencyMap()
    const affected = new Set(startIds)
    const queue = [...startIds]
    while (queue.length) {
      const id = queue.shift()!
      for (const dependent of map.get(id) ?? []) {
        if (!affected.has(dependent)) {
          affected.add(dependent)
          queue.push(dependent)
        }
      }
    }
    return affected
  }

  // ---- 修订操作 ----

  function persistSessionOps() {
    const own = opLog.value.filter((o) => o.sessionId === sessionId.value)
    saveSessionOps(sessionId.value, own)
  }

  function applyRevisionOp(op: CellOp, opts: { persist: boolean; broadcast: boolean }): boolean {
    const res = applyOp(heads.value, vv.value, op)
    if (!res.outcome.applied) return false
    heads.value = res.heads
    vv.value = res.vv
    conflicts.value = conflictsOf(heads.value)
    opLog.value = [...opLog.value, op].sort((a, b) => a.timestamp - b.timestamp || a.opId.localeCompare(b.opId))
    if (opts.persist) persistSessionOps()
    if (opts.broadcast) postToChannel({ type: 'op', op })
    return true
  }

  function makeLocalOp(cellId: string, raw: string): CellOp {
    const seq = (vv.value[sessionId.value] ?? 0) + 1
    return makeOp(sessionId.value, seq, cellId, raw, vv.value)
  }

  function applyRawToCell(id: string, raw: string) {
    const record = cells.value[id]
    cells.value[id] = {
      ...record,
      raw,
      value: raw.startsWith('=') ? null : literalValue(raw),
      error: undefined,
      stale: false,
    }
  }

  /** 合并后把某格的展示 raw 同步为当前版本（冲突时取最新一版） */
  function syncHeadToCell(id: string) {
    const versions = heads.value.get(id)
    if (!versions || versions.length === 0) return
    const display = displayVersion(versions)
    const record = cells.value[id]
    cells.value[id] = {
      ...record,
      raw: display.raw,
      value: display.raw.startsWith('=') ? null : literalValue(display.raw),
      error: undefined,
      stale: false,
      conflict: versions.length > 1,
    }
  }

  function rebuildAllRaw() {
    const next = createStarterCells()
    for (const [id, versions] of heads.value) {
      const display = displayVersion(versions)
      next[id] = {
        raw: display.raw,
        value: display.raw.startsWith('=') ? null : literalValue(display.raw),
        error: undefined,
        stale: false,
        conflict: versions.length > 1,
      }
    }
    cells.value = next
  }

  function setRaw(row: number, col: number, raw: string) {
    const id = idFor(row, col)
    const prevRaw = cells.value[id]?.raw ?? ''
    if (prevRaw === raw) return
    const op = makeLocalOp(id, raw)
    if (!applyRevisionOp(op, { persist: true, broadcast: true })) return
    applyRawToCell(id, raw)
    scheduleRecalc([id])
    undoStack.value.push({ undo: [{ cellId: id, raw: prevRaw }], redo: [{ cellId: id, raw }] })
    redoStack.value = []
  }

  function setManyRaw(start: CellCoord, matrix: string[][]) {
    const undoEntries: Array<{ cellId: string; raw: string }> = []
    const redoEntries: Array<{ cellId: string; raw: string }> = []
    const changed: string[] = []
    matrix.forEach((rowValues, rowOffset) => {
      rowValues.forEach((raw, colOffset) => {
        const row = start.row + rowOffset
        const col = start.col + colOffset
        if (row >= rows || col >= cols) return
        const id = idFor(row, col)
        const prevRaw = cells.value[id]?.raw ?? ''
        if (prevRaw === raw) return
        const op = makeLocalOp(id, raw)
        if (!applyRevisionOp(op, { persist: true, broadcast: true })) return
        applyRawToCell(id, raw)
        undoEntries.push({ cellId: id, raw: prevRaw })
        redoEntries.push({ cellId: id, raw })
        changed.push(id)
      })
    })
    if (changed.length) {
      scheduleRecalc(changed)
      undoStack.value.push({ undo: undoEntries, redo: redoEntries })
      redoStack.value = []
    }
  }

  function setActive(row: number, col: number, extend = false) {
    const next = {
      row: Math.max(0, Math.min(rows - 1, row)),
      col: Math.max(0, Math.min(cols - 1, col)),
    }
    active.value = next
    if (!extend) selection.value = { start: { ...next }, end: { ...next } }
    else selection.value.end = { ...next }
  }

  function setSelectionEnd(row: number, col: number) {
    selection.value.end = {
      row: Math.max(0, Math.min(rows - 1, row)),
      col: Math.max(0, Math.min(cols - 1, col)),
    }
  }

  function selectedMatrix() {
    const range = normalizeRange(selection.value)
    const matrix: string[][] = []
    for (let row = range.start.row; row <= range.end.row; row += 1) {
      const values: string[] = []
      for (let col = range.start.col; col <= range.end.col; col += 1) values.push(getRaw(row, col))
      matrix.push(values)
    }
    return matrix
  }

  function selectedText() {
    return selectedMatrix().map((row) => row.map((cell) => cell.replace(/\t/g, ' ')).join('\t')).join('\n')
  }

  function pasteText(text: string) {
    const matrix = text.replace(/\r/g, '').split('\n').filter((row, index, list) => row.length || index < list.length - 1).map((row) => row.split('\t'))
    if (matrix.length) setManyRaw(active.value, matrix)
  }

  function clearSelection() {
    const range = normalizeRange(selection.value)
    const matrix = Array.from({ length: range.end.row - range.start.row + 1 }, () => Array(range.end.col - range.start.col + 1).fill(''))
    setManyRaw(range.start, matrix)
  }

  function undo() {
    const entry = undoStack.value.pop()
    if (!entry) return
    const changed: string[] = []
    for (const { cellId, raw } of entry.undo) {
      const op = makeLocalOp(cellId, raw)
      if (applyRevisionOp(op, { persist: true, broadcast: true })) {
        applyRawToCell(cellId, raw)
        changed.push(cellId)
      }
    }
    if (changed.length) {
      redoStack.value.push(entry)
      scheduleRecalc(changed)
      status.value = '已撤销（作为新操作追加到修订记录）'
    }
  }

  function redo() {
    const entry = redoStack.value.pop()
    if (!entry) return
    const changed: string[] = []
    for (const { cellId, raw } of entry.redo) {
      const op = makeLocalOp(cellId, raw)
      if (applyRevisionOp(op, { persist: true, broadcast: true })) {
        applyRawToCell(cellId, raw)
        changed.push(cellId)
      }
    }
    if (changed.length) {
      undoStack.value.push(entry)
      scheduleRecalc(changed)
      status.value = '已重做（作为新操作追加到修订记录）'
    }
  }

  /** 同格两版待选：采用某一版（追加一条本地操作背书，跨标签页同步） */
  function selectVersion(cellId: string, opId: string) {
    const versions = heads.value.get(cellId) ?? []
    const chosen = versions.find((v) => v.opId === opId)
    if (!chosen) return
    const op = makeLocalOp(cellId, chosen.raw)
    if (applyRevisionOp(op, { persist: true, broadcast: true })) {
      applyRawToCell(cellId, chosen.raw)
      scheduleRecalc([cellId])
      status.value = `已采用 ${chosen.sessionId} 版（操作 ${op.opId}）`
    }
  }

  function isSelected(row: number, col: number) {
    return rangeContains(selection.value, row, col)
  }

  function getCellFlags(id: string) {
    return {
      conflict: conflicts.value.some((c) => c.cellId === id),
      stale: cells.value[id]?.stale ?? false,
      dirty: dirtyCells.value.has(id),
    }
  }

  // ---- 公式重算 ----

  function scheduleRecalc(changedIds: string[] | Set<string>) {
    const affected = affectedCells([...changedIds])
    const dirty = new Set(dirtyCells.value)
    affected.forEach((id) => dirty.add(id))
    dirtyCells.value = dirty
    recalcGeneration.value += 1
    void runRecalcLoop()
  }

  function delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  function evaluateBatch(ids: Set<string>): { results: Map<string, CellValue>; failures: Map<string, string> } {
    const results = new Map<string, CellValue>()
    const failures = new Map<string, string>()
    const resolved = new Map<string, CellValue>()
    const failedCycles = new Set<string>()

    const resolve = (id: string, stack: string[]): CellValue => {
      if (resolved.has(id)) return resolved.get(id) ?? null
      if (stack.includes(id)) {
        stack.forEach((item) => failedCycles.add(item))
        throw new FormulaError('#CYCLE!')
      }
      const record = cells.value[id]
      if (!record) return null
      if (!record.raw.startsWith('=')) {
        const value = literalValue(record.raw)
        resolved.set(id, value)
        return value
      }
      const ast = parseFormula(record.raw)
      const nextStack = [...stack, id]
      const value = evaluateAst(
        ast,
        (reference) => resolve(reference, nextStack),
        (range) => {
          const [start, end] = range.split(':')
          const idsInRange: string[] = []
          const startMatch = /^([A-Z]+)(\d+)$/i.exec(start)
          const endMatch = /^([A-Z]+)(\d+)$/i.exec(end)
          if (startMatch && endMatch) {
            const startCol = columnIndex(startMatch[1])
            const endCol = columnIndex(endMatch[1])
            for (let row = Number(startMatch[2]) - 1; row <= Number(endMatch[2]) - 1; row += 1) {
              for (let col = startCol; col <= endCol; col += 1) idsInRange.push(cellId(row, col))
            }
          }
          return idsInRange.map((cell) => resolve(cell, nextStack))
        },
      ) as CellValue
      resolved.set(id, value)
      return value
    }

    ids.forEach((id) => {
      try {
        results.set(id, resolve(id, []))
      } catch (error) {
        const code = error instanceof FormulaError ? error.code : '#ERROR!'
        failures.set(id, failedCycles.has(id) ? '#CYCLE!' : code)
      }
    })
    return { results, failures }
  }

  function commitResults(ids: Set<string>, results: Map<string, CellValue>, failures: Map<string, string>) {
    const next = { ...cells.value }
    const dirty = new Set(dirtyCells.value)
    for (const id of ids) {
      const record = next[id]
      if (!record) {
        dirty.delete(id)
        continue
      }
      if (failures.has(id)) {
        const code = failures.get(id)!
        const good = lastGood.value.get(id)
        if (good !== undefined) {
          // 重试后仍失败：保留上次有效值
          next[id] = { ...record, value: good, error: code, stale: true }
        } else {
          next[id] = { ...record, value: null, error: code, stale: true }
        }
      } else {
        const value = results.get(id) ?? null
        next[id] = { ...record, value, error: undefined, stale: false }
        lastGood.value.set(id, value)
      }
      dirty.delete(id)
    }
    cells.value = next
    dirtyCells.value = dirty
    lastRecalculated.value = [...ids]
    if (failures.size) {
      recalcState.value = 'failed'
      status.value = `重算 ${failures.size} 处失败，已保留上次有效值`
    }
  }

  async function runRecalcLoop() {
    if (recalcLoopRunning) return
    recalcLoopRunning = true
    while (true) {
      const ids = new Set(dirtyCells.value)
      if (ids.size === 0) break
      const gen = recalcGeneration.value
      recalcState.value = 'running'
      status.value = `重算中（第 ${gen} 批）…`
      // 模拟公式链耗时：受影响单元格越多，链越长
      await delay(Math.min(30 + ids.size * 10, 450))
      if (gen !== recalcGeneration.value) continue // 在算旧批次作废
      let evaluated = evaluateBatch(ids)
      let retryCount = 0
      while (evaluated.failures.size > 0 && retryCount < 2) {
        retryCount += 1
        recalcState.value = 'retrying'
        status.value = `重算失败，第 ${retryCount} 次重试…`
        await delay(80 * retryCount)
        if (gen !== recalcGeneration.value) break
        evaluated = evaluateBatch(ids)
      }
      if (gen !== recalcGeneration.value) continue
      commitResults(ids, evaluated.results, evaluated.failures)
    }
    recalcLoopRunning = false
    recalcState.value = 'idle'
    if (recalcGeneration.value > 0) status.value = '重算完成，受影响公式已更新'
  }

  // ---- 跨标签页同步 ----

  let channel: BroadcastChannel | null = null
  try {
    channel = new BroadcastChannel(CHANNEL_NAME)
    channel.onmessage = (event) => {
      const data = event.data as { type?: string; op?: CellOp } | undefined
      if (data?.type === 'op' && data.op) ingestRemoteOp(data.op)
    }
  } catch {
    channel = null
  }

  function postToChannel(message: { type: string; op?: CellOp; sessionId?: string; vv?: VersionVector }) {
    try {
      channel?.postMessage(message)
    } catch {
      /* 通道不可用时忽略 */
    }
  }

  function ingestRemoteOp(op: CellOp) {
    if (op.sessionId === sessionId.value) return
    const res = applyOp(heads.value, vv.value, op)
    if (!res.outcome.applied) return
    heads.value = res.heads
    vv.value = res.vv
    conflicts.value = conflictsOf(heads.value)
    opLog.value = [...opLog.value, op].sort((a, b) => a.timestamp - b.timestamp || a.opId.localeCompare(b.opId))
    syncHeadToCell(op.cellId)
    scheduleRecalc([op.cellId])
  }

  /** storage 事件兜底（BroadcastChannel 不可用时仍可合并其他标签页的写入） */
  function remergeFromStorage() {
    const allOps = loadAllSessionOps()
    const { heads: h, vv: v } = replayOps(allOps)
    if (vvEqual(v, vv.value)) {
      opLog.value = allOps
      return
    }
    heads.value = h
    vv.value = v
    conflicts.value = conflictsOf(h)
    opLog.value = allOps
    const next = { ...cells.value }
    for (const [id, versions] of h) {
      const display = displayVersion(versions)
      const record = next[id]
      if (record?.raw !== display.raw || versions.length > 1) {
        next[id] = {
          ...record,
          raw: display.raw,
          value: display.raw.startsWith('=') ? null : literalValue(display.raw),
          error: undefined,
          stale: false,
          conflict: versions.length > 1,
        }
      }
    }
    cells.value = next
    persistSessionOps()
    scheduleRecalc(allOps.map((o) => o.cellId))
  }

  window.addEventListener('storage', (event) => {
    if (event.key?.startsWith('gridformula-session:')) remergeFromStorage()
  })

  // ---- 恢复 / 回放 ----

  /** 恢复后从最后完整操作继续；重复回放不追加（opId 去重，幂等） */
  function replayAll() {
    const allOps = loadAllSessionOps()
    const before = opLog.value.length
    const { heads: h, vv: v } = replayOps(allOps)
    heads.value = h
    vv.value = v
    conflicts.value = conflictsOf(h)
    opLog.value = allOps
    rebuildAllRaw()
    persistSessionOps()
    scheduleRecalc(allOps.map((o) => o.cellId))
    const after = opLog.value.length
    status.value = `回放完成：${after} 条操作（回放前 ${before} 条）；重复回放不追加`
  }

  function openSessionTab() {
    window.open(window.location.href, '_blank')
  }

  function toggleRevisionPanel() {
    revisionPanelOpen.value = !revisionPanelOpen.value
  }

  function exportCsv() {
    const lines: string[] = []
    for (let row = 0; row < Math.min(rows, 80); row += 1) {
      const values: string[] = []
      let hasData = false
      for (let col = 0; col < cols; col += 1) {
        const record = getRecord(row, col)
        if (record?.raw) hasData = true
        values.push(`"${displayValue(record?.value ?? '').replace(/"/g, '""')}"`)
      }
      if (hasData || row < 15) lines.push(values.join(','))
    }
    const blob = new Blob([`﻿${lines.join('\n')}`], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = '季度销售公式表（合并当前版本）.csv'
    anchor.click()
    URL.revokeObjectURL(url)
    status.value = 'CSV 已导出（来自合并后的当前版本）'
  }

  function reset() {
    clearAllSessionOps()
    heads.value = new Map()
    vv.value = {}
    conflicts.value = []
    opLog.value = []
    undoStack.value = []
    redoStack.value = []
    cells.value = createStarterCells()
    lastGood.value = new Map()
    dirtyCells.value = new Set()
    baseVV.value = {}
    persistSessionOps()
    postToChannel({ type: 'reset' })
    scheduleRecalc(new Set(Object.keys(cells.value)))
    status.value = '已重置工作簿与修订记录'
  }

  function init() {
    const allOps = loadAllSessionOps()
    const { heads: h, vv: v } = replayOps(allOps)
    heads.value = h
    vv.value = v
    conflicts.value = conflictsOf(h)
    opLog.value = allOps
    rebuildAllRaw()
    let sid = sessionStorage.getItem('gridformula-session')
    if (!sid) {
      sid = createSessionId()
      sessionStorage.setItem('gridformula-session', sid)
    }
    sessionId.value = sid
    baseVV.value = cloneVV(v)
    persistSessionOps()
    postToChannel({ type: 'hello', sessionId: sid, vv: v })
    scheduleRecalc(allOps.map((o) => o.cellId))
  }

  init()

  return {
    rows,
    cols,
    cells,
    active,
    selection,
    activeRaw,
    activeValue,
    freezeRows,
    freezeCols,
    lastRecalculated,
    canUndo,
    canRedo,
    status,
    // 修订
    sessionId,
    baseVV,
    vv,
    heads,
    conflicts,
    opLog,
    localSeq,
    recalcGeneration,
    recalcState,
    dirtyCount,
    revisionPanelOpen,
    idFor,
    getRaw,
    getRecord,
    getCellFlags,
    setRaw,
    setManyRaw,
    setActive,
    setSelectionEnd,
    selectedMatrix,
    selectedText,
    pasteText,
    clearSelection,
    undo,
    redo,
    selectVersion,
    isSelected,
    exportCsv,
    reset,
    replayAll,
    openSessionTab,
    toggleRevisionPanel,
  }
})
