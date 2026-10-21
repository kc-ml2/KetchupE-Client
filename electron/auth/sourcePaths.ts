import { realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return !isAbsolute(path) && path !== ".." && !path.startsWith("../") && !path.startsWith("..\\");
}

/** Imported folders must not turn the app's private account stores into searchable documents. */
export async function assertPublicSources(root: string, paths: string[]): Promise<void> {
  const privateRoot = await realpath(root);
  for (const path of paths) {
    const source = await realpath(path);
    if (contains(privateRoot, source) || contains(source, privateRoot)) {
      throw new Error("앱 데이터 폴더 또는 이를 포함하는 폴더는 업무 자료로 등록할 수 없습니다.");
    }
  }
}
