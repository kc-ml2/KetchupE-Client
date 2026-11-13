import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { KetchupEAgentAPI } from "@app-types/Agent.types";
import FolderPanel from "./FolderPanel";

it("navigates folders, shows file details and reveals files without search checkboxes", async () => {
  const api = { onCollectionsChanged: vi.fn(() => () => undefined),
    listMaruStorages: vi.fn().mockResolvedValue([{ storageId: "remote", name: "공용 문서", active: false }]),
    browseFolder: vi.fn().mockResolvedValueOnce({ entries: [{ name: "하위", path: "하위", kind: "directory" }], truncated: false })
      .mockResolvedValueOnce({ entries: [{ name: "자료.txt", path: "하위/자료.txt", kind: "file", size: 5 }], truncated: false }),
    revealFolderFile: vi.fn().mockResolvedValue(undefined),
    openLocalFolderFile: vi.fn().mockResolvedValue(undefined),
  } as unknown as KetchupEAgentAPI;
  render(<FolderPanel api={api} workspaceId="default" collections={[{ name: "local", path: "/docs/계약서", active: false, sources: 1, chunks: 1, embedded: 1, syncing: false }]} error={null} onAdd={vi.fn()} onRemove={vi.fn()} onSync={vi.fn()} />);
  await screen.findByRole("button", { name: "공용 문서" });
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /계약서 검색/ }));
  fireEvent.click(await screen.findByRole("button", { name: "하위" }));
  fireEvent.click(await screen.findByRole("button", { name: "자료.txt" }));
  expect(api.openLocalFolderFile).not.toHaveBeenCalled();
  fireEvent.doubleClick(screen.getByRole("button", { name: "자료.txt" }));
  fireEvent.keyDown(screen.getByRole("button", { name: "자료.txt" }), { key: "Enter" });
  expect(api.openLocalFolderFile).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "열기" }));
  await waitFor(() => expect(api.openLocalFolderFile).toHaveBeenCalledWith(expect.objectContaining({ kind: "local", id: "local", path: "하위/자료.txt" })));
  await waitFor(() => expect(screen.getByRole("button", { name: "파일 위치 보기" })).toBeEnabled());
  expect(screen.getByRole("button", { name: "자료.txt" })).toHaveClass("select-none", "bg-blue-50");
  fireEvent.click(screen.getByRole("button", { name: "파일 위치 보기" }));
  await waitFor(() => expect(api.revealFolderFile).toHaveBeenCalledWith(expect.objectContaining({ kind: "local", id: "local", path: "하위/자료.txt" })));
  const list = screen.getByRole("region", { name: "파일 목록" });
  const details = screen.getByRole("region", { name: "파일 정보" });
  expect(screen.getByRole("button", { name: "자료.txt", pressed: true })).toHaveClass("border-blue-400", "bg-blue-50");
  expect(list).toHaveClass("overflow-y-auto", "flex-1");
  expect(details).toHaveClass("shrink-0", "overflow-y-auto");
  expect(list).not.toContainElement(details);
  expect(list.parentElement).toBe(details.parentElement);
  fireEvent.click(screen.getByRole("button", { name: "파일 정보 닫기" }));
  expect(screen.queryByRole("region", { name: "파일 정보" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "자료.txt", pressed: false })).not.toHaveClass("bg-blue-50");
});

