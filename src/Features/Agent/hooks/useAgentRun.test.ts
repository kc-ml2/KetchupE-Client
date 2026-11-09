import { StrictMode } from "react";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentStreamEvent, KetchupEAgentAPI } from "@app-types/Agent.types";
import { useAgentRun } from "./useAgentRun";

function fakeApi() {
  let listener: ((event: AgentStreamEvent) => void) | undefined;
  const api = {
    openRun: vi.fn().mockResolvedValue(null),
    resumeRun: vi.fn().mockResolvedValue(undefined),
    onAgentEvent: vi.fn((next: (event: AgentStreamEvent) => void) => {
      listener = next;
      return () => undefined;
    }),
  } as unknown as KetchupEAgentAPI;
  return { api, emit: (event: AgentStreamEvent) => act(() => listener?.(event)) };
}

describe("useAgentRun", () => {
  it("reattaches to a registered text workflow", async () => {
    const { api } = fakeApi();
    vi.mocked(api.openRun).mockResolvedValue({ runId: "summary-1", status: "running", kind: "summary" });
    const { result } = renderHook(() => useAgentRun(api, "thread-summary", () => undefined));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.view).toMatchObject({ runId: "summary-1", isRunning: true });
  });

  it("streams text deltas and keeps the completed payload visible until messages reload", () => {
    const { api, emit } = fakeApi();
    const onSettled = vi.fn();
    const { result } = renderHook(() => useAgentRun(api, "thread-1", onSettled), { wrapper: StrictMode });
    act(() => result.current.attach("run-1"));
    emit({ runId: "run-1", seq: 1, type: "status", payload: { phase: "searching" } });
    emit({ runId: "run-1", seq: 2, type: "text_delta", payload: { text: "미사용 " } });
    emit({ runId: "run-1", seq: 3, type: "text_delta", payload: { text: "연차는" } });
    expect(result.current.view.streamingText).toBe("미사용 연차는");
    expect(result.current.view.phase).toBe("searching");
    emit({ runId: "run-1", seq: 3, type: "text_delta", payload: { text: "(dup)" } });
    emit({ runId: "other", seq: 4, type: "text_delta", payload: { text: "(other)" } });
    expect(result.current.view.streamingText).toBe("미사용 연차는");
    emit({ runId: "run-1", seq: 4, type: "completed", payload: { outcome: "success", text: "미사용 연차는", citations: [{ evidenceId: "e1", title: "취업규칙", breadcrumb: [] }], appliedContext: { workspaceInstruction: "인사 규정만 사용", memories: [] } } });
    expect(result.current.view).toMatchObject({ isRunning: false, streamingText: "미사용 연차는", citations: [{ evidenceId: "e1", title: "취업규칙" }], appliedContext: { workspaceInstruction: "인사 규정만 사용" } });
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("restores an ASK-waiting agent run but ignores canvas runs", async () => {
    const { api } = fakeApi();
    (api.openRun as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ runId: "run-2", status: "waiting_user", kind: "agent" });
    const { result } = renderHook(() => useAgentRun(api, "thread-2", () => undefined));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.view).toMatchObject({ runId: "run-2", waitingQuestion: "" });
    (api.openRun as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ runId: "run-3", status: "waiting_user", kind: "canvas" });
    const other = renderHook(() => useAgentRun(api, "thread-3", () => undefined));
    await act(async () => {
      await Promise.resolve();
    });
    expect(other.result.current.view.runId).toBeNull();
  });

  it("reattaches to a running agent after navigating to its thread", async () => {
    const { api } = fakeApi();
    (api.openRun as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ runId: "run-live", status: "running", kind: "agent" });
    const { result } = renderHook(() => useAgentRun(api, "thread-live", () => undefined));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.view).toMatchObject({ runId: "run-live", isRunning: true, phase: "deciding" });
  });
});

