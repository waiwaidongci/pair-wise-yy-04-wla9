export type CellValue = string | number | boolean | null

export interface CellRecord {
  raw: string
  value: CellValue
  /** 最近一次重算成功的值；重算失败时回落到它 */
  lastValidValue?: CellValue
  error?: string
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
