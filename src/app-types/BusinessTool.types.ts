import type { WorkFile } from "./WorkSource.types";

/** A planned cash movement shown in a `movements` table; `index` is the 1-based position in the tool's original plan list. */
export type PlannedMovement = { index: number; direction: "in" | "out"; description: string; party: string; amount: string };
/** Edits a `movements` table submits, serialized as JSON into `values[key]`: changed amounts (0 = not executed) and added transactions. */
export type MovementEdits = { changes: { index: number; amount: string; account?: string }[]; add: { direction: "in" | "out"; description: string; party: string; amount: string; account?: string }[] };
/**
 * `multiple` lets a file field take several files (e.g. one bank statement per account). `rows` seeds a `movements` table.
 * `confirm` turns a text field into a one-click acknowledgement: the card submits exactly this string instead of asking the user to type it.
 */
export type BusinessField = { key: string; label: string; type: "file" | "date" | "text" | "number" | "movements" | "select"; options?: { value: string; label: string }[]; required: boolean; multiple?: boolean; rows?: PlannedMovement[]; confirm?: string;
  /** Presents an account-to-cell form while keeping the existing serialized text input contract. */
  accountRows?: { key: string; name: string; currency: string; balance: string; maturity?: string }[];
  cashRows?: { key: string; name: string; currency: string; opening: string; balance: string }[];
  movementAccounts?: { value: string; label: string }[];
  /** Only the person can fill this (e.g. the final approval button); a chat message never sets it. */
  manualOnly?: boolean;
};
export type BusinessInput = { values: Record<string, string>; files: Record<string, WorkFile[]> };
/**
 * What looking through the connected folders found for each file field, shown on the first input card.
 * `found`: exactly one file fits and is prefilled. `suggested`: one of several candidates is prefilled with a reason.
 * `choose`: several candidates, none prefilled. `none`: nothing fits. Prefilled files are still only a proposal.
 */
export type FileSearch = { connected: boolean; problems: string[]; fields: Record<string, { status: "found" | "suggested" | "choose" | "none"; candidates: WorkFile[]; reason?: string }> };
export type BusinessAction = {
  id: string; type: "business_tool"; title: string; question: string;
  fields: BusinessField[]; input: BusinessInput; lockedKeys?: string[];
  /** Files come only from the file picker and are not remembered as connected sources. */
  uploadOnly?: boolean;
  /** Present while the source files are still open and the tool can look for them in connected folders. */
  fileSearch?: FileSearch;
  revisionMode?: boolean;
  /** The tool takes its answers from the chat composer (text + attached files); the card only shows quick replies and the current files. */
  conversational?: boolean;
};
export type BusinessArtifact = { id: string; runId: string; name: string; toolId: string; version: string; revision?: number; preview?: boolean; baseArtifactId?: string; changes?: string[] };
export interface BusinessToolAPI {
  submitBusinessInput(runId: string, actionId: string, input: BusinessInput): Promise<void>;
  /** Looks through the connected folders again (after connecting one or changing a date) and reopens the card with the result. */
  findBusinessSources(runId: string, actionId: string, input: BusinessInput): Promise<void>;
  listBusinessArtifacts(threadId: string): Promise<BusinessArtifact[]>;
  openBusinessArtifact(id: string): Promise<void>;
  saveBusinessArtifact(id: string): Promise<boolean>;
  previewBusinessArtifact(id: string): Promise<string>;
}
/** Chat text sent by the "edit previous result" button: reopens the form instead of re-running with this text as a revision. */
export const REVISE_REQUEST_TEXT = "이전 엑셀 결과를 수정하고 싶어. 추가 요청을 입력할게.";
