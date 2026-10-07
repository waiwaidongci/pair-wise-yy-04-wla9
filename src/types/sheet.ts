export type CellValue = string | number | boolean | null

export interface CellRecord {
  raw: string
  value: CellValue
  error?: string
  /** 重算失败后保留的上次有效值（公式链暂不可用） */
  stale?: boolean
  /** 同格多版待选 */
  conflict?: boolean
}

export interface CellCoord {
  row: number
  col: number
}

export interface CellRange {
  start: CellCoord
  end: CellCoord
}

export interface FormulaAst {
  type: 'number' | 'string' | 'boolean' | 'reference' | 'range' | 'binary' | 'unary' | 'function'
  value?: string | number | boolean
  left?: FormulaAst
  right?: FormulaAst
  operator?: string
  name?: string
  args?: FormulaAst[]
}

export type CellMap = Record<string, CellRecord>
