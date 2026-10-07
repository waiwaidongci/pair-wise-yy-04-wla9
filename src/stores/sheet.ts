import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { CellCoord, CellMap, CellRange, CellRecord, CellValue } from '../types/sheet'
import type { CellConflict, EditOp } from '../types/revision'
import { cellId, displayValue, literalValue, normalizeRange, rangeContains } from '../utils/cells'
import { formulaDependencies } from '../utils/formula'
import { StaleBatchError, evaluateTargets, type RecalcOutcome } from '../utils/recalc'
import {
  appendOp,
  createSyncListener,
  ensureSessionId,
  notifySync,
  readOps,
  readSnapshot,
  writeSnapshot,
} from '../utils/opLog'

const ROWS = 1000
const COLS = 26
const MAX_RECALC_ATTEMPTS = 2

function createStarterCells(): CellMap {
  const cells: CellMap = {}
  const put = (id: string, raw: string) => {
    const value = raw.startsWith('=') ? null : literalValue(raw)
    cells[id] = { raw, value, lastValidValue: value }
  }
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

/** 格子级撤销记录：只回退本地编辑过的格子，不会冲掉远程合并进来的内容 */
interface UndoEntry {
  before: Record<string, string>
  after: Record<string, string>
  active: CellCoord
  selection: CellRange
}

export const useSheetStore = defineStore('sheet', () => {
  const rows = ROWS
  const cols = COLS

  // ---- 修订记录状态 ----
  const sessionId = ensureSessionId()
  const version = ref(0) // 当前版本 = 已应用的日志长度
  const localSeq = ref(0) // 本会话下一个操作号
  const ops = ref<EditOp[]>([]) // 共享日志镜像（用于修订记录面板）
  const conflicts = ref<CellConflict[]>([])
  const showSyncPanel = ref(false)
  /** 每个单元格最后一次写入的日志下标（非响应式，仅合并判定用） */
  const cellOpIndex = new Map<string, number>()
  /** 已应用的 op id：重复回放不追加 */
  const appliedIds = new Set<string>()

  // ---- 工作簿状态 ----
  const cells = ref<CellMap>({})
  const active = ref<CellCoord>({ row: 1, col: 4 })
  const selection = ref<CellRange>({ start: { row: 1, col: 4 }, end: { row: 1, col: 4 } })
  const freezeRows = ref(1)
  const freezeCols = ref(1)
  const lastRecalculated = ref<string[]>([])
  const history = ref<UndoEntry[]>([])
  const future = ref<UndoEntry[]>([])
  const status = ref('工作簿已加载，公式引擎待命')
  const recalcBusy = ref(false)

  const activeRaw = computed(() => getRaw(active.value.row, active.value.col))
  const activeValue = computed(() => cells.value[cellId(active.value.row, active.value.col)]?.value ?? null)
  const canUndo = computed(() => history.value.length > 0)
  const canRedo = computed(() => future.value.length > 0)
  const sessionShort = computed(() => sessionId.slice(0, 4))
  const conflictIds = computed(() => new Set(conflicts.value.map((item) => item.cellId)))

  function idFor(row: number, col: number) {
    return cellId(row, col)
  }

  function getRaw(row: number, col: number) {
    return cells.value[idFor(row, col)]?.raw ?? ''
  }

  function getRecord(row: number, col: number): CellRecord | undefined {
    return cells.value[idFor(row, col)]
  }

  function isConflicted(row: number, col: number) {
    return conflictIds.value.has(idFor(row, col))
  }

  // ---- 依赖图：任一格改动只让受影响公式失效 ----
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

  // ---- 异步批量重算：旧批次作废、失败重试、保留上次有效值 ----
  const dirty = new Set<string>()
  let epoch = 0
  let recalcRunning = false

  function invalidate(ids: Iterable<string>) {
    let added = false
    for (const id of ids) {
      dirty.add(id)
      added = true
    }
    if (!added) return
    epoch += 1 // 任何新失效都让在算的旧批次作废
    void runRecalc()
    schedulePersist()
  }

  async function runRecalc() {
    if (recalcRunning) return
    recalcRunning = true
    recalcBusy.value = true
    try {
      while (dirty.size) {
        const targets = new Set(dirty)
        dirty.clear()
        const batchEpoch = epoch
        const snapshotCells = { ...cells.value }
        const requeue = () => targets.forEach((id) => dirty.add(id))
        let attempt = 0
        for (;;) {
          try {
            const results = await evaluateTargets(snapshotCells, targets, () => batchEpoch !== epoch)
            if (batchEpoch !== epoch) {
              requeue() // 期间又有改动：本批结果作废，重新排队
            } else {
              commitRecalcResults(results)
            }
            break
          } catch (error) {
            if (error instanceof StaleBatchError) {
              requeue()
              break
            }
            attempt += 1
            if (attempt > MAX_RECALC_ATTEMPTS) {
              keepLastValidValues(targets)
              status.value = `重算失败已重试 ${MAX_RECALC_ATTEMPTS} 次，保留上次有效值`
              break
            }
            await new Promise((done) => setTimeout(done, 150 * attempt))
          }
        }
      }
    } finally {
      recalcRunning = false
      recalcBusy.value = false
      schedulePersist()
    }
  }

  function commitRecalcResults(results: Map<string, RecalcOutcome>) {
    const changed: string[] = []
    results.forEach((outcome, id) => {
      const record = cells.value[id]
      if (!record) return
      if (outcome.error !== undefined) {
        // 单格求值失败：保留上次有效值，仅标记错误
        cells.value[id] = { ...record, value: record.lastValidValue ?? null, error: outcome.error }
      } else {
        cells.value[id] = { ...record, value: outcome.value, lastValidValue: outcome.value, error: undefined }
      }
      changed.push(id)
    })
    lastRecalculated.value = changed
    status.value = `已重算 ${changed.length} 个受影响单元格`
  }

  function keepLastValidValues(ids: Iterable<string>) {
    for (const id of ids) {
      const record = cells.value[id]
      if (!record) continue
      cells.value[id] = { ...record, value: record.lastValidValue ?? record.value, error: record.error ?? '#CALC!' }
    }
  }

  // ---- 持久化：快照 + 最后完整操作版本 ----
  let persistTimer: number | undefined
  function schedulePersist() {
    window.clearTimeout(persistTimer)
    persistTimer = window.setTimeout(persistNow, 200)
  }

  function persistNow() {
    writeSnapshot({
      version: version.value,
      cells: cells.value,
      cellOpIndex: Object.fromEntries(cellOpIndex),
      conflicts: conflicts.value,
      appliedIds: [...appliedIds].slice(-500),
      dirtyIds: [...dirty],
      savedAt: Date.now(),
    })
  }

  // ---- 合并：不同单元格直接合并，同格并发留两版待选 ----
  function removeConflict(id: string) {
    if (conflicts.value.some((item) => item.cellId === id)) {
      conflicts.value = conflicts.value.filter((item) => item.cellId !== id)
    }
  }

  function recordConflict(id: string, mineRaw: string, mineOpId: string, theirsRaw: string, theirsOp: EditOp) {
    const next: CellConflict = {
      cellId: id,
      mine: { raw: mineRaw, sessionId, opId: mineOpId, at: Date.now() },
      theirs: { raw: theirsRaw, sessionId: theirsOp.sessionId, opId: theirsOp.id, at: theirsOp.at },
    }
    conflicts.value = conflicts.value.some((item) => item.cellId === id)
      ? conflicts.value.map((item) => (item.cellId === id ? next : item))
      : [...conflicts.value, next]
  }

  function writeCell(id: string, raw: string, opIndex: number) {
    const previous = cells.value[id]
    if (raw.startsWith('=')) {
      // 公式失效期间先展示上次有效值，重算提交后更新
      cells.value[id] = { raw, value: previous?.lastValidValue ?? null, lastValidValue: previous?.lastValidValue }
    } else {
      const value = literalValue(raw)
      cells.value[id] = { raw, value, lastValidValue: value }
    }
    cellOpIndex.set(id, opIndex)
    removeConflict(id)
  }

  function applyRemoteOp(op: EditOp, index: number) {
    const written: string[] = []
    Object.entries(op.changes).forEach(([id, raw]) => {
      const lastIndex = cellOpIndex.get(id) ?? -1
      if (lastIndex >= op.baseVersion) {
        // 同一单元格在对方基线之后又被本地改过：并发冲突，两版都保留待选
        recordConflict(id, cells.value[id]?.raw ?? '', ops.value[lastIndex]?.id ?? '', raw, op)
        return
      }
      // 不同单元格（或对方已见过本地修改）：直接合并
      if ((cells.value[id]?.raw ?? '') !== raw) {
        writeCell(id, raw, index)
        written.push(id)
      } else {
        cellOpIndex.set(id, index)
        removeConflict(id)
      }
    })
    appliedIds.add(op.id)
    if (written.length) invalidate(affectedCells(written))
  }

  /** 拉取共享日志，从当前版本继续回放；已应用的 op 直接跳过 */
  function pull() {
    const log = readOps()
    ops.value = log
    let merged = 0
    for (let index = version.value; index < log.length; index += 1) {
      const op = log[index]
      if (appliedIds.has(op.id)) {
        version.value = index + 1
        continue
      }
      if (op.sessionId === sessionId) {
        // 重启后回放本会话的操作：直接确认，不做冲突判定
        Object.entries(op.changes).forEach(([id, raw]) => writeCell(id, raw, index))
        appliedIds.add(op.id)
        invalidate(affectedCells(Object.keys(op.changes)))
      } else {
        applyRemoteOp(op, index)
        merged += 1
      }
      version.value = index + 1
    }
    if (merged) status.value = `已合并 ${merged} 个远程操作（v${version.value}）`
    schedulePersist()
  }

  // ---- 本地编辑：接入修订记录 ----
  function commitLocal(changes: Record<string, string>, kind: EditOp['kind'] = 'edit', recordUndo = true) {
    const force = kind === 'resolve'
    const entries = Object.entries(changes).filter(([id, raw]) => force || (cells.value[id]?.raw ?? '') !== raw)
    if (!entries.length) return
    // 基线版本 = 编辑发生时所见的版本；不在提交前偷偷合并，否则“后保存”会变成知情的串行覆盖
    const before: Record<string, string> = {}
    entries.forEach(([id]) => {
      before[id] = cells.value[id]?.raw ?? ''
    })
    const op: EditOp = {
      id: typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${sessionId}-${localSeq.value + 1}-${Date.now()}`,
      sessionId,
      seq: localSeq.value + 1,
      baseVersion: version.value,
      changes: Object.fromEntries(entries),
      at: Date.now(),
      kind,
    }
    let index: number
    try {
      index = appendOp(op, pull)
    } catch {
      status.value = '操作写入冲突，请重试'
      return
    }
    localSeq.value = op.seq
    if (recordUndo) {
      history.value.push({
        before,
        after: Object.fromEntries(entries),
        active: { ...active.value },
        selection: { start: { ...selection.value.start }, end: { ...selection.value.end } },
      })
      if (history.value.length > 80) history.value.shift()
      future.value = []
    }
    appliedIds.add(op.id)
    const changedIds: string[] = []
    entries.forEach(([id, raw]) => {
      const lastIndex = cellOpIndex.get(id) ?? -1
      if (lastIndex >= op.baseVersion) {
        // 写入竞争期间远程改了同格：本地同样留两版，我的新值照常生效
        const remoteOp = ops.value[lastIndex] ?? readOps()[lastIndex]
        if (remoteOp) recordConflict(id, raw, op.id, cells.value[id]?.raw ?? '', remoteOp)
      }
      writeCell(id, raw, index)
      changedIds.push(id)
    })
    ops.value = readOps()
    pull() // 推进版本，并合并在写入竞争期间到达的操作
    invalidate(affectedCells(changedIds))
    notifySync()
    schedulePersist()
  }

  function setRaw(row: number, col: number, raw: string) {
    commitLocal({ [idFor(row, col)]: raw })
  }

  function setManyRaw(start: CellCoord, matrix: string[][]) {
    const changes: Record<string, string> = {}
    matrix.forEach((rowValues, rowOffset) => {
      rowValues.forEach((raw, colOffset) => {
        const row = start.row + rowOffset
        const col = start.col + colOffset
        if (row >= rows || col >= cols) return
        changes[idFor(row, col)] = raw
      })
    })
    commitLocal(changes)
  }

  /** 冲突二选一：无论选哪边都产生新操作，双方随之收敛 */
  function resolveConflict(id: string, choice: 'mine' | 'theirs') {
    const conflict = conflicts.value.find((item) => item.cellId === id)
    if (!conflict) return
    const raw = choice === 'theirs' ? conflict.theirs.raw : conflict.mine.raw
    conflicts.value = conflicts.value.filter((item) => item.cellId !== id)
    commitLocal({ [id]: raw }, 'resolve')
    status.value = `已采用${choice === 'mine' ? '本页' : '对方'}版本：${id}`
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
    const entry = history.value.pop()
    if (!entry) return
    future.value.push(entry)
    active.value = { ...entry.active }
    selection.value = { start: { ...entry.selection.start }, end: { ...entry.selection.end } }
    commitLocal(entry.before, 'undo', false)
    status.value = '已撤销上一步编辑'
  }

  function redo() {
    const entry = future.value.pop()
    if (!entry) return
    history.value.push(entry)
    commitLocal(entry.after, 'redo', false)
    status.value = '已恢复编辑'
  }

  function isSelected(row: number, col: number) {
    return rangeContains(selection.value, row, col)
  }

  /** 导出合并后的当前版本 */
  function exportCsv() {
    pull() // 导出前先合并，保证是当前版本
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
    const blob = new Blob([`\uFEFF${lines.join('\n')}`], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = '季度销售公式表.csv'
    anchor.click()
    URL.revokeObjectURL(url)
    status.value = `CSV 已导出（合并后版本 v${version.value}）`
  }

  function reset() {
    const fresh = createStarterCells()
    const changes: Record<string, string> = {}
    const ids = new Set([...Object.keys(cells.value), ...Object.keys(fresh)])
    ids.forEach((id) => {
      const next = fresh[id]?.raw ?? ''
      if ((cells.value[id]?.raw ?? '') !== next) changes[id] = next
    })
    commitLocal(changes, 'reset')
    status.value = '已恢复示例工作簿'
  }

  // ---- 启动：从最后完整操作恢复，回放新操作（幂等），注册跨标签页同步 ----
  const snapshot = readSnapshot()
  if (snapshot) {
    cells.value = snapshot.cells
    version.value = snapshot.version
    conflicts.value = snapshot.conflicts ?? []
    Object.entries(snapshot.cellOpIndex ?? {}).forEach(([id, index]) => cellOpIndex.set(id, index))
    ;(snapshot.appliedIds ?? []).forEach((id) => appliedIds.add(id))
    ;(snapshot.dirtyIds ?? []).forEach((id) => dirty.add(id))
    status.value = `已从 v${snapshot.version} 恢复，继续最后完整操作`
  } else {
    cells.value = createStarterCells()
  }
  const log = readOps()
  localSeq.value = log.filter((op) => op.sessionId === sessionId).reduce((max, op) => Math.max(max, op.seq), 0)
  pull()
  if (dirty.size) {
    invalidate([...dirty])
  } else if (!snapshot) {
    invalidate(Object.entries(cells.value).filter(([, cell]) => cell.raw.startsWith('=')).map(([id]) => id))
  }
  createSyncListener(() => pull())

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
    sessionId,
    sessionShort,
    version,
    localSeq,
    ops,
    conflicts,
    showSyncPanel,
    recalcBusy,
    idFor,
    getRaw,
    getRecord,
    isConflicted,
    setRaw,
    setManyRaw,
    resolveConflict,
    setActive,
    setSelectionEnd,
    selectedMatrix,
    selectedText,
    pasteText,
    clearSelection,
    undo,
    redo,
    isSelected,
    exportCsv,
    reset,
  }
})
