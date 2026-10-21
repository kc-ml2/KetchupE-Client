// Pure canvas-tree helpers, ported from MARU services/canvas.py. They mutate a payload in place;
// the flow deep-copies the head version, applies one op, then persists the result as the next version.
import type { CanvasPartyValue } from "../../../src/app-types/CanvasEdit.types.ts";

export type CanvasBlock = {
  block_id: string;
  block_type: string;
  text?: string;
  meta_data?: Record<string, unknown>;
  source_refs?: SourceRef[];
  [key: string]: unknown;
};

export type CanvasSection = {
  section_id: string;
  section_type: string;
  title: string;
  order: number;
  metadata: Record<string, unknown>;
  blocks: CanvasBlock[];
  [key: string]: unknown;
};

export type SourceRef = { chunk_id: string; document_id: string; document_name: string; score?: number | null; section_title?: string };

export type MissingTerm = { label: string; description: string; block_ids: string[] };

export type CanvasPayload = {
  metadata: { title?: string; contract_type?: string; parties?: CanvasPartyValue[]; [key: string]: unknown };
  sections: CanvasSection[];
  missing_terms: MissingTerm[];
};

export const emptyPayload = (): CanvasPayload => ({ metadata: {}, sections: [], missing_terms: [] });

const pad = (n: number) => String(n).padStart(3, "0");

export function* iterBlocks(payload: CanvasPayload): Generator<[CanvasSection, CanvasBlock]> {
  for (const section of payload.sections) for (const block of section.blocks) yield [section, block];
}

export function findBlock(payload: CanvasPayload, blockId: string): [CanvasSection, CanvasBlock] | undefined {
  for (const pair of iterBlocks(payload)) if (pair[1].block_id === blockId) return pair;
  return undefined;
}

const blockText = (block: CanvasBlock): string => (typeof block.text === "string" ? block.text : "");

/** Normalizes an LLM-produced tree: deterministic ids, defaults, order. */
export function assignIds(raw: Record<string, unknown>): CanvasPayload {
  const sections = Array.isArray(raw.sections) ? (raw.sections as Array<Record<string, unknown>>) : [];
  const normalized: CanvasSection[] = sections.map((section, sectionIndex) => {
    const blocks = Array.isArray(section.blocks) ? (section.blocks as Array<Record<string, unknown>>) : [];
    return {
      ...section,
      section_id: `sec_${pad(sectionIndex + 1)}`,
      section_type: typeof section.section_type === "string" ? section.section_type : "article",
      title: typeof section.title === "string" ? section.title : "",
      order: sectionIndex + 1,
      metadata: section.metadata && typeof section.metadata === "object" ? (section.metadata as Record<string, unknown>) : {},
      blocks: blocks.map((block, blockIndex) => ({
        ...block,
        block_id: `blk_${pad(sectionIndex + 1)}_${pad(blockIndex + 1)}`,
        block_type: typeof block.block_type === "string" ? block.block_type : "paragraph",
        text: typeof block.text === "string" ? block.text : block.text === undefined ? "" : String(block.text),
        meta_data: block.meta_data && typeof block.meta_data === "object" ? (block.meta_data as Record<string, unknown>) : {},
        source_refs: Array.isArray(block.source_refs) ? (block.source_refs as SourceRef[]) : [],
      })),
    };
  });
  return {
    metadata: raw.metadata && typeof raw.metadata === "object" ? (raw.metadata as CanvasPayload["metadata"]) : {},
    sections: normalized,
    missing_terms: Array.isArray(raw.missing_terms) ? (raw.missing_terms as MissingTerm[]) : [],
  };
}

function nextBlockId(section: CanvasSection): string {
  const suffix = section.section_id.split("_").at(-1) ?? "000";
  const used = new Set(section.blocks.map((block) => block.block_id));
  let n = section.blocks.length + 1;
  while (used.has(`blk_${suffix}_${pad(n)}`)) n += 1;
  return `blk_${suffix}_${pad(n)}`;
}

export function setBlockText(payload: CanvasPayload, blockId: string, text: string, sourceRefs?: SourceRef[]): boolean {
  const found = findBlock(payload, blockId);
  if (!found) return false;
  found[1].text = text;
  if (sourceRefs !== undefined) found[1].source_refs = sourceRefs;
  return true;
}

export function addBlock(
  payload: CanvasPayload,
  block: Partial<CanvasBlock>,
  options: { afterBlockId?: string; sectionId?: string } = {},
): string | undefined {
  if (!payload.sections.length) return undefined;
  let target: CanvasSection | undefined;
  let insertAt: number | undefined;
  if (options.afterBlockId !== undefined) {
    for (const section of payload.sections) {
      const index = section.blocks.findIndex((candidate) => candidate.block_id === options.afterBlockId);
      if (index >= 0) {
        target = section;
        insertAt = index + 1;
        break;
      }
    }
  }
  if (!target && options.sectionId !== undefined) target = payload.sections.find((section) => section.section_id === options.sectionId);
  target ??= payload.sections.at(-1);
  if (!target) return undefined;
  const created: CanvasBlock = {
    block_type: "paragraph",
    meta_data: {},
    source_refs: [],
    text: "",
    ...block,
    block_id: nextBlockId(target),
  };
  target.blocks.splice(insertAt ?? target.blocks.length, 0, created);
  return created.block_id;
}

export function deleteBlock(payload: CanvasPayload, blockId: string): boolean {
  for (const section of payload.sections) {
    const index = section.blocks.findIndex((block) => block.block_id === blockId);
    if (index >= 0) {
      section.blocks.splice(index, 1);
      return true;
    }
  }
  return false;
}

