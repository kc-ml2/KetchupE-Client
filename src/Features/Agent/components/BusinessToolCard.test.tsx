import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { KetchupEAgentAPI } from "@app-types/Agent.types";
import type { BusinessAction } from "@app-types/BusinessTool.types";
import BusinessToolCard, { BusinessArtifacts } from "./BusinessToolCard";

const file = { sourceId: "local", relativePath: "source.xlsx", name: "source.xlsx" };
const action: BusinessAction = { id: "action", type: "business_tool", title: "일일자금일보", question: "자료를 지정하세요", fields: [{ key: "date", label: "기준일", type: "date", required: true }, { key: "source", label: "입출금 내역", type: "file", required: true }], input: { values: {}, files: {} } };
const apiFixture = () => ({ listWorkSources: vi.fn().mockResolvedValue([{ id: "local" }]), listWorkFiles: vi.fn().mockResolvedValue([file]), submitBusinessInput: vi.fn().mockResolvedValue(undefined), pickWorkFiles: vi.fn().mockResolvedValue([]), previewBusinessArtifact: vi.fn().mockResolvedValue("data:image/png;base64,fixture"), listBusinessArtifacts: vi.fn().mockResolvedValue([]), openBusinessArtifact: vi.fn().mockResolvedValue(undefined), saveBusinessArtifact: vi.fn().mockResolvedValue(true) }) as unknown as KetchupEAgentAPI;

const bindingField = { key: "accountBindings", label: "계좌별 전일 일보 연결", type: "text" as const, required: true,
  accountRows: [{ key: "001234:KRW", name: "기업_입출금_원화", currency: "KRW", balance: "7580100" }, { key: "001234:USD", name: "기업_외화", currency: "USD", balance: "10" }] };

it("collects labeled account cells and preserves earlier mappings without exposing JSON", async () => {
  const api = apiFixture();
  render(<BusinessToolCard api={api} runId="run" action={{ ...action, fields: [bindingField], input: { files: {}, values: { accountBindings: '{"earlier:KRW":"H10"}' } } }} />);
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  expect(screen.getAllByText("001234")).toHaveLength(2);
  const area = screen.getByLabelText("001234:KRW 일보 영역");
  const row = screen.getByLabelText("001234:KRW 행 번호") as HTMLInputElement;
  expect(row.checkValidity()).toBe(false);
  fireEvent.change(row, { target: { value: "12" } });
  fireEvent.change(area, { target: { value: "H" } });
  fireEvent.change(screen.getByLabelText("001234:USD 일보 영역"), { target: { value: "P" } });
  fireEvent.change(screen.getByLabelText("001234:USD 행 번호"), { target: { value: "239" } });
  expect(screen.getByText("연결할 셀: H12")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "확인하고 계속" }));
  await waitFor(() => expect(api.submitBusinessInput).toHaveBeenCalled());
  const submitted = vi.mocked(api.submitBusinessInput).mock.calls[0][2];
  expect(JSON.parse(submitted.values.accountBindings)).toEqual({ "earlier:KRW": "H10", "001234:KRW": "H12", "001234:USD": "P239" });
});