it("restores pending file selection and clears it when the workflow finishes", async () => {
  const { api, emit } = fakeApi();
  const action = { id: "a1", type: "work_sources" as const, title: "자료 선택", question: "파일을 지정하세요" };
  vi.mocked(api.openRun).mockResolvedValue({ runId: "local", status: "waiting_user", kind: "daily_cash", action });
  const { result } = renderHook(() => useAgentRun(api, "thread", () => undefined));
  await act(async () => { await Promise.resolve(); });
  expect(result.current.view).toMatchObject({ action, waitingQuestion: action.question, isRunning: false });
  emit({ runId: "local", seq: 5, type: "completed", payload: { text: "준비 완료" } });
  expect(result.current.view).toMatchObject({ action: null, waitingQuestion: null, isRunning: false });
  act(() => result.current.attach("new", action));
  expect(result.current.view).toMatchObject({ action, isRunning: false });
});

it("does not show a running spinner for an unavailable tool", () => {
  const { api } = fakeApi();
  const { result } = renderHook(() => useAgentRun(api, "thread", () => undefined));
  act(() => result.current.attach("not-ready", undefined, "abstained"));
  expect(result.current.view).toMatchObject({ isRunning: false, phase: null });
});

it("refreshes persisted answers once and ignores progress, duplicate and unrelated events", () => {
  const { api, emit } = fakeApi();
  const reload = vi.fn();
  const { result } = renderHook(() => useAgentRun(api, "thread", reload), { wrapper: StrictMode });
  act(() => result.current.attach("run-1"));
  const accepted: AgentStreamEvent = { runId: "run-1", seq: 1, type: "status", payload: { phase: "분석 중", messagesChanged: true } };
  emit(accepted);
  emit(accepted);
  emit({ ...accepted, runId: "other", seq: 2 });
  emit({ ...accepted, seq: 2, payload: { phase: "보고서 생성 중" } });
  expect(reload).toHaveBeenCalledTimes(1);
  expect(result.current.view).toMatchObject({ isRunning: true, phase: "보고서 생성 중" });
});

it("shows a friendly model failure while preserving actionable authentication messages", () => {
  const { api, emit } = fakeApi();
  const { result } = renderHook(() => useAgentRun(api, "thread", () => undefined));
  act(() => result.current.attach("failed-model"));
  emit({ runId: "failed-model", seq: 1, type: "failed", payload: { code: "MODEL_PROTOCOL", message: "HTTP 400" } });
  expect(result.current.view).toMatchObject({ isRunning: false, error: "케찹이가 잠깐 쉬고 있어요. 잠시 후 다시 시도해 주세요." });
  act(() => result.current.attach("failed-auth"));
  emit({ runId: "failed-auth", seq: 1, type: "failed", payload: { code: "MODEL_AUTH", message: "로그아웃 후 다시 인증해 주세요." } });
  expect(result.current.view.error).toContain("로그아웃 후 다시 인증해 주세요.");
});


it("moves between text and canvas ownership without mixing old text or resetting event order", () => {
  const { api, emit } = fakeApi();
  const { result } = renderHook(() => useAgentRun(api, "thread", () => undefined));
  act(() => result.current.attach("run"));
  emit({ runId: "run", seq: 1, type: "text_delta", payload: { text: "old draft" } });
  emit({ runId: "run", seq: 2, type: "workflow_changed", payload: { threadId: "thread", kind: "canvas" } });
  expect(result.current.view).toMatchObject({ runId: null, streamingText: "", isRunning: false });
  emit({ runId: "run", seq: 3, type: "ask_user", payload: { interrupt: { type: "awaiting_edit" } } });
  expect(result.current.view.waitingQuestion).toBeNull();
  emit({ runId: "run", seq: 4, type: "workflow_changed", payload: { threadId: "thread", kind: "excel_work" } });
  emit({ runId: "run", seq: 3, type: "failed", payload: { message: "stale" } });
  expect(result.current.view).toMatchObject({ runId: "run", streamingText: "", isRunning: true, error: null });
  emit({ runId: "other", seq: 5, type: "workflow_changed", payload: { threadId: "other-thread", kind: "canvas" } });
  expect(result.current.view.runId).toBe("run");
});