/** Listed ids first in the given order; unlisted blocks keep their relative order afterwards. */
export function reorderBlocks(payload: CanvasPayload, orderedIds: string[], sectionId?: string): boolean {
  const section = sectionId !== undefined
    ? payload.sections.find((candidate) => candidate.section_id === sectionId)
    : orderedIds.length ? findBlock(payload, orderedIds[0])?.[0] : undefined;
  if (!section) return false;
  const byId = new Map(section.blocks.map((block) => [block.block_id, block]));
  const listed = orderedIds.map((id) => byId.get(id)).filter((block): block is CanvasBlock => Boolean(block));
  const set = new Set(orderedIds);
  section.blocks = [...listed, ...section.blocks.filter((block) => !set.has(block.block_id))];
  return true;
}

const PARTY_FIELDS = ["name", "address", "representative", "role"] as const;

/** Merge party fields by label (갑/을); unknown labels are appended. */
export function setParties(payload: CanvasPayload, parties: CanvasPartyValue[]): boolean {
  if (!parties.length) return false;
  const existing = (payload.metadata.parties ??= []);
  const byLabel = new Map(existing.filter((party) => party.label).map((party) => [party.label, party]));
  let changed = false;
  for (const incoming of parties) {
    if (!incoming || typeof incoming !== "object" || !incoming.label) continue;
    let target = byLabel.get(incoming.label);
    if (!target) {
      target = { label: incoming.label };
      existing.push(target);
      byLabel.set(incoming.label, target);
      changed = true;
    }
    for (const field of PARTY_FIELDS) {
      if (field in incoming && incoming[field] !== target[field]) {
        target[field] = incoming[field];
        changed = true;
      }
    }
  }
  return changed;
}

const nfc = (value: string) => value.normalize("NFC");
const TERM_TOKEN = /\{{1,2}([^{}]+?)\}{1,2}/g;

/** Every spelling a term placeholder may have: {{label}} / {label}, NFC and NFD. Double-brace forms first. */
function termTokens(label: string): string[] {
  const canonical = nfc(label);
  const tokens: string[] = [];
  for (const token of [`{{${canonical}}}`, `{${canonical}}`]) {
    tokens.push(token);
    const nfd = token.normalize("NFD");
    if (nfd !== token) tokens.push(nfd);
  }
  return tokens;
}

/** Derives missing_terms from the placeholder tokens actually present in block text and canonicalizes them to {{label}}. */
export function extractTerms(payload: CanvasPayload): CanvasPayload {
  const priorDescription = new Map(
    payload.missing_terms.filter((term) => term && term.label).map((term) => [nfc(term.label), term.description ?? ""]),
  );
  const order: string[] = [];
  const blockIds = new Map<string, string[]>();
  for (const [, block] of iterBlocks(payload)) {
    const text = blockText(block);
    const canonical = text.replace(TERM_TOKEN, (_match, raw: string) => {
      const label = nfc(raw.trim());
      if (!blockIds.has(label)) {
        blockIds.set(label, []);
        order.push(label);
      }
      const ids = blockIds.get(label)!;
      if (!ids.includes(block.block_id)) ids.push(block.block_id);
      return `{{${label}}}`;
    });
    if (canonical !== text) block.text = canonical;
  }
  payload.missing_terms = order.map((label) => ({ label, description: priorDescription.get(label) ?? "", block_ids: blockIds.get(label) ?? [] }));
  return payload;
}

/** Replaces {{label}} tokens with values and drops those labels from missing_terms. */
export function fillTerms(payload: CanvasPayload, terms: Array<{ label: string; value: string }>): boolean {
  const values = new Map(terms.filter((term) => term && term.label).map((term) => [nfc(term.label), term.value ?? ""]));
  if (!values.size) return false;
  let changed = false;
  for (const [label, value] of values) {
    const tokens = termTokens(label);
    for (const [, block] of iterBlocks(payload)) {
      let text = blockText(block);
      for (const token of tokens) {
        if (text.includes(token)) {
          text = text.split(token).join(value);
          changed = true;
        }
      }
      block.text = text;
    }
  }
  const kept = payload.missing_terms.filter((term) => !values.has(nfc(term.label ?? "")));
  if (kept.length !== payload.missing_terms.length) {
    payload.missing_terms = kept;
    changed = true;
  }
  return changed;
}

/** All blocks as `[block_id] text` lines, for the block-edit prompt. */
export function documentContext(payload: CanvasPayload): string {
  return [...iterBlocks(payload)].map(([, block]) => `[${block.block_id}] ${blockText(block)}`).join("\n");
}

/** Replaces chunk-id strings on blocks with enriched refs, dropping hallucinated ids. */
export function validateSourceRefs(payload: CanvasPayload, references: Map<string, SourceRef>): void {
  for (const [, block] of iterBlocks(payload)) {
    const raw = Array.isArray(block.source_refs) ? (block.source_refs as unknown[]) : [];
    block.source_refs = raw
      .map((item) => references.get(typeof item === "string" ? item : String((item as { chunk_id?: unknown })?.chunk_id ?? "")))
      .filter((ref): ref is SourceRef => Boolean(ref))
      .map((ref) => ({ chunk_id: ref.chunk_id, document_id: ref.document_id, document_name: ref.document_name, score: ref.score ?? null }));
  }
}

/** Parties still missing a name — surfaced so the client can prompt for them. */
export function incompleteParties(payload: CanvasPayload): CanvasPartyValue[] {
  return (payload.metadata.parties ?? []).filter((party) => !(party.name ?? "").trim());
}
