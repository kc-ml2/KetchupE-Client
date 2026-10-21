import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentStreamEvent, KetchupEAgentAPI } from "@app-types/Agent.types";
import type { ContractBlock, ContractCanvas, ContractSection } from "@app-types/Canvas.types";
import type { AnchorChoiceAction, CanvasActionContext, CanvasAtomicEditOp, CanvasEditOp, CanvasInterrupt, CanvasTermValue } from "@app-types/CanvasEdit.types";

export type CanvasView = {
  runId: string | null;
  canvas: ContractCanvas | null;
  interrupt: CanvasInterrupt | null;
  isBusy: boolean;
  phase: string | null;
  error: string | null;
  actionContexts: CanvasActionContext[];
  selectedAnchorIds: string[];
  changedBlockIds: string[];
  submittedTermsKey: string | null;
  hidden: boolean;
};

const initial: CanvasView = { runId: null, canvas: null, interrupt: null, isBusy: false, phase: null, error: null, actionContexts: [], selectedAnchorIds: [], changedBlockIds: [], submittedTermsKey: null, hidden: false };

const PHASE_LABEL: Record<string, string> = { classifying: "문서 종류 판단 중", grounding: "참고 문서 검색 중", drafting: "초안 작성 중" };
export const canvasPhaseLabel = (phase: string | null): string => (phase ? (PHASE_LABEL[phase] ?? phase) : "");

const blockLabel = (section: ContractSection, block: ContractBlock): string => {
  const article = section.metadata?.article_no ? `${section.metadata.article_no} ` : "";
  return `${article}${section.title}${block.numbering ? ` ${block.numbering}` : ""}`.trim();
};

/** Chat text while blocks are selected becomes block edits/adds; otherwise a whole-document regenerate. */
export const feedbackToOp = (contexts: CanvasActionContext[], feedback: string): CanvasEditOp => {
  if (!contexts.length) return { op: "regenerate", feedback };
  const ops: CanvasAtomicEditOp[] = contexts.map((context) =>
    context.op === "edit"
      ? { op: "edit", block_id: context.block_id, feedback }
      : { op: "add", section_id: context.section_id, after_block_id: context.after_block_id, feedback },
  );
  return ops.length === 1 ? ops[0] : { op: "batch", ops };
};

const changedBlocks = (previous: ContractCanvas | null, next: ContractCanvas): string[] => {
  if (!previous || previous.canvas_id !== next.canvas_id) return [];
  const before = new Map(previous.sections.flatMap((section) => section.blocks.map((block) => [block.block_id, JSON.stringify(block.text ?? block.table)] as const)));
  return next.sections.flatMap((section) => section.blocks.filter((block) => before.get(block.block_id) !== JSON.stringify(block.text ?? block.table)).map((block) => block.block_id));
};

const SETTLING_EVENTS = new Set<AgentStreamEvent["type"]>(["ask_user", "completed", "failed"]);

/** Pure state transition for one event of the attached canvas run (React may invoke updaters twice). */
export const reduceCanvasEvent = (current: CanvasView, event: AgentStreamEvent): CanvasView => {
  const payload = event.payload as Record<string, unknown>;
  switch (event.type) {
    case "status":
      return { ...current, phase: String(payload.phase ?? "") };
    case "canvas": {
      const canvas = event.payload as ContractCanvas;
      return { ...current, canvas, changedBlockIds: changedBlocks(current.canvas, canvas) };
    }
    case "ask_user": {
      const interrupt = payload.interrupt as CanvasInterrupt;
      return { ...current, isBusy: false, phase: null, interrupt, error: interrupt.type === "awaiting_edit" ? (interrupt.error ?? null) : null, selectedAnchorIds: [] };
    }
    case "completed":
      return { ...current, isBusy: false, phase: null, interrupt: null, actionContexts: [] };
    case "failed":
      return { ...current, isBusy: false, phase: null, interrupt: null, error: `${String(payload.code)}: ${String(payload.message ?? "")}` };
    default:
      return current;
  }
};

