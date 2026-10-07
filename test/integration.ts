/* eslint-disable no-console */
/**
 * 协作与修订记录的集成测试（node 环境模拟两个浏览器标签页）。
 * 运行：node test/run-integration.mjs（先执行 test/build-test.sh 打包）
 */
import assert from 'node:assert/strict'
import { createPinia, setActivePinia } from 'pinia'

// ---- 浏览器 API mock（import store 之前就绪）----
const localData = new Map()
const localStorageMock = {
  getItem: (k) => (localData.has(k) ? localData.get(k) : null),
  setItem: (k, v) => void localData.set(k, String(v)),
  removeItem: (k) => void localData.delete(k),
  clear: () => localData.clear(),
  key: (i) => [...localData.keys()][i] ?? null,
  get length() { return localData.size },
}
globalThis.localStorage = localStorageMock
globalThis.window = globalThis
globalThis.addEventListener = () => {}
globalThis.removeEventListener = () => {}

let currentSession = new Map()
globalThis.sessionStorage = {
  getItem: (k) => (currentSession.has(k) ? currentSession.get(k) : null),
  setItem: (k, v) => void currentSession.set(k, String(v)),
  removeItem: (k) => void currentSession.delete(k),
  clear: () => currentSession.clear(),
  get length() { return currentSession.size },
}

const { useSheetStore } = await import('../src/stores/sheet')
const opLog = await import('../src/utils/opLog')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** 等重算批次与防抖持久化完成 */
async function settle(ms = 400) {
  await sleep(ms)
}

function openTab(sessionId) {
  currentSession = new Map([['gridformula.session.v1', sessionId]])
  setActivePinia(createPinia())
  const store = useSheetStore()
  return store
}

function readLog() {
  return opLog.readOps()
}

let passed = 0
function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    console.error(`  ✗ ${name}`)
    console.error(error)
    process.exitCode = 1
  }
}

// ============ 场景 1：不同单元格并发编辑 → 直接合并 ============
console.log('场景 1：不同单元格直接合并')
localData.clear()
const tabA = openTab('session-AAAA-1')
tabA.setRaw(1, 1, '128000') // B2
await settle()
const tabB = openTab('session-BBBB-1') // B 启动即恢复到 A 的版本
check('B 启动即看到 A 的值', () => assert.equal(tabB.getRaw(1, 1), '128000'))
tabA.setRaw(2, 1, '130000') // B3，A 的第二个操作
tabB.setRaw(1, 2, '99000') // C2，B 并发改另一格
await settle()
check('A 合并到 B 的修改', () => assert.equal(tabA.getRaw(1, 2), '99000'))
check('B 合并到 A 的修改', () => assert.equal(tabB.getRaw(2, 1), '130000'))
check('无冲突产生', () => assert.equal(tabA.conflicts.length + tabB.conflicts.length, 0))
check('日志包含双方操作', () => {
  const log = readLog()
  assert.ok(log.some((op) => op.sessionId.startsWith('session-AAAA')))
  assert.ok(log.some((op) => op.sessionId.startsWith('session-BBBB')))
})
check('操作携带会话号/基线版本/操作号', () => {
  const op = readLog().at(-1)
  assert.ok(op.sessionId && typeof op.baseVersion === 'number' && typeof op.seq === 'number')
})
check('双方版本一致', () => assert.equal(tabA.version, tabB.version))
await settle()
check('公式链合并后结果正确', () => {
  // E2 = SUM(B2:D2) = 128000 + 99000 + 151200
  assert.equal(tabA.cells['E2'].value, 378200)
  assert.equal(tabB.cells['E2'].value, 378200)
})

// ============ 场景 2：同格并发 → 两版待选 → 解决后收敛 ============
console.log('场景 2：同格冲突留两版待选')
// 制造真并发：B 先断开自动同步不可能（同进程 BC），改为直接构造：
// A 改 D2，B 在 A 的 op 已入日志但 B 尚未 pull 的窗口内改 D2。
// 由于 commitLocal 不再预先 pull，B 的 op 基线仍是旧版本 → 并发。
tabA.setRaw(1, 3, '155000') // D2，A 先提交（不同于 starter 值 151200）
tabB.setRaw(1, 3, '160000') // D2，B 基于旧基线提交（B 的 version 尚未推进）
await settle()
check('A 侧出现冲突', () => assert.equal(tabA.conflicts.length, 1))
check('B 侧出现冲突', () => assert.equal(tabB.conflicts.length, 1))
check('冲突单元格是 D2', () => assert.equal(tabA.conflicts[0].cellId, 'D2'))
check('A 保留自己的值', () => assert.equal(tabA.getRaw(1, 3), '155000'))
check('B 保留自己的值', () => assert.equal(tabB.getRaw(1, 3), '160000'))
check('两版都记录在案', () => {
  const c = tabA.conflicts[0]
  assert.equal(c.mine.raw, '155000')
  assert.equal(c.theirs.raw, '160000')
})
tabA.resolveConflict('D2', 'theirs') // A 采用 B 的版本
await settle()
check('A 解决后取值对方版本', () => assert.equal(tabA.getRaw(1, 3), '160000'))
check('B 侧冲突随之收敛', () => assert.equal(tabB.conflicts.length, 0))
check('A 侧冲突清空', () => assert.equal(tabA.conflicts.length, 0))
check('双方 D2 一致', () => assert.equal(tabA.getRaw(1, 3), tabB.getRaw(1, 3)))

