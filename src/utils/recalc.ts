import type { CellMap, CellValue } from '../types/sheet'
import { expandRange, literalValue } from './cells'
import { FormulaError, evaluateAst, parseFormula } from './formula'

/** 批次执行期间工作簿又被修改：本批次已过期，结果必须作废 */
export class StaleBatchError extends Error {
  constructor() {
    super('stale-recalc-batch')
  }
}

export interface RecalcOutcome {
  value: CellValue
  error?: string
}

/** 每求值多少个单元格让出一次事件循环，长公式链因此可被新编辑打断 */
const YIELD_EVERY = 25

/**
 * 对失效单元格集合做增量求值。
 * - cells 为批次开始时的工作簿快照，批次内读到的是一致视图；
 * - isStale 返回 true 时抛出 StaleBatchError，调用方丢弃整批结果；
 * - 单个单元格的公式错误（#DIV/0! 等）只记录到该格，不中断批次。
 */
export async function evaluateTargets(
  cells: CellMap,
  targets: Set<string>,
  isStale: () => boolean,
): Promise<Map<string, RecalcOutcome>> {
  const resolved = new Map<string, CellValue>()
  const cycleMembers = new Set<string>()
  const outcomes = new Map<string, RecalcOutcome>()

  const resolve = (id: string, stack: string[]): CellValue => {
    if (resolved.has(id)) return resolved.get(id) ?? null
    if (stack.includes(id)) {
      stack.forEach((item) => cycleMembers.add(item))
      throw new FormulaError('#CYCLE!')
    }
    const record = cells[id]
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
        return expandRange(start, end).map((cell) => resolve(cell, nextStack))
      },
    ) as CellValue
    resolved.set(id, value)
    return value
  }

  let sinceYield = 0
  for (const id of targets) {
    if (isStale()) throw new StaleBatchError()
    try {
      outcomes.set(id, { value: resolve(id, []) })
    } catch (error) {
      const code = error instanceof FormulaError ? error.code : '#ERROR!'
      outcomes.set(id, { value: null, error: cycleMembers.has(id) ? '#CYCLE!' : code })
    }
    sinceYield += 1
    if (sinceYield >= YIELD_EVERY) {
      sinceYield = 0
      await new Promise<void>((done) => setTimeout(done, 0))
    }
  }
  return outcomes
}