it.each(["not valid", '{"001234:KRW":"H12"}'])("lets an account form replace a previous answer: %s", async (value) => {
  const api = apiFixture();
  vi.mocked(api.submitBusinessInput).mockRejectedValue(new Error("통화/정기예금 구분과 대상 셀이 다릅니다."));
  render(<BusinessToolCard api={api} runId="run" action={{ ...action, fields: [{ ...bindingField, accountRows: bindingField.accountRows.slice(0, 1) }], input: { files: {}, values: { accountBindings: value } } }} />);
  const row = screen.getByLabelText("001234:KRW 행 번호") as HTMLInputElement;
  for (const invalid of ["0", "1000", "1.5"]) { fireEvent.change(row, { target: { value: invalid } }); expect(row.checkValidity()).toBe(false); }
  fireEvent.change(screen.getByLabelText("001234:KRW 일보 영역"), { target: { value: "P" } });
  fireEvent.change(row, { target: { value: "248" } });
  fireEvent.click(screen.getByRole("button", { name: "확인하고 계속" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("통화/정기예금");
  expect(row).toHaveValue(248);
  expect(screen.getByLabelText("001234:KRW 일보 영역")).toHaveValue("P");
});

it("summarizes confirmed account mappings without displaying their stored JSON", () => {
  render(<BusinessToolCard api={apiFixture()} runId="run" action={{ ...action, fields: [bindingField], lockedKeys: [bindingField.key], input: { files: {}, values: { accountBindings: '{"001234:KRW":"H12"}' } } }} />);
  expect(screen.getByText("계좌별 전일 일보 연결: 확인 완료")).toBeInTheDocument();
  expect(screen.queryByText(/\{"001234/)).not.toBeInTheDocument();
});

it("submits an explicitly chosen Excel output format", async () => {
  const api = apiFixture();
  render(<BusinessToolCard api={api} runId="run" action={{ ...action, fields: [{ key: "format", label: "결과 형식", type: "select", required: false, options: [{ value: "pdf", label: "PDF" }, { value: "html", label: "HTML" }, { value: "xlsx", label: "엑셀" }] }] }} />);
  expect(screen.getByLabelText("결과 형식")).toHaveValue("");
  fireEvent.change(screen.getByLabelText("결과 형식"), { target: { value: "xlsx" } });
  fireEvent.click(screen.getByRole("button", { name: "확인하고 계속" }));
  await waitFor(() => expect(api.submitBusinessInput).toHaveBeenCalledWith("run", "action", { files: {}, values: { format: "xlsx" } }));
});

it("submits a stable clarification choice and allows replacing it with free text", async () => {
  const api = apiFixture();
  vi.mocked(api.submitBusinessInput).mockRejectedValue(new Error("retry"));
  render(<BusinessToolCard api={api} runId="run" action={{ ...action, fields: [{ key: "answer4", label: "확인 내용", type: "text", required: true, options: [{ value: "weight", label: "원본 Weight (%)" }] }] }} />);
  fireEvent.change(screen.getByLabelText("확인 내용 선택지"), { target: { value: "weight" } });
  expect(screen.getByRole("textbox")).toHaveValue("원본 Weight (%)");
  fireEvent.click(screen.getByRole("button", { name: "확인하고 계속" }));
  await screen.findByRole("alert");
  expect(vi.mocked(api.submitBusinessInput).mock.calls[0][2].values.answer4).toBe("weight");
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "최초 측정값 기준 감소량으로 변경" } });
  expect(screen.getByLabelText("확인 내용 선택지")).toHaveValue("");
  fireEvent.click(screen.getByRole("button", { name: "확인하고 계속" }));
  await waitFor(() => expect(api.submitBusinessInput).toHaveBeenCalledTimes(2));
  expect(vi.mocked(api.submitBusinessInput).mock.calls[1][2].values.answer4).toBe("최초 측정값 기준 감소량으로 변경");
});

it.each(["pdf", "html", "xlsx"])("saves a %s artifact by ID", async (extension) => {
  const api = apiFixture();
  vi.mocked(api.listBusinessArtifacts).mockResolvedValue([{ id: "output", runId: "run", name: `분석.${extension}`, toolId: "excel_work", version: "0.1" }]);
  render(<BusinessArtifacts api={api} threadId="thread" running={false} />);
  fireEvent.click(await screen.findByRole("button", { name: `분석.${extension} 저장` }));
  await waitFor(() => expect(api.saveBusinessArtifact).toHaveBeenCalledWith("output"));
});

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
  expect(api.pickWorkFiles).toHaveBeenCalledWith(true, undefined);
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
  fireEvent.click(await screen.findByRole("button", { name: "일보.xlsx 열기" }));
  expect(api.openBusinessArtifact).toHaveBeenCalledWith("artifact");
});

it.each([undefined, "평균 대신 합계로 바꿔줘"])("shows the revision field only for an existing revision: %s", async revision => {
  const api = apiFixture();
  render(<BusinessToolCard api={api} runId="run" action={{ ...action,
    fields: [{ key: "request", label: "요청사항", type: "text", required: true }, { key: "revision", label: "추가·수정 요청", type: "text", required: false }],
    input: { files: {}, values: { request: "실험 결과를 정리해줘", ...(revision ? { revision } : {}) } } }} />);
  expect(screen.getByLabelText("요청사항 *")).toBeInTheDocument();
  if (revision) {
    expect(screen.getByLabelText("추가·수정 요청")).toHaveValue(revision);
    fireEvent.change(screen.getByLabelText("추가·수정 요청"), { target: { value: "" } });
    expect(screen.getByLabelText("추가·수정 요청")).toBeInTheDocument();
  } else expect(screen.queryByLabelText("추가·수정 요청")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "확인하고 계속" }));
  await waitFor(() => expect(api.submitBusinessInput).toHaveBeenCalled());
});

