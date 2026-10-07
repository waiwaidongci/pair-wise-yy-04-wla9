import type { CellMap } from './sheet'

/** 一次编辑操作（修订记录的基本单元） */
export interface EditOp {
  /** 全局唯一 id，幂等键：重复回放不追加 */
  id: string
  /** 会话号：每个标签页一个 */
  sessionId: string
  /** 操作号：会话内单调递增 */
  seq: number
  /** 基线版本：创建操作时本页已应用的日志长度 */
  baseVersion: number
  /** 单元格 id -> 新原始值（空串表示清除） */
  changes: Record<string, string>
  at: number
  kind: 'edit' | 'resolve' | 'reset' | 'undo' | 'redo'
}

/** 冲突中某一方的版本 */
export interface ConflictSide {
  raw: string
  sessionId: string
  opId: string
  at: number
}

/** 同一单元格被双方并发修改时，保留两版待选 */
export interface CellConflict {
  cellId: string
  mine: ConflictSide
  theirs: ConflictSide
}

/** 本地快照：恢复到“最后完整操作”后继续 */
export interface SnapshotFile {
  /** 已完整应用的日志长度（版本号） */
  version: number
  cells: CellMap
  /** 每个单元格最后一次写入的日志下标，用于并发冲突判定 */
  cellOpIndex: Record<string, number>
  conflicts: CellConflict[]
  /** 最近已应用的 op id，回放去重 */
  appliedIds: string[]
  /** 崩溃时仍未完成重算的失效单元格 */
  dirtyIds: string[]
  savedAt: number
}
