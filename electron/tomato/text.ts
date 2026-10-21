// Shared text helpers; kept dependency-free so the main process can use them without loading kordoc.
export const CJK_RUN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uff66-\uff9f]+/gu;

export function estimateTokens(text: string): number {
  const cjk = text.match(CJK_RUN)?.join("").length ?? 0;
  const other = text.replace(CJK_RUN, "").trim().length;
  return cjk + Math.ceil(other / 4);
}

/** qmd's MIT-licensed CJK FTS approach: split CJK runs into per-character tokens. */
export function normalizeCjkForFts(text: string): string {
  return text.replace(CJK_RUN, (run) => ` ${Array.from(run).join(" ")} `).replace(/\s+/g, " ").trim();
}
