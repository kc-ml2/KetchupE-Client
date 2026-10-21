// Canvas editing protocol between the renderer and the local canvas flow.
// Ported from the MARU doc graph's resume contract; the op names are a stable contract.
import type { ContractCanvas } from "./Canvas.types";

// 참고(anchor) 문서 후보: 활성 collection에서 찾은 표준 양식
export interface AnchorCandidate {
  document_id: string;
  name: string;
  score: number;
}

// 참고 문서 선택 대기: 어떤 표준 양식을 기준으로 삼을지 사용자에게 묻는 상태
export interface AnchorChoiceInterruptContent {
  type: "awaiting_anchor_choice";
  candidates: AnchorCandidate[];
}

// 편집 대기: 초안이 준비되었고 다음 편집 명령을 기다리는 상태
export interface CanvasInterruptContent {
  type: "awaiting_edit";
  canvas_id: string;
  can_undo: boolean;
  can_redo: boolean;
  missing_parties?: CanvasPartyValue[];
  error?: string | null;
}

export type CanvasInterrupt = AnchorChoiceInterruptContent | CanvasInterruptContent;

export type AnchorChoiceAction = "use_selected" | "skip";

export interface AnchorChoiceResumeContent {
  document_ids: string[];
  skip: boolean;
  anchor_only: boolean;
}

export interface CanvasPartyValue {
  label: string;
  name?: string;
  address?: string;
  representative?: string;
  role?: string;
}

export type CanvasAtomicEditOp =
  // content가 있으면 LLM 호출 없이 즉시 적용, 없으면 feedback 기반 LLM 재작성 (둘 중 하나만 보낸다)
  | { op: "edit"; block_id: string; feedback?: string; content?: string }
  | { op: "add"; content?: string; feedback?: string; after_block_id?: string; section_id?: string; block_type?: string }
  | { op: "delete"; block_id: string }
  | { op: "reorder"; order: string[]; section_id?: string }
  | { op: "set_parties"; parties: CanvasPartyValue[] }
  | { op: "set_terms"; terms: Array<{ label: string; value: string }> };

export type CanvasEditOp =
  | CanvasAtomicEditOp
  | { op: "batch"; ops: CanvasAtomicEditOp[] }
  | { op: "regenerate"; feedback: string }
  | { op: "undo" }
  | { op: "redo" }
  | { op: "finalize" };

export interface CanvasTermValue {
  term_key: string;
  label: string;
  value: string;
}

export type CanvasActionContext =
  | { op: "edit"; block_id: string; label: string }
  | { op: "add"; section_id: string; after_block_id: string; label: string };

// 렌더러가 run에서 복원하는 canvas 상태
export interface CanvasRunView {
  runId: string;
  canvas: ContractCanvas | null;
  interrupt: CanvasInterrupt | null;
  isRunning: boolean;
}

export interface StartCanvasInput {
  workspaceId: string;
  threadId: string;
  instruction: string;
  canvasType?: string;
  anchorOnly?: boolean;
}
