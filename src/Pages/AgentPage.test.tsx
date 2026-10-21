import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThreadsProvider } from "@Contexts/ThreadsProvider";
import type { AgentStreamEvent, KetchupEAgentAPI } from "@app-types/Agent.types";
import AgentPage from "./AgentPage";

vi.mock("@Features/Sidebar/components/Sidebar", () => ({
  default: () => <><Link to="/agent">새 질문</Link><Link to="/agent/other">다른 대화</Link></>,
}));
vi.mock("@Features/Agent/components/WorkSourcePanel", () => ({
  default: ({ onClose }: { onClose: () => void }) => <div role="dialog" aria-label="자료 선택"><button onClick={onClose}>닫기</button></div>,
}));
vi.mock("@Features/Agent/components/CanvasPanel", () => ({
  default: ({ onClose }: { onClose: () => void }) => <section aria-label="문서 초안"><button onClick={onClose}>초안 닫기</button></section>,
}));

const question = "어떤 계약서 작성을 도와드릴까요?";

function setup(openRun: Awaited<ReturnType<KetchupEAgentAPI["openRun"]>> = null) {
  const listeners = new Set<(event: AgentStreamEvent) => void>();
  const api = {
    getWorkspace: vi.fn().mockResolvedValue({ memoryEnabled: true }),
    getModelSettings: vi.fn().mockResolvedValue({ configurable: false }),
    listThreads: vi.fn().mockResolvedValue([]),
    listCollections: vi.fn().mockResolvedValue([]),
    listMemories: vi.fn().mockResolvedValue([]),
    listBusinessArtifacts: vi.fn().mockResolvedValue([]),
    onAgentEvent: vi.fn((listener: (event: AgentStreamEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    onCollectionsChanged: vi.fn(() => () => undefined),
    openRun: vi.fn().mockResolvedValue(openRun),
    loadCanvas: vi.fn().mockResolvedValue({ canvas: null, interrupt: { type: "awaiting_anchor_choice", candidates: [] } }),
    cancelRun: vi.fn().mockResolvedValue(undefined),
    resumeRun: vi.fn().mockResolvedValue(undefined),
    loadThread: vi.fn().mockResolvedValue({ messages: [], hasMore: false }),
    createThread: vi.fn().mockResolvedValue({ id: "new-thread" }),
    startRun: vi.fn().mockResolvedValue({ runId: "draft-run", kind: "canvas" }),
    submitBusinessInput: vi.fn().mockResolvedValue(undefined),
  };
  window.agentAPI = api as unknown as KetchupEAgentAPI;
  render(
    <MemoryRouter initialEntries={["/agent/old-thread"]}>
      <ThreadsProvider>
        <Routes>
          <Route path="/agent" element={<AgentPage />} />
          <Route path="/agent/:threadId" element={<AgentPage />} />
        </Routes>
      </ThreadsProvider>
    </MemoryRouter>,
  );
  return { ...api, emit: (event: AgentStreamEvent) => act(() => listeners.forEach((listener) => listener(event))) };
}

async function chooseContract() {
  fireEvent.click(screen.getByRole("tab", { name: "업무" }));
  fireEvent.click(screen.getByRole("button", { name: /계약서 초안 작성하기/ }));
  await screen.findByText(question);
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

describe("입력창 위 워크플로 상태", () => {
  it("요청 입력 대기에도 이어가기와 중단을 제공한다", async () => {
    const api = setup();
    await chooseContract();
    const bar = screen.getByRole("group", { name: "워크플로 상태" });
    expect(bar.nextElementSibling?.tagName).toBe("FORM");
    expect(within(bar).getByRole("status")).toHaveTextContent("계약서 작성 · 요청 입력 대기");
    fireEvent.click(within(bar).getByRole("button", { name: "이어가기" }));
    expect(screen.getByRole("textbox")).toHaveFocus();
    fireEvent.click(within(bar).getByRole("button", { name: "작업 중단" }));
    expect(within(bar).getByRole("status")).toHaveTextContent("진행 중인 업무가 없습니다");
    expect(api.startRun).not.toHaveBeenCalled();
    expect(api.cancelRun).not.toHaveBeenCalled();
  });

  it("답변 스트리밍 중에도 단계를 표시하고 현재 실행을 중단한다", async () => {
    const api = setup({ runId: "agent-run", kind: "agent", status: "running" });
    const bar = screen.getByRole("group", { name: "워크플로 상태" });
    await waitFor(() => expect(within(bar).getByRole("status")).toHaveTextContent("다음 행동 결정 중"));
    api.emit({ runId: "agent-run", seq: 1, type: "status", payload: { phase: "ANSWER" } });
    api.emit({ runId: "agent-run", seq: 2, type: "text_delta", payload: { text: "답변 내용" } });
    expect(within(bar).getByRole("status")).toHaveTextContent("답변 생성 중");
    expect(within(bar).queryByRole("button", { name: "이어가기" })).not.toBeInTheDocument();
    fireEvent.click(within(bar).getByRole("button", { name: "작업 중단" }));
    await waitFor(() => expect(api.cancelRun).toHaveBeenCalledWith("agent-run"));
    await act(async () => api.emit({ runId: "agent-run", seq: 3, type: "failed", payload: { code: "CANCELLED" } }));
    expect(within(bar).getByRole("status")).toHaveTextContent("진행 중인 업무가 없습니다");
    expect(within(bar).queryByRole("button", { name: "작업 중단" })).not.toBeInTheDocument();
  });

  it("닫은 업무 입력 화면을 이어가기로 다시 연다", async () => {
    setup({ runId: "cash-run", kind: "daily_cash", status: "waiting_user", action: {
      id: "action-1", type: "work_sources", title: "자료 선택", question: "파일을 지정하세요",
    } });
    await screen.findByRole("dialog", { name: "자료 선택" });
    fireEvent.click(screen.getByRole("button", { name: "닫기" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const bar = screen.getByRole("group", { name: "워크플로 상태" });
    expect(within(bar).getByRole("status")).toHaveTextContent("자료 선택 · 입력 대기");
    fireEvent.click(within(bar).getByRole("button", { name: "이어가기" }));
    expect(screen.getByRole("dialog", { name: "자료 선택" })).toBeInTheDocument();
  });

  it("업무 입력은 모달 대신 대화 안의 카드로 받고 이어가기로 카드에 초점을 둔다", async () => {
    const api = setup({ runId: "cash-run", kind: "daily_cash", status: "waiting_user", action: {
      id: "action-1", type: "business_tool", title: "일일자금일보", question: "작업일을 확인해 주세요",
      fields: [{ key: "workDate", label: "작업일", type: "date", required: true }], input: { values: { workDate: "2026-10-15" }, files: {} },
    } });
    const card = await screen.findByRole("form", { name: "일일자금일보 입력" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(card.closest("[role=group]")).toBeNull();
    const bar = screen.getByRole("group", { name: "워크플로 상태" });
    expect(within(bar).getByRole("status")).toHaveTextContent("일일자금일보 · 입력 대기");
    fireEvent.click(within(bar).getByRole("button", { name: "이어가기" }));
    expect(screen.getByLabelText("일일자금일보 입력 대기")).toHaveFocus();
    fireEvent.click(within(card).getByRole("button", { name: "확인하고 계속" }));
    await waitFor(() => expect(api.submitBusinessInput).toHaveBeenCalledWith("cash-run", "action-1", { values: { workDate: "2026-10-15" }, files: {} }));
    api.emit({ runId: "cash-run", seq: 1, type: "status", payload: { phase: "원천 자료 확인 및 업무 실행 중" } });
    expect(screen.queryByRole("form", { name: "일일자금일보 입력" })).not.toBeInTheDocument();
    expect(within(bar).getByRole("status")).toHaveTextContent("원천 자료 확인 및 업무 실행 중");
  });

  it("복원한 계약서의 참고 문서 선택으로 이동하고 대기 중에도 중단한다", async () => {
    const api = setup({ runId: "canvas-run", kind: "canvas", status: "waiting_user" });
    const bar = screen.getByRole("group", { name: "워크플로 상태" });
    await waitFor(() => expect(within(bar).getByRole("status")).toHaveTextContent("참고 문서 선택 대기"));
    fireEvent.click(within(bar).getByRole("button", { name: "이어가기" }));
    expect(screen.getByLabelText("참고 문서 선택")).toHaveFocus();
    fireEvent.click(within(bar).getByRole("button", { name: "작업 중단" }));
    await waitFor(() => expect(api.cancelRun).toHaveBeenCalledWith("canvas-run"));
  });

  it("사용자 답변을 기다릴 때 이어가기는 입력창을 열고 전송은 같은 실행을 재개한다", async () => {
    const api = setup({ runId: "agent-run", kind: "agent", status: "waiting_user" });
    const bar = screen.getByRole("group", { name: "워크플로 상태" });
    await waitFor(() => expect(within(bar).getByRole("status")).toHaveTextContent("답변 대기"));
    fireEvent.click(within(bar).getByRole("button", { name: "이어가기" }));
    expect(screen.getByRole("textbox")).toHaveFocus();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "지난달 기준입니다" } });
    fireEvent.click(screen.getByRole("button", { name: "보내기" }));
    await waitFor(() => expect(api.resumeRun).toHaveBeenCalledWith("agent-run", "지난달 기준입니다"));
    expect(api.startRun).not.toHaveBeenCalled();
  });

  it("초안 창을 닫아도 검토 대기를 표시하고 이어가기로 다시 연다", async () => {
    const api = setup({ runId: "canvas-run", kind: "canvas", status: "waiting_user" });
    const bar = screen.getByRole("group", { name: "워크플로 상태" });
    await waitFor(() => expect(within(bar).getByRole("status")).toHaveTextContent("참고 문서 선택 대기"));
    api.emit({ runId: "canvas-run", seq: 1, type: "canvas", payload: {
      schema_version: "contract.v1", canvas_type: "contract", canvas_id: "c1", version_id: "v1",
      base_version_id: null, status: "drafting", metadata: { title: "계약서", contract_type: "", parties: [] },
      sections: [], missing_terms: [],
    } });
    await act(async () => api.emit({ runId: "canvas-run", seq: 2, type: "ask_user", payload: {
      interrupt: { type: "awaiting_edit", canvas_id: "c1", can_undo: false, can_redo: false },
    } }));
    fireEvent.click(screen.getByRole("button", { name: "초안 닫기" }));
    expect(screen.queryByRole("region", { name: "문서 초안" })).not.toBeInTheDocument();
    expect(within(bar).getByRole("status")).toHaveTextContent("초안 검토 및 수정 대기");
    fireEvent.click(within(bar).getByRole("button", { name: "이어가기" }));
    expect(screen.getByRole("region", { name: "문서 초안" })).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveFocus();
  });

  it("이전 대화 실행이 끝난 뒤 시작한 문서 작업을 정확히 중단한다", async () => {
    const api = setup({ runId: "old-run", kind: "agent", status: "running" });
    await screen.findByText("다음 행동 결정 중");
    api.emit({ runId: "old-run", seq: 1, type: "completed", payload: { text: "완료" } });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "계약서 작성" } });
    fireEvent.click(screen.getByRole("button", { name: "보내기" }));
    await screen.findByText("문서 종류 판단 중");
    const bar = screen.getByRole("group", { name: "워크플로 상태" });
    fireEvent.click(within(bar).getByRole("button", { name: "작업 중단" }));
    await waitFor(() => expect(api.cancelRun).toHaveBeenCalledExactlyOnceWith("draft-run"));
  });
});

afterEach(() => {
  delete window.agentAPI;
});

describe("업무 탭의 계약서 작성 시작", () => {
  it("버튼을 누르면 질문부터 표시하고 빈 입력으로는 실행하지 않는다", async () => {
    const api = setup();
    await chooseContract();

    expect(api.startRun).not.toHaveBeenCalled();
    expect(api.createThread).not.toHaveBeenCalled();
    expect(screen.queryByText(/문서를 처리하는 중|요청을 준비하는 중/)).not.toBeInTheDocument();
    const input = screen.getByRole("textbox");
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("button", { name: "보내기" })).toBeDisabled();
    expect(api.startRun).not.toHaveBeenCalled();
  });

  it("사용자 답변으로 새 대화의 문서 워크플로를 실행한다", async () => {
    const api = setup();
    await chooseContract();
    const text = "A사와 1년간 체결할 소프트웨어 개발 용역 계약서";
    fireEvent.change(screen.getByRole("textbox"), { target: { value: text } });
    fireEvent.click(screen.getByRole("button", { name: "보내기" }));

    await waitFor(() => expect(api.startRun).toHaveBeenCalledExactlyOnceWith({
      threadId: "new-thread", workspaceId: "default", text, mode: "doc",
    }));
    await waitFor(() => expect(screen.queryByText(question)).not.toBeInTheDocument());
  });

  it.each(["새 질문", "다른 대화"])("입력 전에 %s로 이동하면 문서 모드를 해제한다", async (destination) => {
    const api = setup();
    await chooseContract();
    fireEvent.click(screen.getByRole("link", { name: destination }));
    expect(screen.queryByText(question)).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "안녕하세요" } });
    fireEvent.click(screen.getByRole("button", { name: "보내기" }));
    await waitFor(() => expect(api.startRun).toHaveBeenCalledWith(expect.objectContaining({
      text: "안녕하세요", mode: "auto",
    })));
  });

  it("시작 실패 후 다시 보내도 문서 모드를 유지한다", async () => {
    const api = setup();
    api.startRun.mockRejectedValueOnce(new Error("연결 실패"));
    await chooseContract();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "용역 계약서" } });
    fireEvent.click(screen.getByRole("button", { name: "보내기" }));
    await screen.findByText("연결 실패");
    expect(screen.getByText(question)).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "용역 계약서" } });
    fireEvent.click(screen.getByRole("button", { name: "보내기" }));
    await waitFor(() => expect(api.startRun).toHaveBeenCalledTimes(2));
    expect(api.startRun).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "doc" }));
    expect(api.createThread).toHaveBeenCalledTimes(1);
  });

  it("일일자금일보는 기존 시작 흐름을 유지한다", async () => {
    const api = setup();
    fireEvent.click(screen.getByRole("tab", { name: "업무" }));
    fireEvent.click(screen.getByRole("button", { name: /일일자금일보 작성하기/ }));
    await waitFor(() => expect(api.startRun).toHaveBeenCalledExactlyOnceWith({
      threadId: "new-thread", workspaceId: "default", text: "일일자금일보 작성하기", mode: "daily_cash",
    }));
  });
});