it("marks failed local files and their parent folders, then clears badges after recovery", async () => {
  const api = { onCollectionsChanged: vi.fn(() => () => undefined), retryFolderFile: vi.fn().mockResolvedValue(undefined), listMaruStorages: vi.fn().mockResolvedValue([]), browseFolder: vi.fn()
    .mockResolvedValueOnce({ entries: [{ name: "하위", path: "하위", kind: "directory", counts: { searchable: 4, failed: 1 } }, { name: "정상.txt", path: "정상.txt", kind: "file" }], truncated: false })
    .mockResolvedValueOnce({ entries: [{ name: "실패.pdf", path: "하위/실패.pdf", kind: "file" }], truncated: false }) } as unknown as KetchupEAgentAPI;
  const collection = { name: "docs", path: "/docs", active: true, sources: 1, chunks: 1, embedded: 1, syncing: false, lastError: "파싱 실패", syncCounts: { succeeded: 34, failed: 2 }, failedFiles: [{ path: "하위/실패.pdf", error: "PDF_INVALID: 읽기 실패" }] };
  const props = { api, workspaceId: "default", error: null, onAdd: vi.fn(), onRemove: vi.fn(), onSync: vi.fn() };
  const view = render(<FolderPanel {...props} collections={[collection]} />);
  expect(screen.getByRole("img", { name: "오류 있음" })).not.toHaveAttribute("title");
  expect(screen.getByLabelText("검색 가능한 문서 1개")).toBeInTheDocument();
  expect(screen.getByLabelText("오류 문서 1개")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /docs/ }));
  const folder = await screen.findByRole("button", { name: /하위/ });
  expect(screen.queryByText("파싱 실패")).not.toBeInTheDocument();
  expect(folder).not.toHaveAttribute("title");
  expect(folder.querySelector('[role="img"]')).not.toHaveClass("opacity-60");
  expect(folder.querySelector("svg")).not.toHaveClass("opacity-45");
  expect(screen.getByLabelText("검색 가능한 문서 4개")).toBeInTheDocument();
  expect(screen.getByLabelText("오류 문서 1개")).toBeInTheDocument();
  expect(screen.getAllByRole("img", { name: "오류 있음" })).toHaveLength(1);
  fireEvent.click(folder);
  const file = await screen.findByRole("button", { name: /실패.pdf/ });
  expect(file).toHaveAttribute("title", expect.stringContaining("PDF_INVALID"));
  expect(screen.queryByText("확인 필요")).not.toBeInTheDocument();
  expect(screen.queryByText("오류")).not.toBeInTheDocument();
  fireEvent.click(file);
  expect(screen.getByText("오류")).toBeInTheDocument();
  expect(screen.getAllByRole("alert").some((item) => item.textContent?.includes("PDF_INVALID"))).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "재시도" }));
  await waitFor(() => expect(api.retryFolderFile).toHaveBeenCalledWith({ kind: "local", id: "docs", path: "하위/실패.pdf" }));
  expect(props.onSync).not.toHaveBeenCalled();
  view.rerender(<FolderPanel {...props} collections={[{ ...collection, lastError: undefined, failedFiles: [] }]} />);
  expect(screen.queryByRole("img", { name: "오류 있음" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "재시도" })).not.toBeInTheDocument();
});

it("cancels selection without removing folders and disconnects only checked folders", async () => {
  const api = { onCollectionsChanged: vi.fn(() => () => undefined), listMaruStorages: vi.fn().mockResolvedValue([]) } as unknown as KetchupEAgentAPI;
  const onRemove = vi.fn().mockResolvedValue(undefined);
  const collections = ["one", "two"].map((name) => ({ name, path: `/docs/${name}`, active: true, sources: 1, chunks: 1, embedded: 1, syncing: false }));
  render(<FolderPanel api={api} workspaceId="default" collections={collections} error={null} onAdd={vi.fn()} onRemove={onRemove} onSync={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "연결 해제" }));
  expect(screen.getByRole("button", { name: "확인" })).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox", { name: "/docs/one 연결 해제 선택" }));
  fireEvent.click(screen.getByRole("button", { name: "취소" }));
  expect(onRemove).not.toHaveBeenCalled();
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "연결 해제" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "/docs/two 연결 해제 선택" }));
  fireEvent.click(screen.getByRole("button", { name: "확인" }));
  await waitFor(() => expect(onRemove).toHaveBeenCalledExactlyOnceWith("two"));
  await waitFor(() => expect(screen.queryByRole("checkbox")).not.toBeInTheDocument());
});

it("keeps failed disconnections selected for retry without repeating successful ones", async () => {
  const api = { onCollectionsChanged: vi.fn(() => () => undefined), listMaruStorages: vi.fn().mockResolvedValue([]) } as unknown as KetchupEAgentAPI;
  const onRemove = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("failure")).mockResolvedValue(undefined);
  const collections = ["one", "two"].map((name) => ({ name, path: `/docs/${name}`, active: true, sources: 1, chunks: 1, embedded: 1, syncing: false }));
  render(<FolderPanel api={api} workspaceId="default" collections={collections} error={null} onAdd={vi.fn()} onRemove={onRemove} onSync={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "연결 해제" }));
  for (const checkbox of screen.getAllByRole("checkbox")) fireEvent.click(checkbox);
  fireEvent.click(screen.getByRole("button", { name: "확인" }));
  await screen.findByRole("alert");
  expect(screen.getByRole("checkbox", { name: "/docs/one 연결 해제 선택" })).not.toBeChecked();
  expect(screen.getByRole("checkbox", { name: "/docs/two 연결 해제 선택" })).toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: "확인" }));
  await waitFor(() => expect(onRemove.mock.calls.map(([name]) => name)).toEqual(["one", "two", "two"]));
});

