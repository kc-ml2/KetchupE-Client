import { StrictMode } from "react";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentStreamEvent, KetchupEAgentAPI } from "@app-types/Agent.types";
import type { ContractCanvas } from "@app-types/Canvas.types";
import { feedbackToOp, useCanvasRun } from "./useCanvasRun";

const canvas: ContractCanvas = {
  schema_version: "contract.v1",
  canvas_type: "contract",
  canvas_id: "c1",
  version_id: "v1",
  base_version_id: null,
  status: "drafting",
  metadata: { title: "계약서", contract_type: "", parties: [] },
  sections: [{ section_id: "sec_001", section_type: "article", title: "제1조", order: 1, metadata: {}, blocks: [{ block_id: "blk_001_001", block_type: "paragraph", text: "본문" }] }],
  missing_terms: [],
};

function fakeApi() {
  let listener: ((event: AgentStreamEvent) => void) | undefined;
  const api = {
    openRun: vi.fn().mockResolvedValue(null),
    loadCanvas: vi.fn().mockResolvedValue({ canvas: null, interrupt: null }),
    canvasEdit: vi.fn().mockResolvedValue(undefined),
    canvasAnchorChoice: vi.fn().mockResolvedValue(undefined),
    onAgentEvent: vi.fn((next: (event: AgentStreamEvent) => void) => {
      listener = next;
      return () => undefined;
    }),
  } as unknown as KetchupEAgentAPI;
  return { api, emit: (event: AgentStreamEvent) => act(() => listener?.(event)) };
}

describe("useCanvasRun", () => {
  it("shows the canvas after start → canvas → awaiting_edit and routes feedback to ops", async () => {
    const { api, emit } = fakeApi();
    const { result } = renderHook(() => useCanvasRun(api, "thread-1", () => undefined));
    act(() => result.current.attach("run-1"));
    expect(result.current.view).toMatchObject({ runId: "run-1", isBusy: true });

    emit({ runId: "run-1", seq: 1, type: "status", payload: { phase: "drafting" } });
    emit({ runId: "run-1", seq: 2, type: "canvas", payload: canvas });
    emit({ runId: "run-1", seq: 3, type: "ask_user", payload: { interrupt: { type: "awaiting_edit", canvas_id: "c1", can_undo: false, can_redo: false } } });
    expect(result.current.view.canvas?.canvas_id).toBe("c1");
    expect(result.current.view.interrupt?.type).toBe("awaiting_edit");
    expect(result.current.view.isBusy).toBe(false);

    // stale/other-run events are ignored
    emit({ runId: "other", seq: 9, type: "canvas", payload: { ...canvas, canvas_id: "zzz" } });
    expect(result.current.view.canvas?.canvas_id).toBe("c1");

    act(() => result.current.startEditBlock(canvas.sections[0], canvas.sections[0].blocks[0]));
    await act(() => result.current.sendFeedback("더 짧게"));
    expect(api.canvasEdit).toHaveBeenCalledWith("run-1", { op: "edit", block_id: "blk_001_001", feedback: "더 짧게" }, "더 짧게");
    expect(result.current.view.isBusy).toBe(true);
  });

  it("restores an open canvas run when the thread is opened", async () => {
    const { api } = fakeApi();
    (api.openRun as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ runId: "run-2", status: "waiting_user", kind: "canvas" });
    (api.loadCanvas as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ canvas, interrupt: { type: "awaiting_edit", canvas_id: "c1", can_undo: true, can_redo: false } });
    const { result } = renderHook(() => useCanvasRun(api, "thread-2", () => undefined));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.view.runId).toBe("run-2");
    expect(result.current.view.canvas?.canvas_id).toBe("c1");
    expect(result.current.view.interrupt).toMatchObject({ type: "awaiting_edit", can_undo: true });
  });

  it("surfaces a rejected edit and restores the editable state", async () => {
    const { api, emit } = fakeApi();
    (api.canvasEdit as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("편집을 기다리는 문서 작업이 아닙니다."));
    const { result } = renderHook(() => useCanvasRun(api, "thread-3", () => undefined));
    act(() => result.current.attach("run-3"));
    emit({ runId: "run-3", seq: 1, type: "canvas", payload: canvas });
    emit({ runId: "run-3", seq: 2, type: "ask_user", payload: { interrupt: { type: "awaiting_edit", canvas_id: "c1", can_undo: false, can_redo: false } } });
    await act(async () => {
      await result.current.sendFeedback("다시");
    });
    expect(result.current.view.error).toContain("편집을 기다리는");
    expect(result.current.view.interrupt?.type).toBe("awaiting_edit");
    expect(result.current.view.isBusy).toBe(false);
  });

  it("applies every event under StrictMode (updaters are invoked twice in dev)", () => {
    const { api, emit } = fakeApi();
    const { result } = renderHook(() => useCanvasRun(api, "thread-4", () => undefined), { wrapper: StrictMode });
    act(() => result.current.attach("run-4"));
    emit({ runId: "run-4", seq: 1, type: "status", payload: { phase: "drafting" } });
    expect(result.current.view.phase).toBe("drafting");
    emit({ runId: "run-4", seq: 2, type: "canvas", payload: canvas });
    emit({ runId: "run-4", seq: 3, type: "ask_user", payload: { interrupt: { type: "awaiting_edit", canvas_id: "c1", can_undo: false, can_redo: false } } });
    expect(result.current.view.canvas?.canvas_id).toBe("c1");
    expect(result.current.view.interrupt?.type).toBe("awaiting_edit");
  });

  it("maps feedback without a selection to regenerate", () => {
    expect(feedbackToOp([], "전체 다시")).toEqual({ op: "regenerate", feedback: "전체 다시" });
  });
});
