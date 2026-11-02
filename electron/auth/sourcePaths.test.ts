// @vitest-environment node
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { assertPublicSources } from "./sourcePaths.ts";

const mock = vi.hoisted(() => ({ realpathError: "" }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, realpath: (...args: Parameters<typeof fs.realpath>) => {
    if (mock.realpathError) return Promise.reject(Object.assign(new Error(mock.realpathError), { code: mock.realpathError }));
    return fs.realpath(...args);
  } };
});
afterEach(() => { mock.realpathError = ""; });

it.each(["", "EISDIR"])("protects private data and resolves public sources with native realpath error '%s'", async (error) => {
  mock.realpathError = error;
  const base = await mkdtemp(join(tmpdir(), "private-source-"));
  const root = join(base, "app");
  await mkdir(join(root, "accounts", "b"), { recursive: true });
  const publicFolder = join(base, "work"); await mkdir(publicFolder);
  const link = join(base, "alias"); await symlink(root, link, "junction");
  try {
    await expect(assertPublicSources(root, [root])).rejects.toThrow("앱 데이터");
    await expect(assertPublicSources(root, [join(root, "accounts", "b")])).rejects.toThrow("앱 데이터");
    await expect(assertPublicSources(root, [base])).rejects.toThrow("앱 데이터");
    await expect(assertPublicSources(root, [link])).rejects.toThrow("앱 데이터");
    await expect(assertPublicSources(root, [publicFolder])).resolves.toBeUndefined();
    await expect(assertPublicSources(root, [join(base, "missing.xlsx")])).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await rm(base, { recursive: true, force: true }); }
});

it.each(["EACCES", "ENOENT"])("propagates native realpath %s errors", async (code) => {
  mock.realpathError = code;
  await expect(assertPublicSources(tmpdir(), [tmpdir()])).rejects.toMatchObject({ code });
});
