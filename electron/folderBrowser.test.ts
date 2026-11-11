// @vitest-environment node
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { listFolder, resolveFolderPath, validateFolderPath } from "./folderBrowser.ts";

it("lists direct children, folders first, and blocks paths outside the registered root", async () => {
  const home = await mkdtemp(join(tmpdir(), "folder-browser-"));
  try {
    const root = join(home, "root");
    await mkdir(join(root, "하위 폴더"), { recursive: true });
    await writeFile(join(root, "문서.txt"), "hello");
    await writeFile(join(home, "secret.txt"), "private");
    await symlink(home, join(root, "escape"));
    const listing = await listFolder(root, "");
    expect(listing.entries.map((entry) => entry.name)).toEqual(["하위 폴더", "문서.txt"]);
    expect(listing.entries[1].size).toBe(5);
    expect(await listFolder(root, "하위 폴더")).toEqual({ entries: [], truncated: false });
    await expect(resolveFolderPath(root, "escape/secret.txt")).rejects.toThrow();
    await expect(resolveFolderPath(root, "../secret.txt")).rejects.toThrow();
  } finally { await rm(home, { recursive: true, force: true }); }
});

it("marks system files, unsupported JSON and ignored subtrees as excluded", async () => {
  const root = await mkdtemp(join(tmpdir(), "folder-policy-"));
  try {
    await writeFile(join(root, ".DS_Store"), "metadata");
    await writeFile(join(root, "data.json"), "{}");
    await writeFile(join(root, "readme.md"), "# hello");
    await mkdir(join(root, "node_modules"));
    await writeFile(join(root, "node_modules", "readme.md"), "# excluded");
    const listing = await listFolder(root, "");
    expect(listing.entries.find((entry) => entry.name === ".DS_Store")?.searchStatus).toBe("ignored");
    expect(listing.entries.find((entry) => entry.name === "data.json")).toMatchObject({ searchStatus: "ignored", statusReason: expect.stringContaining(".json") });
    expect(listing.entries.find((entry) => entry.name === "readme.md")?.searchStatus).toBe("pending");
    expect((await listFolder(root, "node_modules")).entries[0].searchStatus).toBe("ignored");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.each(["/etc/passwd", "../outside", "a/../../outside", "C:/secret", "a\\..\\secret", "a\0b"])("rejects unsafe input %s", (path) => {
  expect(() => validateFolderPath(path)).toThrow();
});
