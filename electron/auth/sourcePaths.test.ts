// @vitest-environment node
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { assertPublicSources } from "./sourcePaths.ts";

it("blocks importing another account, the shared parent, and symlinks into private data", async () => {
  const base = await mkdtemp(join(tmpdir(), "private-source-"));
  const root = join(base, "app");
  await mkdir(join(root, "accounts", "b"), { recursive: true });
  const publicFolder = join(base, "work"); await mkdir(publicFolder);
  const link = join(base, "alias"); await symlink(root, link, "junction");
  try {
    await expect(assertPublicSources(root, [join(root, "accounts", "b")])).rejects.toThrow("앱 데이터");
    await expect(assertPublicSources(root, [base])).rejects.toThrow("앱 데이터");
    await expect(assertPublicSources(root, [link])).rejects.toThrow("앱 데이터");
    await expect(assertPublicSources(root, [publicFolder])).resolves.toBeUndefined();
  } finally { await rm(base, { recursive: true, force: true }); }
});
