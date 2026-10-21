import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { KetchupEAgentAPI } from "@app-types/Agent.types";
import type { BusinessAction } from "@app-types/BusinessTool.types";
import BusinessToolCard, { BusinessArtifacts } from "./BusinessToolCard";

const file = { sourceId: "local", relativePath: "source.xlsx", name: "source.xlsx" };
const action: BusinessAction = { id: "action", type: "business_tool", title: "일일자금일보", question: "자료를 지정하세요", fields: [{ key: "date", label: "기준일", type: "date", required: true }, { key: "source", label: "입출금 내역", type: "file", required: true }], input: { values: {}, files: {} } };
const apiFixture = () => ({ listWorkSources: vi.fn().mockResolvedValue([{ id: "local" }]), listWorkFiles: vi.fn().mockResolvedValue([file]), submitBusinessInput: vi.fn().mockResolvedValue(undefined), pickWorkFiles: vi.fn().mockResolvedValue([]), listBusinessArtifacts: vi.fn().mockResolvedValue([]), openBusinessArtifact: vi.fn().mockResolvedValue(undefined), saveBusinessArtifact: vi.fn().mockResolvedValue(true) }) as unknown as KetchupEAgentAPI;

it("collects declared inputs without a mapping editor and passes the owning action", async () => {
  const api = apiFixture(); render(<BusinessToolCard api={api} runId="run" action={action} />);
  await screen.findByRole("option", { name: "source.xlsx" });
  fireEvent.change(screen.getByLabelText("기준일 *"), { target: { value: "2026-10-15" } });
  fireEvent.change(screen.getByLabelText("입출금 내역 연결된 자료에서 고르기"), { target: { value: JSON.stringify(file) } });
  fireEvent.click(screen.getByRole("button", { name: "이 자료로 실행" }));
  await waitFor(() => expect(api.submitBusinessInput).toHaveBeenCalledWith("run", "action", { values: { date: "2026-10-15" }, files: { source: [file] } }));
  expect(screen.queryByText("검증한 매핑 저장")).not.toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.queryByText("자료를 지정하세요")).not.toBeInTheDocument();
});
it("shows only the fields still open and folds confirmed inputs into a summary", async () => {
  const api = apiFixture();
  const followUp: BusinessAction = { ...action, lockedKeys: ["date", "source"], question: "최종 확인 코드를 입력하세요",
    fields: [...action.fields, { key: "review", label: "최종 확인 코드", type: "text", required: true }],
    input: { values: { date: "2026-10-15" }, files: { source: [file] } } };
  render(<BusinessToolCard api={api} runId="run" action={followUp} />);
  expect(screen.queryByLabelText("기준일 *")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "파일 선택…" })).not.toBeInTheDocument();
  expect(api.listWorkSources).not.toHaveBeenCalled();
  expect(screen.getByText("확정된 입력 2개")).toBeInTheDocument();
  expect(screen.getByText("입출금 내역: source.xlsx")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("최종 확인 코드 *"), { target: { value: "확인 ab12" } });
  fireEvent.click(screen.getByRole("button", { name: "확인하고 계속" }));
  await waitFor(() => expect(api.submitBusinessInput).toHaveBeenCalledWith("run", "action", { values: { date: "2026-10-15", review: "확인 ab12" }, files: { source: [file] } }));
});
it("adds several picked files to a multi-file field and lets one be removed", async () => {
  const api = apiFixture(); const second = { sourceId: "s2", relativePath: "", name: "국민.xlsx" };
  vi.mocked(api.pickWorkFiles).mockResolvedValue([file, second]);
  const multi: BusinessAction = { ...action, fields: [{ ...action.fields[1], multiple: true }] };
  render(<BusinessToolCard api={api} runId="run" action={multi} />);
  fireEvent.click(await screen.findByRole("button", { name: "파일 추가…" }));
  await screen.findByText("국민.xlsx");
  expect(api.pickWorkFiles).toHaveBeenCalledWith(true);
  fireEvent.click(screen.getByRole("button", { name: "source.xlsx 빼기" }));
  fireEvent.click(screen.getByRole("button", { name: "이 자료로 실행" }));
  await waitFor(() => expect(api.submitBusinessInput).toHaveBeenCalledWith("run", "action", { values: {}, files: { source: [second] } }));
});
it("keeps a rejected input visible for correction", async () => {
  const api = apiFixture(); vi.mocked(api.submitBusinessInput).mockRejectedValue(new Error("자료 확인 필요"));
  render(<BusinessToolCard api={api} runId="run" action={{ ...action, input: { values: { date: "2026-10-15" }, files: { source: [file] } } }} />);
  await screen.findByText("source.xlsx");
  fireEvent.click(screen.getByRole("button", { name: "이 자료로 실행" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("자료 확인 필요");
});
it("reloads completed artifacts and opens by artifact ID rather than renderer path", async () => {
  const api = apiFixture(); const view = render(<BusinessArtifacts api={api} threadId="thread" running={true} />);
  await waitFor(() => expect(api.listBusinessArtifacts).toHaveBeenCalled());
  vi.mocked(api.listBusinessArtifacts).mockResolvedValue([{ id: "artifact", runId: "run", name: "일보.xlsx", toolId: "daily_cash", version: "1.0" }]);
  view.rerender(<BusinessArtifacts api={api} threadId="thread" running={false} />);
  fireEvent.click(await screen.findByRole("button", { name: "일보.xlsx 열기 · v1.0" }));
  expect(api.openBusinessArtifact).toHaveBeenCalledWith("artifact");
});

it.each([true, false, "저장할 수 없습니다"])("downloads a PNG by artifact ID and handles save result %s", async (result) => {
  const api = apiFixture();
  vi.mocked(api.listBusinessArtifacts).mockResolvedValue([{ id: "image", runId: "run", name: "일보.png", toolId: "daily_cash", version: "1.0" }]);
  let finish!: (saved: boolean) => void; let fail!: (error: Error) => void;
  vi.mocked(api.saveBusinessArtifact).mockReturnValue(new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
  render(<BusinessArtifacts api={api} threadId="thread" running={false} />);
  const button = await screen.findByRole("button", { name: "일보.png 다운로드 · v1.0" });
  expect(screen.getAllByRole("button")).toHaveLength(1);
  fireEvent.click(button);
  expect(api.saveBusinessArtifact).toHaveBeenCalledWith("image");
  expect(api.openBusinessArtifact).not.toHaveBeenCalled();
  expect(button).toBeDisabled();
  if (typeof result === "string") fail(new Error(result)); else finish(result);
  await waitFor(() => expect(button).toBeEnabled());
  if (result === true) expect(screen.getByRole("status")).toHaveTextContent("일보.png 저장 완료");
  else expect(screen.queryByRole("status")).not.toBeInTheDocument();
  if (typeof result === "string") expect(screen.getByRole("alert")).toHaveTextContent(result);
  else expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("still offers available files when an older source no longer exists", async () => {
  const api = apiFixture();
  vi.mocked(api.listWorkSources).mockResolvedValue([{ id: "gone", name: "gone", kind: "file", displayPath: "/gone" }, { id: "local", name: "local", kind: "file", displayPath: "/local" }]);
  vi.mocked(api.listWorkFiles).mockImplementation(async (id) => { if (id === "gone") throw new Error("missing"); return [file]; });
  render(<BusinessToolCard api={api} runId="run" action={action} />);
  await screen.findByRole("option", { name: "source.xlsx" });
  expect(screen.getByRole("alert")).toHaveTextContent("일부 연결된 자료");
});
it("submits an untouched movements table as 확인 so a day executed exactly as planned needs no edits", async () => {
  const api = apiFixture();
  const rows = [{ index: 1, direction: "out" as const, description: "전력비", party: "한전", amount: "202230" }];
  const table: BusinessAction = { ...action, fields: [{ key: "actualEdits", label: "10/14 실적", type: "movements", required: true, rows }, { key: "planEdits", label: "10/15 계획", type: "movements", required: true, rows: [] }], input: { values: {}, files: {} } };
  render(<BusinessToolCard api={api} runId="run" action={table} />);
  fireEvent.click(await screen.findByRole("button", { name: "확인하고 계속" }));
  await waitFor(() => expect(api.submitBusinessInput).toHaveBeenCalledWith("run", "action", { values: { actualEdits: "확인", planEdits: "확인" }, files: {} }));
});
it("acknowledges a confirm field with the submit button instead of typing its value", async () => {
  const api = apiFixture();
  const review: BusinessAction = { ...action, lockedKeys: ["date", "source"], fields: [...action.fields, { key: "review", label: "최종 확인 코드 ab12", type: "text", required: true, confirm: "확인 ab12" }], input: { values: { date: "2026-10-15", review: "확인 old0" }, files: { source: [file] } } };
  render(<BusinessToolCard api={api} runId="run" action={review} />);
  expect(screen.getByText("최종 확인 코드 ab12")).toBeInTheDocument();
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "확인하고 계속" }));
  await waitFor(() => expect(api.submitBusinessInput).toHaveBeenCalledWith("run", "action", { values: { date: "2026-10-15", review: "확인 ab12" }, files: { source: [file] } }));
});
it("edits planned movements in a table and submits the amount changes and added rows as edits JSON", async () => {
  const api = apiFixture();
  const rows = [{ index: 1, direction: "out" as const, description: "전력비", party: "한전", amount: "202230" }, { index: 2, direction: "out" as const, description: "인터넷", party: "SKB", amount: "63000" }];
  const table: BusinessAction = { ...action, fields: [{ key: "actualEdits", label: "10/14 실적", type: "movements", required: true, rows }], input: { values: {}, files: {} } };
  render(<BusinessToolCard api={api} runId="run" action={table} />);
  await screen.findByText("전력비");
  fireEvent.change(screen.getByLabelText("2번 실제 금액"), { target: { value: "55550" } });
  fireEvent.click(screen.getByRole("button", { name: "계획에 없는 거래 추가" }));
  fireEvent.change(screen.getByLabelText("추가 거래 구분"), { target: { value: "in" } });
  fireEvent.change(screen.getByLabelText("추가 거래 적요"), { target: { value: "현금반납" } });
  fireEvent.change(screen.getByLabelText("추가 거래 거래처"), { target: { value: "박정경" } });
  fireEvent.change(screen.getByLabelText("추가 거래 금액"), { target: { value: "48200" } });
  fireEvent.click(screen.getByRole("button", { name: "확인하고 계속" }));
  await waitFor(() => expect(api.submitBusinessInput).toHaveBeenCalledTimes(1));
  const submitted = vi.mocked(api.submitBusinessInput).mock.calls[0][2];
  expect(JSON.parse(submitted.values.actualEdits)).toEqual({ changes: [{ index: 2, amount: "55550" }], add: [{ direction: "in", description: "현금반납", party: "박정경", amount: "48200" }] });
});