it("offers Excel revision and disables it during a running job", async () => {
  const api = apiFixture(), onRevise = vi.fn();
  vi.mocked(api.listBusinessArtifacts).mockResolvedValue([{ id: "result", runId: "run", name: "보고서.xlsx", toolId: "excel_work", version: "0.4" }]);
  const view = render(<BusinessArtifacts api={api} threadId="thread" running={false} onRevise={onRevise} />);
  fireEvent.click(await screen.findByRole("button", { name: "이 결과 수정하기" }));
  expect(onRevise).toHaveBeenCalledWith("result");
  view.rerender(<BusinessArtifacts api={api} threadId="thread" running={true} onRevise={onRevise} />);
  expect(await screen.findByRole("button", { name: "이 결과 수정하기" })).toBeDisabled();
});

it.each([true, false, "저장할 수 없습니다"])("downloads a PNG by artifact ID and handles save result %s", async (result) => {
  const api = apiFixture();
  vi.mocked(api.listBusinessArtifacts).mockResolvedValue([{ id: "image", runId: "run", name: "일보.png", toolId: "daily_cash", version: "1.0" }]);
  let finish!: (saved: boolean) => void; let fail!: (error: Error) => void;
  vi.mocked(api.saveBusinessArtifact).mockReturnValue(new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
  render(<BusinessArtifacts api={api} threadId="thread" running={false} />);
  const button = await screen.findByRole("button", { name: "일보.png 다운로드" });
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

it("still offers available files without a warning when an older source no longer exists", async () => {
  const api = apiFixture();
  vi.mocked(api.listWorkSources).mockResolvedValue([{ id: "gone", name: "gone", kind: "file", displayPath: "/gone" }, { id: "local", name: "local", kind: "file", displayPath: "/local" }]);
  vi.mocked(api.listWorkFiles).mockImplementation(async (id) => { if (id === "gone") throw new Error("missing"); return [file]; });
  render(<BusinessToolCard api={api} runId="run" action={action} />);
  await screen.findByRole("option", { name: "source.xlsx" });
  expect(screen.queryByRole("alert")).toBeNull();
});
it("lets an upload-only card use just the file picker without reading connected folders", async () => {
  const api = apiFixture();
  render(<BusinessToolCard api={api} runId="run" action={{ ...action, uploadOnly: true }} />);
  expect(screen.queryByRole("combobox", { name: /연결된 자료/ })).toBeNull();
  expect(api.listWorkSources).not.toHaveBeenCalled();
  expect(screen.queryByRole("alert")).toBeNull();
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

it("adds a work-date plan separately from actuals and keeps it editable at final review", async () => {
  const api = apiFixture();
  const table: BusinessAction = { ...action, fields: [
    { key: "actualEdits", label: "10/14 실적", type: "movements", required: true, rows: [] },
    { key: "planEdits", label: "10/15 계획", type: "movements", required: true, rows: [] },
  ], input: { values: {}, files: {} } };
  const view = render(<BusinessToolCard key={table.id} api={api} runId="run" action={table} />);
  const plan = within(screen.getByRole("group", { name: "10/15 계획 *" }));
  fireEvent.click(plan.getByRole("button", { name: "계획에 없는 거래 추가" }));
  fireEvent.change(plan.getByLabelText("추가 거래 적요"), { target: { value: "당일 추가 지급" } });
  fireEvent.change(plan.getByLabelText("추가 거래 거래처"), { target: { value: "추가 거래처" } });
  fireEvent.change(plan.getByLabelText("추가 거래 금액"), { target: { value: "5000" } });
  fireEvent.click(screen.getByRole("button", { name: "확인하고 계속" }));
  await waitFor(() => expect(api.submitBusinessInput).toHaveBeenCalledTimes(1));
  const submitted = vi.mocked(api.submitBusinessInput).mock.calls[0][2];
  expect(submitted.values.actualEdits).toBe("확인");
  expect(JSON.parse(submitted.values.planEdits)).toEqual({ changes: [], add: [{ direction: "out", description: "당일 추가 지급", party: "추가 거래처", amount: "5000" }] });
  const review: BusinessAction = { ...table, id: "review", input: submitted, fields: [...table.fields, { key: "review", label: "최종 확인", type: "text", required: true, confirm: "확인 ab12" }] };
  view.rerender(<BusinessToolCard key={review.id} api={api} runId="run" action={review} />);
  const reviewedPlan = within(screen.getByRole("group", { name: "10/15 계획 *" }));
  expect(reviewedPlan.getByLabelText("추가 거래 적요")).toHaveValue("당일 추가 지급");
  expect(reviewedPlan.getByLabelText("추가 거래 금액")).toHaveValue(5000);
  fireEvent.change(reviewedPlan.getByLabelText("추가 거래 금액"), { target: { value: "6000" } });
  fireEvent.click(screen.getByRole("button", { name: "확인하고 계속" }));
  await waitFor(() => expect(api.submitBusinessInput).toHaveBeenCalledTimes(2));
  const final = vi.mocked(api.submitBusinessInput).mock.calls[1][2];
  expect(JSON.parse(final.values.planEdits).add[0].amount).toBe("6000");
  expect(final.values.actualEdits).toBe("확인");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it.each(["invalid", "null", '{"unknown":{"incoming":"12","outgoing":"3"}}'])("collects cash totals through labels and recovers saved input %s", async (value) => {
  const api = apiFixture();
  const field = { key: "cashChanges", label: "계좌별 실제 입금·출금", type: "text" as const, required: true, cashRows: [{ key: "001:KRW", name: "기업은행", currency: "KRW", opening: "100", balance: "110" }, { key: "002:USD", name: "외화", currency: "USD", opening: "1", balance: "1" }] };
  render(<BusinessToolCard api={api} runId="run" action={{ ...action, fields: [field], input: { files: {}, values: { cashChanges: value } } }} />);
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  const incoming = screen.getByLabelText("001:KRW 실제 입금 총액") as HTMLInputElement;
  expect(incoming.checkValidity()).toBe(false);
  fireEvent.change(incoming, { target: { value: "-1" } }); expect(incoming.checkValidity()).toBe(false);
  fireEvent.change(incoming, { target: { value: "10.5" } }); expect(incoming.checkValidity()).toBe(true);
  fireEvent.change(screen.getByLabelText("001:KRW 실제 출금 총액"), { target: { value: "0.5" } });
  for (const label of ["입금", "출금"]) fireEvent.change(screen.getByLabelText(`002:USD 실제 ${label} 총액`), { target: { value: "0" } });
  fireEvent.click(screen.getByRole("button", { name: "확인하고 계속" }));
  await waitFor(() => expect(api.submitBusinessInput).toHaveBeenCalled());
  expect(JSON.parse(vi.mocked(api.submitBusinessInput).mock.calls[0][2].values.cashChanges)).toEqual({ "001:KRW": { incoming: "10.5", outgoing: "0.5" }, "002:USD": { incoming: "0", outgoing: "0" } });
});

it("previews the current result, retains it while running and targets the chosen revision", async () => {
  const api = apiFixture(), onRevise = vi.fn();
  const items = [
    { id: "old", runId: "one", name: "TGA_1.png", toolId: "excel_work", version: "0.4", revision: 1, preview: true },
    { id: "new", runId: "two", name: "TGA_2.png", toolId: "excel_work", version: "0.4", revision: 2, preview: true, baseArtifactId: "old", changes: ["오른쪽 눈금 간격: 0.2"] },
  ];
  vi.mocked(api.listBusinessArtifacts).mockResolvedValue(items);
  const view = render(<BusinessArtifacts api={api} threadId="thread" running={false} onRevise={onRevise} />);
  expect(await screen.findByRole("img", { name: /수정본 2 미리보기/ })).toHaveAttribute("src", "data:image/png;base64,fixture");
  expect(screen.getByText("오른쪽 눈금 간격: 0.2")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "이 결과 수정하기" }));
  expect(onRevise).toHaveBeenLastCalledWith("new");
  fireEvent.click(screen.getByRole("button", { name: "이전 버전에서 수정" }));
  expect(onRevise).toHaveBeenLastCalledWith("old");
  fireEvent.change(screen.getByRole("combobox", { name: "결과 버전" }), { target: { value: "one" } });
  expect(await screen.findByRole("img", { name: /수정본 1 미리보기/ })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "이 결과 수정하기" }));
  expect(onRevise).toHaveBeenLastCalledWith("old");
  view.rerender(<BusinessArtifacts api={api} threadId="thread" running onRevise={onRevise} />);
  expect(screen.getByRole("img", { name: /수정본 1 미리보기/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "이 결과 수정하기" })).toBeDisabled();
});

it("always exposes a new revision input and lets confirmed criteria expand without losing edits", async () => {
  const api = apiFixture();
  const revisionAction: BusinessAction = { ...action, revisionMode: true, fields: [
    { key: "request", label: "원래 요청", type: "text", required: true },
    { key: "revision", label: "수정 요청", type: "text", required: false },
  ], input: { files: {}, values: { request: "TGA 전체 측정값", revision: "" } } };
  render(<BusinessToolCard api={api} runId="run" action={revisionAction} />);
  expect(screen.getByLabelText("수정 요청")).toBeInTheDocument();
  expect(screen.queryByLabelText("원래 요청 *")).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("수정 요청"), { target: { value: "Tmax 표시" } });
  fireEvent.click(screen.getByRole("button", { name: "기준 변경" }));
  expect(screen.getByLabelText("원래 요청 *")).toHaveValue("TGA 전체 측정값");
  expect(screen.getByLabelText("수정 요청")).toHaveValue("Tmax 표시");
});
