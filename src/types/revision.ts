export type SessionId = string

/** 版本向量：每个会话已见到的最大操作号 */
export type VersionVector = Record<SessionId, number>

/** 一次编辑操作（只增日志的最小单元） */
export interface CellOp {
  /** 全局唯一：`${sessionId}:${seq}` */
  opId: string
  sessionId: SessionId
  /** 本会话内单调递增的操作号 */
  seq: number
  cellId: string
  raw: string
  /** 创建时所依据的版本向量（因果上下文） */
  base: VersionVector
  timestamp: number
}

/** 某单元格的一个并发版本（冲突时同格会有多个） */
export interface CellVersion {
  opId: string
  sessionId: SessionId
  seq: number
  raw: string
  timestamp: number
  base: VersionVector
}

/** 同格两边都改过且互不相见 → 两版待选 */
export interface CellConflict {
  cellId: string
  versions: CellVersion[]
}
