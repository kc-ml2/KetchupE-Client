// @vitest-environment node
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openAgentDb } from "../db/openAgentDb.ts";
import { WorkSources } from "./sources.ts";
import { listProfiles, saveProfile } from "./profiles.ts";

const mock = vi.hoisted(() => ({ realpathError: "" }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, realpath: (...args: Parameters<typeof fs.realpath>) => {
    if (mock.realpathError) return Promise.reject(Object.assign(new Error(mock.realpathError), { code: mock.realpathError }));
    return fs.realpath(...args);
  } };
});

describe.each(["", "EISDIR"])("work sources with native realpath error '%s'", (error) => {
let folder: string; let db: DatabaseSync; let sources: WorkSources;
beforeEach(async () => { mock.realpathError = error; folder = await mkdtemp(join(tmpdir(), "work-source-")); db = openAgentDb(":memory:"); sources = new WorkSources(db); });
afterEach(async () => { mock.realpathError = ""; db.close(); await rm(folder, { recursive: true, force: true }); });

it("does not bypass permission or missing-file failures", async () => {
  const path = join(folder, "report.xlsx"); await writeFile(path, "original");
  for (const code of ["EACCES", "ENOENT"]) {
    mock.realpathError = code;
    await expect(sources.register([path], "file")).rejects.toMatchObject({ code });
  }
  mock.realpathError = error;
  await expect(sources.register([join(folder, "missing.xlsx")], "file")).rejects.toMatchObject({ code: "ENOENT" });
  await expect(sources.register([folder], "file")).rejects.toThrow("XLSX");
  expect(sources.list()).toEqual([]);
});

it("registers references without copying, discovers nested XLSX files and detects changed bytes", async () => {
  const root = join(folder, "selected"); await mkdir(join(root, "nested"), { recursive: true });
  await writeFile(join(root, "nested", "data.xlsx"), "first");
  await writeFile(join(root, "~$locked.xlsx"), "lock");
  const [source] = await sources.register([root], "folder");
  const files = await sources.files(source.id);
  expect(files.map((file) => file.name)).toEqual(["data.xlsx"]);
  const before = await sources.read(files[0]);
  await writeFile(join(root, "nested", "data.xlsx"), "second");
  expect((await sources.read(files[0])).fingerprint).not.toBe(before.fingerprint);
  expect((await sources.register([root], "folder"))).toHaveLength(1);
  sources.remove(source.id);
  await expect(sources.read(files[0])).rejects.toThrow("연결이 해제");
});

it("replaces a selected workbook only when its original fingerprint still matches", async () => {
  const path = join(folder, "report.xlsx"); await writeFile(path, "original");
  const [source] = await sources.register([path], "file"); const [file] = await sources.files(source.id);
  const original = await sources.read(file);
  await sources.replace(file, original.fingerprint, Buffer.from("updated"));
  expect(await readFile(path, "utf8")).toBe("updated");
  await writeFile(path, "changed elsewhere");
  await expect(sources.replace(file, original.fingerprint, Buffer.from("stale"))).rejects.toThrow("원본 파일이 변경");
  expect(await readFile(path, "utf8")).toBe("changed elsewhere");
});

it("rejects traversal, absolute paths, symlink escapes and sibling files outside a selected file", async () => {
  const root = join(folder, "selected"); await mkdir(root);
  const outside = join(folder, "private.xlsx"); await writeFile(outside, "outside");
  await symlink(outside, join(root, "linked.xlsx"));
  const [source] = await sources.register([root], "folder");
  for (const path of ["../private.xlsx", outside, "linked.xlsx"]) await expect(sources.read({ sourceId: source.id, relativePath: path, name: "ignored" })).rejects.toThrow();
  expect(await sources.files(source.id)).toEqual([]);
  const all = await sources.register([outside], "file");
  const fileSource = all.find((item) => item.kind === "file")!;
  await expect(sources.read({ sourceId: fileSource.id, relativePath: "other.xlsx", name: "ignored" })).rejects.toThrow();
});

it("persists mappings and rejects stale updates instead of overwriting a newer revision", () => {
  const profile = saveProfile(db, { id: "", revision: 0, name: "ERP", mapping: { sheet: "내역", headerRow: 1, firstDataRow: 2, columns: [{ field: "accountId", header: "계좌", type: "text", required: true }], filters: [] } }, "hash");
  expect(listProfiles(db)).toEqual([profile]);
  expect(saveProfile(db, profile, "hash").revision).toBe(2);
  expect(() => saveProfile(db, profile, "hash")).toThrow("변경되었거나");
});
});
