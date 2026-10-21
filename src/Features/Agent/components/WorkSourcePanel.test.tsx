import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, expect, it, vi } from "vitest";
import WorkSourcePanel from "./WorkSourcePanel";
import type { SourceProfile, WorkSourceAPI, WorkbookOverview } from "@app-types/WorkSource.types";

beforeAll(() => { HTMLDialogElement.prototype.showModal = function () { this.open = true; }; });
const overview: WorkbookOverview = { fingerprint: "hash", sheet: "자료", sheets: [{ name: "자료", rowCount: 2, columnCount: 1, hidden: false }], headers: [{ column: 1, text: "계좌" }], rows: [{ row: 1, cells: [{ address: "A1", text: "계좌", formula: false }] }] };

it("connects local files, saves only a checked mapping, and invalidates the preview after editing", async () => {
  const source = { id: "source", name: "source.xlsx", displayPath: "/local/source.xlsx", kind: "file" as const };
  const file = { sourceId: "source", name: "source.xlsx", relativePath: "" };
  let savedProfiles: SourceProfile[] = [];
  const api: WorkSourceAPI = {
    listWorkSources: vi.fn().mockResolvedValue([source]), submitWorkSelection: vi.fn(), pickWorkSources: vi.fn().mockResolvedValue([source]), pickWorkFiles: vi.fn().mockResolvedValue([]), removeWorkSource: vi.fn(),
    listWorkFiles: vi.fn().mockResolvedValue([file]), inspectWorkFile: vi.fn().mockResolvedValue(overview),
    listSourceProfiles: vi.fn().mockImplementation(async () => savedProfiles), removeSourceProfile: vi.fn(),
    previewSourceMapping: vi.fn().mockResolvedValue({ fingerprint: "hash", scannedRows: 1, matchedRows: 1, excludedRows: 0, blankRows: 0, issueCount: 0, issues: [], rows: [{ row: 2, values: { accountId: "00123" }, cells: { accountId: "A2" } }] }),
    saveSourceProfile: vi.fn().mockImplementation(async (_file, _hash, profile) => { const saved = { ...profile, id: "saved", revision: 1 }; savedProfiles = [saved]; return saved; }),
  };
  render(<WorkSourcePanel api={api} request={{ runId: "run", actionId: "action" }} onClose={vi.fn()} />);
  await screen.findByRole("option", { name: "/local/source.xlsx" });
  fireEvent.change(screen.getByLabelText("연결된 자료"), { target: { value: "source" } });
  await screen.findByRole("option", { name: "source.xlsx" });
  fireEvent.change(screen.getByLabelText("작업 파일"), { target: { value: JSON.stringify(file) } });
  await screen.findByLabelText("계좌번호");
  fireEvent.change(screen.getByLabelText("계좌번호"), { target: { value: "계좌" } });
  fireEvent.change(screen.getByLabelText("매핑 이름"), { target: { value: "ERP" } });
  expect(screen.getByRole("button", { name: "검증한 매핑 저장" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "추출 검증" }));
  await screen.findByText("00123");
  await waitFor(() => expect(screen.getByRole("button", { name: "검증한 매핑 저장" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "검증한 매핑 저장" }));
  await waitFor(() => expect(api.saveSourceProfile).toHaveBeenCalledWith(file, "hash", expect.objectContaining({ name: "ERP" })));
  await waitFor(() => expect(screen.getByLabelText("데이터 시작 행")).toBeEnabled());
  await waitFor(() => expect(screen.getByRole("button", { name: "이 자료로 계속" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "이 자료로 계속" }));
  await waitFor(() => expect(api.submitWorkSelection).toHaveBeenCalledWith("run", "action", { file, fingerprint: "hash", profileId: "saved", profileRevision: 1 }));
  await waitFor(() => expect(screen.getByLabelText("데이터 시작 행")).toBeEnabled());
  fireEvent.change(screen.getByLabelText("데이터 시작 행"), { target: { value: "3" } });
  expect(screen.getByRole("button", { name: "검증한 매핑 저장" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "이 자료로 계속" })).toBeDisabled();
  expect(screen.queryByText("00123")).not.toBeInTheDocument();
});
