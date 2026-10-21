import type { Evidence } from "./contracts.ts";

export const CITATION_PATTERN = /\[\[(e\d+)\]\]/g;

export type CitationCheck = { valid: string[]; invalid: string[] };

/** Deterministic invariant: every [[eN]] in the answer must be an evidence id issued in this run. */
export function validateCitations(text: string, evidence: Evidence[]): CitationCheck {
  const known = new Set(evidence.map((item) => item.evidenceId));
  const valid = new Set<string>();
  const invalid = new Set<string>();
  for (const match of text.matchAll(CITATION_PATTERN)) (known.has(match[1]) ? valid : invalid).add(match[1]);
  return { valid: [...valid], invalid: [...invalid] };
}

/** One deterministic repair: drop unknown citations. Anything still wrong afterwards is INVALID_CITATION. */
export function stripInvalidCitations(text: string, invalid: string[]): string {
  const drop = new Set(invalid);
  return text.replace(CITATION_PATTERN, (whole, id: string) => (drop.has(id) ? "" : whole)).replace(/[ \t]+([.,;:!?])/g, "$1");
}
