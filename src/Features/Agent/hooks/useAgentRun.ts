import { useCallback, useEffect, useRef, useState } from "react";
import type { RunStatus, RunAction, AgentStreamEvent, AppliedContext, CitationSummary, KetchupEAgentAPI } from "@app-types/Agent.types";

export type RunView = {
  runId: string | null;
  action?: RunAction | null;
  phase: string | null;
  streamingText: string;
  citations: CitationSummary[];
  appliedContext: AppliedContext;
  waitingQuestion: string | null;
  error: string | null;
  isRunning: boolean;
};

const PHASE_LABEL: Record<string, string> = {
  deciding: "다음 행동 결정 중",
  searching: "문서 검색 중",
  SEARCH: "검색",
  ASK: "질문",
  VERIFY: "근거 검증 중",
  ANSWER: "답변 생성 중",
  STOP: "종료",
};

export const phaseLabel = (phase: string | null): string => (phase ? (PHASE_LABEL[phase] ?? phase) : "");

const initial: RunView = { runId: null, phase: null, streamingText: "", citations: [], appliedContext: { memories: [] }, waitingQuestion: null, error: null, isRunning: false };

const SETTLING_EVENTS = new Set<AgentStreamEvent["type"]>(["ask_user", "completed", "failed"]);

/** Pure state transition for one event of the attached run. Kept side-effect free: React may invoke updaters twice. */
export const reduceRunEvent = (current: RunView, event: AgentStreamEvent): RunView => {
  const payload = event.payload as Record<string, unknown>;
  switch (event.type) {
    case "status":
      return { ...current, isRunning: true, action: null, waitingQuestion: null, phase: String(payload.phase ?? "") };
    case "text_delta":
      return { ...current, streamingText: current.streamingText + String(payload.text ?? "") };
    case "citation":
      return { ...current, citations: [...current.citations, payload as unknown as CitationSummary] };
    case "ask_user":
      return { ...current, isRunning: false, phase: null, waitingQuestion: String(payload.question ?? ""), action: payload.action as RunAction | undefined };
    case "completed":
      return {
        ...current,
        action: null, waitingQuestion: null,
        isRunning: false,
        phase: null,
        streamingText: String(payload.text ?? current.streamingText),
        citations: Array.isArray(payload.citations) ? payload.citations as CitationSummary[] : current.citations,
        appliedContext: payload.appliedContext && typeof payload.appliedContext === "object" ? payload.appliedContext as AppliedContext : current.appliedContext,
      };
    case "failed":
      return { ...current, isRunning: false, phase: null, streamingText: "", action: null, waitingQuestion: null, error: `${String(payload.code)}: ${String(payload.message ?? "")}` };
    default:
      return current;
  }
};

/** Owns one thread's live run: attach/resume/cancel and the runId+seq-filtered event stream (LiteLLM SSE → text_delta). */
export const useAgentRun = (api: KetchupEAgentAPI | null, threadId: string | null, onSettled: () => void) => {
  const [view, setView] = useState<RunView>(initial);
  // Event bookkeeping lives in refs mutated by the listener (never inside a state updater).
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
    void api.openRun(threadId).then((open) => {
      if (cancelled || !open || open.kind === "canvas") return;
      bind(open.runId);
      setView((current) => open.status === "waiting_user"
        ? { ...current, runId: open.runId, waitingQuestion: open.action?.question ?? "", action: open.action }
        : { ...current, runId: open.runId, isRunning: true, phase: "deciding" });
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
      setView((current) => reduceRunEvent(current, event));
      if (SETTLING_EVENTS.has(event.type)) settled.current();
    });
  }, [api]);

  /** Binds this hook to a run the page just started. */
  const attach = useCallback(
    (runId: string, action?: RunAction, status?: RunStatus) => {
      bind(runId);
      setView({ ...initial, runId, action, waitingQuestion: action?.question ?? null, isRunning: !action && status !== "abstained", phase: action || status === "abstained" ? null : "deciding" });
    },
    [bind],
  );

  const resume = useCallback(
    async (text: string) => {
      if (!api || !view.runId || view.waitingQuestion === null) return false;
      bind(view.runId);
      setView({ ...initial, runId: view.runId, isRunning: true, phase: "deciding" });
      try { await api.resumeRun(view.runId, text); }
      catch (cause) { setView({ ...view, error: String(cause) }); return false; }
      return true;
    },
    [api, view, bind],
  );

  const cancel = useCallback(async () => {
    if (api && view.runId) await api.cancelRun(view.runId);
  }, [api, view.runId]);

  return { view, attach, resume, cancel };
};
