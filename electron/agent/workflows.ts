import type { StartRunInput } from "../../src/app-types/Agent.types.ts";
import type { StartCanvasInput } from "../../src/app-types/CanvasEdit.types.ts";
import type { WorkflowRoute } from "./router.ts";
import type { RunHandle } from "./runLifecycle.ts";

export type WorkflowStartInput = StartRunInput & { runId?: string; canvas?: Pick<StartCanvasInput, "canvasType" | "anchorOnly"> };
export type WorkflowHandle = RunHandle;

/** The Harness owns orchestration; an executor owns its domain state and must drain before a handoff. */
export type AgentWorkflow = WorkflowRoute & {
  kind: string;
  start: (input: WorkflowStartInput) => WorkflowHandle;
  resume?: (runId: string, text: string) => WorkflowHandle;
  cancel: (runId: string) => void | Promise<void>;
};

/** A cooperative yield, never an error fallback or a request to replay a completed side effect. */
export class WorkflowHandoff extends Error {
  constructor(readonly workflow: string, readonly reason: string) {
    super(reason);
    this.name = "WorkflowHandoff";
  }
}
