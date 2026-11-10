/** Character limits bound serialized JS strings; byte limits bound files. */
export const EXCEL_LIMITS = {
  files: 10, fileBytes: 5 * 1024 * 1024, inputRows: 20000, inputChars: 8 * 1024 * 1024,
  tableRows: 5000, chartRows: 20000, categoricalChartRows: 500,
  resultChars: 4 * 1024 * 1024, analysisChars: 6 * 1024 * 1024,
  codeChars: 30000, responseChars: 60000, outputTokens: 10000,
  calculationMs: 5000, workerMs: 30000, submissionMs: 15 * 60 * 1000,
  turns: 24, inspections: 12, executions: 4, repairs: 2, inspectRows: 80, profileChars: 20000, contextChars: 200000,
} as const;

export type ExcelErrorCode = "LIMIT" | "UNSUPPORTED" | "CONTRACT" | "MODEL_LENGTH";
export class ExcelError extends Error {
  constructor(readonly code: ExcelErrorCode, message: string) { super(message); this.name = "ExcelError"; }
}