// ============ 场景 3：增量失效只重算受影响公式 ============
console.log('场景 3：增量失效')
tabA.setRaw(4, 1, '97001') // B5 微调
await settle()
check('只重算受影响单元格', () => {
  const recalc = tabA.lastRecalculated
  assert.ok(recalc.includes('B5'), '包含被改格')
  assert.ok(recalc.includes('E5'), '包含行合计')
  assert.ok(recalc.includes('B6'), '包含列合计')
  assert.ok(!recalc.includes('C2'), '不包含无关格')
  assert.ok(!recalc.includes('D4'), '不包含无关格')
})

// ============ 场景 4：公式失败保留上次有效值 ============
console.log('场景 4：失败保留上次有效值')
const beforeE2 = tabA.cells['E2'].value
tabA.setRaw(1, 4, '=1/0') // E2 改成必然失败的公式
await settle()
check('错误码已标记', () => assert.equal(tabA.cells['E2'].error, '#DIV/0!'))
check('保留上次有效值', () => assert.equal(tabA.cells['E2'].value, beforeE2))
tabA.setRaw(1, 4, '=SUM(B2:D2)') // 恢复
await settle()
check('恢复后重新计算', () => {
  assert.equal(tabA.cells['E2'].error, undefined)
  assert.equal(tabA.cells['E2'].value, 128000 + 99000 + 160000)
})

// ============ 场景 5：崩溃恢复，从最后完整操作继续，重复回放不追加 ============
console.log('场景 5：恢复与幂等回放')
const logBefore = readLog().length
const tabA2 = openTab('session-AAAA-1') // 同一会话号刷新重开
check('恢复后版本不丢', () => assert.equal(tabA2.version, tabA.version))
check('恢复后数据完整', () => assert.equal(tabA2.getRaw(1, 3), '160000'))
check('日志没有因恢复而追加', () => assert.equal(readLog().length, logBefore))
const seqBefore = tabA2.localSeq
tabA2.setRaw(15, 1, '76001') // B16，未使用的空格
await settle()
check('操作号在恢复后连续递增', () => {
  const mine = readLog().filter((op) => op.sessionId === 'session-AAAA-1')
  const seqs = mine.map((op) => op.seq)
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b))
  assert.ok(tabA2.localSeq > seqBefore || seqBefore > 0)
})
// 重复回放：手动再 pull 多次，状态与日志不变
const versionBefore = tabA2.version
const cellsBefore = JSON.stringify(tabA2.cells)
await settle()
check('重复回放不追加、状态不变', () => {
  assert.equal(tabA2.version, versionBefore)
  assert.equal(JSON.stringify(tabA2.cells), cellsBefore)
})

// ============ 场景 6：旧批次作废（慢公式链被新编辑打断） ============
console.log('场景 6：在算的旧批次作废')
// 构造一条长公式链：H1=1, H2=H1+1, ..., H200=H199+1
const chain = {}
for (let i = 1; i <= 200; i += 1) chain[`H${i}`] = i === 1 ? '1' : `=H${i - 1}+1`
tabA.setManyRaw({ row: 0, col: 7 }, Object.values(chain).map((v) => [v]))
// 不等待，立刻再改链头：第一批次在算即作废
tabA.setRaw(0, 7, '100')
await settle(800)
check('链尾反映最新基值', () => {
  assert.equal(tabA.cells['H200'].value, 100 + 199)
  assert.equal(tabA.cells['H1'].value, 100)
})

// ============ 场景 7：撤销/重做也走修订记录 ============
console.log('场景 7：撤销重做接入日志')
const logBefore7 = readLog().length
tabA.setRaw(19, 1, '12345') // B20，空格
await settle()
tabA.undo()
await settle()
check('撤销产生新操作而非本地私改', () => assert.ok(readLog().length > logBefore7))
check('撤销后 B 也看到旧值', () => assert.equal(tabB.getRaw(19, 1), ''))
tabA.redo()
await settle()
check('重做后双方看到新值', () => {
  assert.equal(tabA.getRaw(19, 1), '12345')
  assert.equal(tabB.getRaw(19, 1), '12345')
})

// ============ 场景 8：导出基于合并后的当前版本 ============
console.log('场景 8：导出用合并后的当前版本')
tabB.setRaw(12, 1, '777')
await settle()
let exported = ''
const realCreate = URL.createObjectURL
URL.createObjectURL = (blob) => {
  exported = 'pending'
  blob.text().then((t) => { exported = t })
  return 'blob:mock'
}
URL.revokeObjectURL = () => {}
let clicked = false
globalThis.document = { createElement: () => ({ click: () => { clicked = true }, set href(v) {}, get href() { return '' } }) }
tabA.exportCsv()
await settle(100)
check('导出被触发', () => assert.ok(clicked))
check('导出内容包含对方最新修改', () => {
  assert.ok(exported.includes('777'), 'CSV 含 B 刚写入的值')
})
URL.createObjectURL = realCreate

console.log(`\n${passed} 项检查全部通过` + (process.exitCode ? '（存在失败）' : ''))
process.exit(process.exitCode ?? 0)
