import type { CellConflict, CellOp, CellVersion, SessionId, VersionVector } from '../types/revision'

/** 生成一个会话号（标签页身份） */
export function createSessionId(): SessionId {
  const rand = Math.random().toString(36).slice(2, 10)
  const time = Date.now().toString(36).slice(-4)
  return `s-${rand}${time}`
}

export function emptyVV(): VersionVector {
  return {}
}

export function cloneVV(vv: VersionVector): VersionVector {
  return { ...vv }
}

/** 合并两个版本向量：逐会话取最大操作号 */
export function mergeVV(a: VersionVector, b: VersionVector): VersionVector {
  const out: VersionVector = { ...a }
  for (const [k, v] of Object.entries(b)) {
    if (typeof v === 'number') out[k] = Math.max(out[k] ?? 0, v)
  }
  return out
}

export function vvHas(vv: VersionVector, sessionId: SessionId, seq: number): boolean {
  return (vv[sessionId] ?? 0) >= seq
}

export function vvEqual(a: VersionVector, b: VersionVector): boolean {
  const ak = Object.keys(a)
  const bk = Object.keys(b)
  if (ak.length !== bk.length) return false
  return ak.every((k) => a[k] === b[k])
}

export function makeOp(
  sessionId: SessionId,
  seq: number,
  cellId: string,
  raw: string,
  base: VersionVector,
  timestamp = Date.now(),
): CellOp {
  return { opId: `${sessionId}:${seq}`, sessionId, seq, cellId, raw, base: cloneVV(base), timestamp }
}

function toVersion(op: CellOp): CellVersion {
  return {
    opId: op.opId,
    sessionId: op.sessionId,
    seq: op.seq,
    raw: op.raw,
    timestamp: op.timestamp,
    base: cloneVV(op.base),
  }
}

export interface ApplyOutcome {
  applied: boolean
  conflicted: boolean
  /** 操作已被某个更晚版本见过（因果过期），无需应用 */
  superseded: boolean
}

/**
 * 把一个操作应用到「每格并发版本集」上。
 * - 幂等：opId 已在版本向量中则跳过。
 * - 因果过期：若某现有版本的 base 已包含本操作，则本操作过时。
 * - 覆盖：移除本操作 base 已见过的版本（被本操作取代）。
 * - 并发：剩余版本与本操作互不相见 → 同格多版冲突。
 */
export function applyOp(
  heads: Map<string, CellVersion[]>,
  vv: VersionVector,
  op: CellOp,
): { heads: Map<string, CellVersion[]>; vv: VersionVector; outcome: ApplyOutcome } {
  if (vvHas(vv, op.sessionId, op.seq)) {
    return { heads, vv, outcome: { applied: false, conflicted: false, superseded: false } }
  }
  const nextVV = mergeVV(vv, { [op.sessionId]: op.seq })
  const existing = heads.get(op.cellId) ?? []
  const superseded = existing.some((v) => vvHas(v.base, op.sessionId, op.seq))
  if (superseded) {
    return { heads, vv: nextVV, outcome: { applied: false, conflicted: false, superseded: true } }
  }
  const kept = existing.filter((v) => !vvHas(op.base, v.sessionId, v.seq))
  const nextVersions = [...kept, toVersion(op)].sort(
    (a, b) => a.timestamp - b.timestamp || a.opId.localeCompare(b.opId),
  )
  const nextHeads = new Map(heads)
  nextHeads.set(op.cellId, nextVersions)
  return {
    heads: nextHeads,
    vv: nextVV,
    outcome: { applied: true, conflicted: nextVersions.length > 1, superseded: false },
  }
}

/** 重放全部操作重建状态（幂等，结果与到达顺序无关） */
export function replayOps(ops: CellOp[]): { heads: Map<string, CellVersion[]>; vv: VersionVector } {
  const sorted = [...ops].sort((a, b) => a.timestamp - b.timestamp || a.opId.localeCompare(b.opId))
  let heads = new Map<string, CellVersion[]>()
  let vv: VersionVector = {}
  for (const op of sorted) {
    const res = applyOp(heads, vv, op)
    heads = res.heads
    vv = res.vv
  }
  return { heads, vv }
}

/** 按 opId 去重并排序（重复回放不追加） */
export function dedupeOps(ops: CellOp[]): CellOp[] {
  const seen = new Set<string>()
  const out: CellOp[] = []
  for (const op of ops) {
    if (seen.has(op.opId)) continue
    seen.add(op.opId)
    out.push(op)
  }
  return out.sort((a, b) => a.timestamp - b.timestamp || a.opId.localeCompare(b.opId))
}

export function conflictsOf(heads: Map<string, CellVersion[]>): CellConflict[] {
  const out: CellConflict[] = []
  for (const [cellId, versions] of heads) {
    if (versions.length > 1) {
      out.push({
        cellId,
        versions: [...versions].sort((a, b) => a.timestamp - b.timestamp || a.opId.localeCompare(b.opId)),
      })
    }
  }
  return out.sort((a, b) => a.cellId.localeCompare(b.cellId))
}

/** 冲突时用于展示的版本：取时间戳最新的一版 */
export function displayVersion(versions: CellVersion[]): CellVersion {
  return versions.reduce((a, b) => (b.timestamp > a.timestamp ? b : a))
}

// ---- 持久化（按会话分键，避免读-改-写竞争）----
const LOG_PREFIX = 'gridformula-session:'

export function sessionStorageKey(sessionId: string): string {
  return `${LOG_PREFIX}${sessionId}`
}

export function saveSessionOps(sessionId: string, ops: CellOp[]): void {
  try {
    localStorage.setItem(sessionStorageKey(sessionId), JSON.stringify(ops))
  } catch {
    /* 存储不可用或已满时忽略 */
  }
}

export function loadAllSessionOps(): CellOp[] {
  const ops: CellOp[] = []
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)
      if (!key || !key.startsWith(LOG_PREFIX)) continue
      const raw = localStorage.getItem(key)
      if (!raw) continue
      const parsed = JSON.parse(raw) as CellOp[]
      if (Array.isArray(parsed)) ops.push(...parsed)
    }
  } catch {
    /* 忽略损坏的会话日志 */
  }
  return dedupeOps(ops)
}

export function clearAllSessionOps(): void {
  try {
    const keys: string[] = []
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)
      if (key?.startsWith(LOG_PREFIX)) keys.push(key)
    }
    keys.forEach((key) => localStorage.removeItem(key))
  } catch {
    /* ignore */
  }
}
