// @vitest-environment node
import { describe, expect, it } from "vitest";
import { addBlock, assignIds, deleteBlock, extractTerms, fillTerms, reorderBlocks, setParties, validateSourceRefs, type CanvasPayload } from "./tree.ts";

const draft = (): CanvasPayload =>
  assignIds({
    metadata: { title: "용역 계약서", parties: [{ label: "갑", role: "client", name: "A사" }] },
    sections: [
      { section_type: "preamble", title: "전문", blocks: [{ text: "갑 {{갑 회사명}}과 을은 {계약 기간} 동안 계약한다.", source_refs: ["c1", "ghost"] }] },
      { title: "제1조", blocks: [{ text: "대금은 {{계약 금액}}으로 한다." }, { text: "지급일은 {{계약 금액}} 확정 후 정한다." }] },
    ],
    missing_terms: [{ label: "계약 금액", description: "총 용역 대금" }],
  });

describe("canvas tree helpers", () => {
  it("assigns deterministic ids and defaults", () => {
    const payload = draft();
    expect(payload.sections.map((section) => section.section_id)).toEqual(["sec_001", "sec_002"]);
    expect(payload.sections[1].blocks.map((block) => block.block_id)).toEqual(["blk_002_001", "blk_002_002"]);
    expect(payload.sections[1].section_type).toBe("article");
    expect(payload.sections[0].blocks[0].block_type).toBe("paragraph");
  });

  it("extracts terms from tokens (canonicalizing {x} → {{x}}) and fills them", () => {
    const payload = extractTerms(draft());
    expect(payload.missing_terms.map((term) => term.label)).toEqual(["갑 회사명", "계약 기간", "계약 금액"]);
    expect(payload.missing_terms[2]).toEqual({ label: "계약 금액", description: "총 용역 대금", block_ids: ["blk_002_001", "blk_002_002"] });
    expect(payload.sections[0].blocks[0].text).toContain("{{계약 기간}}");
    expect(fillTerms(payload, [{ label: "계약 금액".normalize("NFD"), value: "1,000만원" }])).toBe(true);
    expect(payload.sections[1].blocks[0].text).toBe("대금은 1,000만원으로 한다.");
    expect(payload.missing_terms.map((term) => term.label)).toEqual(["갑 회사명", "계약 기간"]);
    expect(fillTerms(payload, [{ label: "없음", value: "x" }])).toBe(false);
  });

  it("adds, deletes, and reorders blocks", () => {
    const payload = draft();
    const id = addBlock(payload, { text: "새 조항" }, { afterBlockId: "blk_002_001" });
    expect(id).toBe("blk_002_003");
    expect(payload.sections[1].blocks.map((block) => block.block_id)).toEqual(["blk_002_001", "blk_002_003", "blk_002_002"]);
    expect(reorderBlocks(payload, ["blk_002_002"])).toBe(true);
    expect(payload.sections[1].blocks.map((block) => block.block_id)).toEqual(["blk_002_002", "blk_002_001", "blk_002_003"]);
    expect(deleteBlock(payload, "blk_002_003")).toBe(true);
    expect(deleteBlock(payload, "nope")).toBe(false);
  });

  it("merges parties by label and drops hallucinated source refs", () => {
    const payload = draft();
    expect(setParties(payload, [{ label: "갑", address: "서울" }, { label: "을", name: "B사" }])).toBe(true);
    expect(payload.metadata.parties).toEqual([{ label: "갑", role: "client", name: "A사", address: "서울" }, { label: "을", name: "B사" }]);
    expect(setParties(payload, [{ label: "을", name: "B사" }])).toBe(false);
    validateSourceRefs(payload, new Map([["c1", { chunk_id: "c1", document_id: "d1", document_name: "표준 계약서.md", score: 0.9 }]]));
    expect(payload.sections[0].blocks[0].source_refs).toEqual([{ chunk_id: "c1", document_id: "d1", document_name: "표준 계약서.md", score: 0.9 }]);
  });
});
