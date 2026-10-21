import type { WorkFile } from "./WorkSource.types";

/** A planned cash movement shown in a `movements` table; `index` is the 1-based position in the tool's original plan list. */
export type PlannedMovement = { index: number; direction: "in" | "out"; description: string; party: string; amount: string };
/** Edits a `movements` table submits, serialized as JSON into `values[key]`: changed amounts (0 = not executed) and added transactions. */
export type MovementEdits = { changes: { index: number; amount: string }[]; add: { direction: "in" | "out"; description: string; party: string; amount: string }[] };
/**
 * `multiple` lets a file field take several files (e.g. one bank statement per account). `rows` seeds a `movements` table.
 * `confirm` turns a text field into a one-click acknowledgement: the card submits exactly this string instead of asking the user to type it.
 */
export type BusinessField = { key: string; label: string; type: "file" | "date" | "text" | "number" | "movements"; required: boolean; multiple?: boolean; rows?: PlannedMovement[]; confirm?: string };
export type BusinessInput = { values: Record<string, string>; files: Record<string, WorkFile[]> };
export type BusinessAction = {
  id: string; type: "business_tool"; title: string; question: string;
  fields: BusinessField[]; input: BusinessInput; lockedKeys?: string[];
};
export type BusinessArtifact = { id: string; runId: string; name: string; toolId: string; version: string };
export interface BusinessToolAPI {
  submitBusinessInput(runId: string, actionId: string, input: BusinessInput): Promise<void>;
  listBusinessArtifacts(threadId: string): Promise<BusinessArtifact[]>;
  openBusinessArtifact(id: string): Promise<void>;
  saveBusinessArtifact(id: string): Promise<boolean>;
}
