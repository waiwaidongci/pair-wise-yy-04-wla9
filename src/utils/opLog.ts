import type { EditOp, SnapshotFile } from '../types/revision'

const LOG_KEY = 'gridformula.oplog.v1'
const SNAPSHOT_KEY = 'gridformula.snapshot.v1'
const SESSION_KEY = 'gridformula.session.v1'
const CHANNEL_NAME = 'gridformula.sync.v1'

/** 会话号：同一标签页刷新后保持不变，新标签页生成新会话 */
export function ensureSessionId(): string {
  let id = sessionStorage.getItem(SESSION_KEY)
  if (!id) {
    id = typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
    sessionStorage.setItem(SESSION_KEY, id)
  }
  return id
}

export function readOps(): EditOp[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(LOG_KEY) ?? 'null') as { ops?: EditOp[] } | null
    return Array.isArray(parsed?.ops) ? parsed.ops : []
  } catch {
    return []
  }
}

function writeOps(ops: EditOp[]) {
  localStorage.setItem(LOG_KEY, JSON.stringify({ ops }))
}

/**
 * 追加操作到共享日志。两个标签页可能同时读-改-写，
 * 写入后立即重读校验：若自己的 op 被并发写覆盖，则先 resync 合并别人的新 op，再重试。
 * 返回 op 在日志中的下标（即它的版本位置）。
 */
export function appendOp(op: EditOp, resync: () => void): number {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const ops = readOps()
    const index = ops.length
    ops.push(op)
    writeOps(ops)
    if (readOps().some((item) => item.id === op.id)) return index
    resync()
  }
  throw new Error('op-append-conflict')
}

export function readSnapshot(): SnapshotFile | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(SNAPSHOT_KEY) ?? 'null') as SnapshotFile | null
    return parsed && typeof parsed.version === 'number' && parsed.cells ? parsed : null
  } catch {
    return null
  }
}

export function writeSnapshot(snapshot: SnapshotFile) {
  try {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot))
  } catch {
    // 存储配额满时静默失败，不影响内存中的工作状态
  }
}

let sendChannel: BroadcastChannel | null = null

/** 提交 op 后唤醒其他标签页拉取日志 */
export function notifySync() {
  if (typeof BroadcastChannel === 'undefined') return
  if (!sendChannel) sendChannel = new BroadcastChannel(CHANNEL_NAME)
  sendChannel.postMessage({ type: 'ops-appended' })
}

/** 监听其他标签页的提交（BroadcastChannel 为主，storage 事件兜底）。每个调用方持有独立实例。 */
export function createSyncListener(onSync: () => void): () => void {
  const bc = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL_NAME) : null
  const messageHandler = () => onSync()
  bc?.addEventListener('message', messageHandler)
  const storageHandler = (event: StorageEvent) => {
    if (event.key === LOG_KEY) onSync()
  }
  window.addEventListener('storage', storageHandler)
  return () => {
    bc?.removeEventListener('message', messageHandler)
    bc?.close()
    window.removeEventListener('storage', storageHandler)
  }
}
