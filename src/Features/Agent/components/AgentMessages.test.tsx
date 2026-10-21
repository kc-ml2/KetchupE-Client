import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import AgentMessages from "./AgentMessages";

const defaults = {
  messages: [],
  streamingText: "",
  streamingRunId: null,
  streamingCitations: [],
  streamingAppliedContext: { memories: [] },
  progressText: null,
  hasMore: false,
  onLoadOlder: vi.fn(),
  onOpenCitation: vi.fn(),
};

describe("AgentMessages", () => {
  it("진행 상태와 답변의 참고 문서 제목을 표시한다", () => {
    const onOpenCitation = vi.fn();
    const { rerender } = render(
      <AgentMessages {...defaults} progressText="문서 검색 중" />,
    );
    expect(screen.getByText("문서 검색 중")).toBeInTheDocument();

    rerender(
      <AgentMessages
        {...defaults}
        streamingText="연차를 정산합니다 [[e1]]."
        streamingRunId="run-1"
        streamingCitations={[
          { evidenceId: "e1", title: "인사 규정", breadcrumb: [], page: 2 },
        ]}
        streamingAppliedContext={{
          workspaceInstruction: "인사 규정에 근거해 답변",
          memories: [
            {
              id: "memory-1",
              kind: "preference",
              content: "답변은 존댓말로 작성",
            },
          ],
        }}
        onOpenCitation={onOpenCitation}
      />,
    );
    expect(screen.queryByText("문서 검색 중")).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "[1] 인사 규정 · 2쪽" }),
    );
    expect(onOpenCitation).toHaveBeenCalledWith("run-1", "e1");
    expect(screen.getByText("인사 규정에 근거해 답변")).toBeInTheDocument();
    expect(screen.getByText(/답변은 존댓말로 작성/)).toBeInTheDocument();
  });

  it("답변을 마크다운으로 렌더링하고 [[eN]]은 인용 칩으로 남긴다", () => {
    const onOpenCitation = vi.fn();
    render(
      <AgentMessages
        {...defaults}
        streamingRunId="run-1"
        streamingText={
          "## 연차 정산\n\n- **미사용 연차**는 수당으로 지급 [[e1]]\n- `통상임금` 기준"
        }
        onOpenCitation={onOpenCitation}
      />,
    );

    expect(
      screen.getByRole("heading", { level: 2, name: "연차 정산" }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("미사용 연차").tagName).toBe("STRONG");
    expect(screen.getByText("통상임금").tagName).toBe("CODE");

    fireEvent.click(screen.getByRole("button", { name: "1" }));
    expect(onOpenCitation).toHaveBeenCalledWith("run-1", "e1");
  });

  it("필수 확인 정보를 별도 블록으로 구분해 표시한다", () => {
    render(
      <AgentMessages
        {...defaults}
        streamingRunId="run-1"
        streamingText={
          "답변입니다.\n\n필수 확인\n33889000081904:KRW → P238 (하나_입출금_...)"
        }
      />,
    );

    expect(screen.getByText("필수 확인")).toBeInTheDocument();
    expect(document.querySelector("blockquote")).not.toBeNull();
    expect(document.querySelector("blockquote")?.textContent).toContain(
      "33889000081904:KRW → P238",
    );
  });

  it.each([
    "### 계좌 연결\n\n- TEST:KRW → H10\n- TERM:KRW → H51",
    "계좌 연결\nTEST:KRW → H10\nTERM:KRW → H51",
  ])("계좌 목록은 기본으로 접고 제목을 누르면 펼치거나 접는다: %s", (accounts) => {
    const { rerender } = render(<AgentMessages {...defaults} streamingText={`${accounts}\n\n### 계획 대비 실적 차이\n\n차이 없음`} />);
    const summary = screen.getByText("계좌 연결");
    const details = summary.closest("details")!;
    expect(summary.tagName).toBe("SUMMARY");
    expect(details).not.toHaveAttribute("open");
    expect(screen.getByText("TEST:KRW → H10")).not.toBeVisible();
    expect(screen.getByRole("heading", { name: "계획 대비 실적 차이" })).toBeVisible();
    expect(screen.getByText("차이 없음").closest("details")).toBeNull();
    fireEvent.click(summary);
    expect(details).toHaveAttribute("open");
    expect(screen.getByText("TEST:KRW → H10")).toBeVisible();
    expect(screen.getByText("TERM:KRW → H51")).toBeVisible();
    fireEvent.click(summary);
    expect(details).not.toHaveAttribute("open");
    rerender(<AgentMessages {...defaults} streamingText={`\`\`\`text\n${accounts}\n\`\`\``} />);
    expect(document.querySelector("details")).toBeNull();
  });

  it("일일자금일보 확인 내용을 제목, 목록, 강조로 표시한다", () => {
    render(
      <AgentMessages
        {...defaults}
        messages={[{
          id: "review", threadId: "thread", runId: "run", role: "assistant",
          content: "### 계획 대비 실적 차이\n\n- 계획 **100원** → 실적 **120원**\n\n### 정기예금 집행\n\n**이자는 원금 증감에서 제외합니다.**\n\n- **입금 10000원** · 정기예금 만기 원금",
          citations: [], appliedContext: { memories: [] }, createdAt: "2026-10-20T00:00:00Z",
        }]}
      />,
    );
    expect(screen.getByRole("heading", { level: 3, name: "계획 대비 실적 차이" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "정기예금 집행" })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("입금 10000원").tagName).toBe("STRONG");
  });

  it("답변 텍스트를 복사한다", () => {
    const writeText = vi.fn();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(
      <AgentMessages
        {...defaults}
        messages={[
          {
            id: "message-1",
            threadId: "thread-1",
            runId: "run-1",
            role: "assistant",
            content: "복사할 답변",
            citations: [],
            appliedContext: { memories: [] },
            createdAt: "2026-09-15T00:00:00.000Z",
          },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "답변 복사" }));
    expect(writeText).toHaveBeenCalledWith("복사할 답변");
  });

  it("저장된 구형 dailyCash 확인문은 빈 줄 없이 이어져도 제목과 목록으로 표시한다", () => {
    const content = "계좌 연결\nTEST:KRW → H10 (신한_입출금_지주_원화)\n\n계획 대비 실적 차이\nin / ㅁ / : 계획 0 → 실적 48200\n정기예금 집행 (이자는 원금 증감 제외)\n없음\n신규 가입\n없음\n만기: 없음\n원화 대사 대상: 177119320840원 (Sheet1!O52, 계좌잔고)\n환율: 2026-10-14 최종 1206회, USD 1343, JPY(1엔) 8.4944, CNY 200.63.\n확정하려면 확인하고 계속을 누르세요. 표를 수정하면 새 확인 코드로 다시 확인합니다.";
    const { rerender } = render(<AgentMessages {...defaults} messages={[{
      id: "legacy", threadId: "thread", runId: "run", role: "assistant", content,
      citations: [], appliedContext: { memories: [] }, createdAt: "2026-10-20T00:00:00Z",
    }]} />);
    expect(screen.getByText("계좌 연결").tagName).toBe("SUMMARY");
    for (const name of ["계획 대비 실적 차이", "정기예금 집행 (이자는 원금 증감 제외)", "신규 가입", "만기", "원화 대사 대상", "환율"]) {
      expect(screen.getByRole("heading", { level: 3, name })).toBeInTheDocument();
    }
    expect(screen.getAllByRole("listitem", { hidden: true })).toHaveLength(7);
    expect(screen.getByText("in / ㅁ / : 계획 0 → 실적 48200").closest("li")).not.toBeNull();
    expect(screen.getByText("TEST:KRW → H10 (신한_입출금_지주_원화)")).toBeInTheDocument();
    expect(screen.getByText(/확정하려면/).closest("li")).toBeNull();

    rerender(<AgentMessages {...defaults} streamingText={content} />);
    expect(screen.getByRole("heading", { level: 3, name: "계획 대비 실적 차이" })).toBeInTheDocument();
    rerender(<AgentMessages {...defaults} streamingText={`\`\`\`text\n${content}\n\`\`\``} />);
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
    expect(document.querySelector("pre")?.textContent).toContain(content);
  });
});