it("shows ignored file status and explains why JSON is not searchable", async () => {
  const api = { onCollectionsChanged: vi.fn(() => () => undefined), listMaruStorages: vi.fn().mockResolvedValue([]), browseFolder: vi.fn().mockResolvedValue({ entries: [{ name: "data.json", path: "data.json", kind: "file", searchStatus: "ignored", statusReason: "검색을 지원하지 않는 파일 형식입니다: .json" }, { name: "note.md", path: "note.md", kind: "file", searchStatus: "searchable" }, { name: "ready", path: "ready", kind: "directory", counts: { searchable: 3, failed: 0 } }, { name: "empty", path: "empty", kind: "directory", counts: { searchable: 0, failed: 0 } }], truncated: false }) } as unknown as KetchupEAgentAPI;
  render(<FolderPanel api={api} workspaceId="default" collections={[{ name: "docs", path: "/docs", sources: 1, chunks: 1, embedded: 1, active: true, syncing: false }]} error={null} onAdd={vi.fn()} onRemove={vi.fn()} onSync={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: /docs/ }));
  fireEvent.click(await screen.findByRole("button", { name: "검색 제외 data.json" }));
  expect(screen.getByText(/검색을 지원하지 않는 파일 형식입니다: .json/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "검색 가능 note.md" })).toBeInTheDocument();
  const readyFolder = screen.getByRole("button", { name: /검색 가능 ready/ });
  const readyFile = screen.getByRole("button", { name: "검색 가능 note.md" });
  expect(readyFolder.querySelector('[role="img"]')).not.toHaveClass("opacity-60");
  expect(readyFile.querySelector('[role="img"]')).not.toHaveClass("opacity-60");
  expect(readyFolder).toHaveClass("h-44", "justify-start");
  expect(readyFile).toHaveClass("h-44", "justify-start");
  for (const badge of screen.getAllByRole("img", { name: "검색 제외" })) {
    expect(badge.parentElement?.querySelector("svg")).toHaveClass("opacity-45");
    expect(badge.parentElement).not.toHaveClass("opacity-45");
  }
  expect(screen.getByRole("button", { name: /검색 제외 empty/ })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "재시도" })).not.toBeInTheDocument();
});

it("shows pending and then analyzing for newly registered folders", async () => {
  const api = { onCollectionsChanged: vi.fn(() => () => undefined), listMaruStorages: vi.fn().mockResolvedValue([]) } as unknown as KetchupEAgentAPI;
  const collection = { name: "new", path: "/new", sources: 0, chunks: 0, embedded: 0, active: true, syncing: false, analysisStatus: "pending" as const };
  const props = { api, workspaceId: "default", error: null, onAdd: vi.fn(), onRemove: vi.fn(), onSync: vi.fn() };
  const view = render(<FolderPanel {...props} collections={[collection]} />);
  expect(screen.getByText(/분석 대기 중/)).toBeInTheDocument();
  view.rerender(<FolderPanel {...props} collections={[{ ...collection, syncing: true, analysisStatus: "analyzing" }]} />);
  expect(screen.getByText(/분석 중/)).toBeInTheDocument();
  expect(screen.queryByText(/분석 대기 중/)).not.toBeInTheDocument();
  await screen.findByText("접근 가능한 공유 저장소가 없습니다.");
});

it("shows remote browse failures and lets the user retry", async () => {
  const api = { onCollectionsChanged: vi.fn(() => () => undefined), listMaruStorages: vi.fn().mockResolvedValue([{ storageId: "remote", name: "공용 문서" }]), browseFolder: vi.fn().mockRejectedValueOnce(new Error("denied")).mockResolvedValueOnce({ entries: [], truncated: false }) } as unknown as KetchupEAgentAPI;
  render(<FolderPanel api={api} workspaceId="default" collections={[]} error={null} onAdd={vi.fn()} onRemove={vi.fn()} onSync={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "공용 문서" }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "파일 목록 새로고침" }));
  await screen.findByText("비어 있는 폴더입니다.");
});
