export type WorkSource = { id: string; name: string; displayPath: string; kind: "file" | "folder" };
export type WorkFile = { sourceId: string; relativePath: string; name: string };
export type WorkSelection = { file: WorkFile; fingerprint: string; profileId: string; profileRevision: number };
export type SourceValueType = "text" | "decimal" | "date";
export type SourceMapping = {
  sheet: string;
  headerRow: number;
  firstDataRow: number;
  lastDataRow?: number;
  columns: Array<{ field: string; header: string; type: SourceValueType; required: boolean }>;
  filters: Array<{ field: string; operator: "equals" | "notEquals"; value: string }>;
};
export type SourceProfile = { id: string; name: string; revision: number; mapping: SourceMapping };
export type WorkbookOverview = {
  fingerprint: string;
  sheets: Array<{ name: string; rowCount: number; columnCount: number; hidden: boolean }>;
  sheet: string;
  headers: Array<{ column: number; text: string }>;
  rows: Array<{ row: number; cells: Array<{ address: string; text: string; formula: boolean }> }>;
};
export type ExtractionPreview = {
  fingerprint: string;
  scannedRows: number;
  matchedRows: number;
  excludedRows: number;
  blankRows: number;
  issueCount: number;
  issues: Array<{ row: number; field: string; message: string }>;
  rows: Array<{ row: number; values: Record<string, string | null>; cells: Record<string, string> }>;
};
export interface WorkSourceAPI {
  submitWorkSelection(runId: string, actionId: string, selection: WorkSelection): Promise<void>;
  pickWorkSources(kind: "file" | "folder"): Promise<WorkSource[]>;
  /** Opens the native file dialog, connects the chosen XLSX files and returns only those. */
  pickWorkFiles(multiple: boolean): Promise<WorkFile[]>;
  listWorkSources(): Promise<WorkSource[]>;
  removeWorkSource(id: string): Promise<void>;
  listWorkFiles(sourceId: string): Promise<WorkFile[]>;
  inspectWorkFile(file: WorkFile, sheet?: string, headerRow?: number): Promise<WorkbookOverview>;
  previewSourceMapping(file: WorkFile, fingerprint: string, mapping: SourceMapping): Promise<ExtractionPreview>;
  listSourceProfiles(): Promise<SourceProfile[]>;
  saveSourceProfile(file: WorkFile, fingerprint: string, profile: SourceProfile): Promise<SourceProfile>;
  removeSourceProfile(id: string): Promise<void>;
}
