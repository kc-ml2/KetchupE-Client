import { z } from "zod";
import type { BusinessField, BusinessInput } from "../../src/app-types/BusinessTool.types.ts";
import type { WorkFile } from "../../src/app-types/WorkSource.types.ts";
import type { WorkflowRoute } from "../agent/router.ts";

const MAX_FILES_PER_FIELD = 50;
export const businessInputSchema = z.object({
  values: z.record(z.string(), z.string().max(4000)),
  files: z.record(z.string(), z.array(z.object({ sourceId: z.string().min(1).max(100), relativePath: z.string().max(4096), name: z.string().max(500) }).strict()).max(MAX_FILES_PER_FIELD)),
}).strict();
export type ToolResult =
  | { status: "needs_input"; question: string; fields: BusinessField[]; checkpoint?: Record<string, unknown> }
  | { status: "completed"; summary: string; file: { name: string; bytes: Uint8Array }; image?: { name: string; bytes: Uint8Array }; checks: { name: string; passed: boolean }[]; externalData?: Record<string, unknown> }
  | { status: "failed"; message: string };
export type BusinessTool = WorkflowRoute & {
  version: string;
  title: string;
  fields: BusinessField[];
  unavailableReason?: string;
  /** Replace this selected XLSX after a successful, validated run. */
  updateSource?: string;
  /** Prefills the input form from the connected work folders (today = Asia/Seoul YYYY-MM-DD). The user still sees and can change every pick. */
  suggest?: (files: WorkFile[], today: string) => BusinessInput;
  execute: (input: {
    values: Record<string, string>;
    /** Files in the order the user chose them; single-file fields hold one entry. */
    files: Record<string, { bytes: Buffer; fingerprint: string; name: string }[]>;
    checkpoint: Record<string, unknown>;
    signal: AbortSignal;
  }) => Promise<ToolResult>;
};
