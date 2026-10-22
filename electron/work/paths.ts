import { realpath as legacyRealpath } from "node:fs";
import { realpath as nativeRealpath } from "node:fs/promises";
import { promisify } from "node:util";

const resolveRealpath = promisify(legacyRealpath);

export async function realpath(path: string): Promise<string> {
  try { return await nativeRealpath(path); }
  catch (error) {
    // Windows network drives can reject native realpath with EISDIR; still resolve and check links.
    if ((error as NodeJS.ErrnoException).code !== "EISDIR") throw error;
    return resolveRealpath(path);
  }
}