/** Owns the thread's canvas run: attach, anchor choice, edit ops, and restoring state on thread switch. */
export const useCanvasRun = (api: KetchupEAgentAPI | null, threadId: string | null, onSettled: () => void) => {
  const [view, setView] = useState<CanvasView>(initial);
  const runIdRef = useRef<string | null>(null);
  const lastSeq = useRef(0);
  const settled = useRef(onSettled);
  settled.current = onSettled;

  const bind = useCallback((runId: string | null) => {
    runIdRef.current = runId;
    lastSeq.current = 0;
  }, []);

  useEffect(() => {
    bind(null);
    setView(initial);
    if (!api || !threadId) return;
    let cancelled = false;
    void api.openRun(threadId).then(async (open) => {
      if (cancelled || open?.kind !== "canvas") return;
      const state = await api.loadCanvas(open.runId);
      if (cancelled) return;
      bind(open.runId);
      setView({ ...initial, runId: open.runId, canvas: state.canvas, interrupt: state.interrupt, isBusy: open.status === "running" });
    });
    return () => {
      cancelled = true;
    };
  }, [api, threadId, bind]);

  useEffect(() => {
    if (!api) return;
    return api.onAgentEvent((event: AgentStreamEvent) => {
      if (event.runId !== runIdRef.current || event.seq <= lastSeq.current) return;
      lastSeq.current = event.seq;
      setView((current) => reduceCanvasEvent(current, event));
      if (SETTLING_EVENTS.has(event.type)) settled.current();
    });
  }, [api]);

  /** Binds this hook to a canvas run the page just started. */
  const attach = useCallback(
    (runId: string) => {
      bind(runId);
      setView({ ...initial, runId, isBusy: true, phase: "classifying" });
    },
    [bind],
  );

  const sendOp = useCallback(
    async (op: CanvasEditOp, displayText: string): Promise<boolean> => {
      if (!api || !view.runId) return false;
      if (view.isBusy) {
        setView((current) => ({ ...current, error: "이전 편집이 아직 처리 중입니다." }));
        return false;
      }
      if (view.interrupt?.type !== "awaiting_edit") {
        setView((current) => ({ ...current, error: current.canvas?.status === "finalized" ? "확정된 문서는 편집할 수 없습니다." : "편집을 받을 수 있는 상태가 아닙니다. 새 문서 작성으로 다시 시작하세요." }));
        return false;
      }
      const interrupt = view.interrupt;
      setView((current) => ({ ...current, isBusy: true, interrupt: null, error: null, actionContexts: [] }));
      try {
        await api.canvasEdit(view.runId, op, displayText);
        return true;
      } catch (cause) {
        // The main process refused the op (e.g. run no longer waiting): restore the edit state and show why.
        setView((current) => ({ ...current, isBusy: false, interrupt, error: cause instanceof Error ? cause.message : String(cause) }));
        return false;
      }
    },
    [api, view.runId, view.interrupt, view.isBusy],
  );

  const sendFeedback = useCallback((text: string) => sendOp(feedbackToOp(view.actionContexts, text), text), [sendOp, view.actionContexts]);

  const toggleAnchor = useCallback((documentId: string) => {
    setView((current) => ({ ...current, selectedAnchorIds: current.selectedAnchorIds.includes(documentId) ? current.selectedAnchorIds.filter((id) => id !== documentId) : [...current.selectedAnchorIds, documentId] }));
  }, []);

  const submitAnchorChoice = useCallback(
    async (action: AnchorChoiceAction) => {
      if (!api || !view.runId || view.interrupt?.type !== "awaiting_anchor_choice" || view.isBusy) return;
      const skip = action === "skip";
      if (!skip && !view.selectedAnchorIds.length) return;
      setView((current) => ({ ...current, isBusy: true, interrupt: null, phase: "grounding" }));
      await api.canvasAnchorChoice(view.runId, { document_ids: skip ? [] : view.selectedAnchorIds, skip, anchor_only: false });
    },
    [api, view.runId, view.interrupt, view.isBusy, view.selectedAnchorIds],
  );

  const addContext = (context: CanvasActionContext) =>
    setView((current) => {
      const key = context.op === "edit" ? `edit:${context.block_id}` : `add:${context.after_block_id}`;
      const exists = current.actionContexts.some((item) => (item.op === "edit" ? `edit:${item.block_id}` : `add:${item.after_block_id}`) === key);
      return exists ? current : { ...current, actionContexts: [...current.actionContexts, context] };
    });

  const startEditBlock = (section: ContractSection, block: ContractBlock) => addContext({ op: "edit", block_id: block.block_id, label: blockLabel(section, block) });
  const startAddBlockAfter = (section: ContractSection, block: ContractBlock) => addContext({ op: "add", section_id: section.section_id, after_block_id: block.block_id, label: blockLabel(section, block) });
  const removeContext = (target: CanvasActionContext) =>
    setView((current) => ({ ...current, actionContexts: current.actionContexts.filter((item) => JSON.stringify(item) !== JSON.stringify(target)) }));

  const deleteBlock = (section: ContractSection, block: ContractBlock) => void sendOp({ op: "delete", block_id: block.block_id }, `블록 삭제 요청: ${blockLabel(section, block)}`);
  const updateBlockContent = (section: ContractSection, block: ContractBlock, content: string): boolean => {
    const trimmed = content.trim();
    if (!trimmed || view.isBusy || view.interrupt?.type !== "awaiting_edit") {
      setView((current) => ({ ...current, error: current.isBusy ? "이전 편집이 아직 처리 중입니다." : "편집을 받을 수 있는 상태가 아닙니다." }));
      return false;
    }
    void sendOp({ op: "edit", block_id: block.block_id, content: trimmed }, `블록 직접 수정: ${blockLabel(section, block)}`);
    return true;
  };
  const submitMissingTerms = (terms: CanvasTermValue[]): boolean => {
    if (!view.canvas || !terms.length) return false;
    const key = `${view.canvas.canvas_id}:${view.canvas.version_id}`;
    setView((current) => ({ ...current, submittedTermsKey: key }));
    void sendOp({ op: "set_terms", terms: terms.map(({ label, value }) => ({ label, value })) }, ["미정 항목 입력:", ...terms.map((term) => `${term.label}: ${term.value}`)].join("\n"));
    return true;
  };
  const changeVersion = (op: "undo" | "redo"): boolean => {
    void sendOp({ op }, op === "undo" ? "되돌리기" : "다시 실행");
    return true;
  };
  const finalize = (): boolean => {
    if (!view.canvas || view.canvas.status === "finalized") return false;
    void sendOp({ op: "finalize" }, "문서 확정");
    return true;
  };
  const close = () => setView((current) => ({ ...current, hidden: true, actionContexts: [] }));
  const reopen = () => setView((current) => ({ ...current, hidden: false }));

  const showMissingTermsForm = Boolean(
    view.canvas && view.interrupt?.type === "awaiting_edit" && view.canvas.status !== "finalized" && view.canvas.missing_terms.length > 0 && `${view.canvas.canvas_id}:${view.canvas.version_id}` !== view.submittedTermsKey,
  );

  return { view, attach, sendFeedback, toggleAnchor, submitAnchorChoice, startEditBlock, startAddBlockAfter, removeContext, deleteBlock, updateBlockContent, submitMissingTerms, changeVersion, finalize, close, reopen, showMissingTermsForm };
};
