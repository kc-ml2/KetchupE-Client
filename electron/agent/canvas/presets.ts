// Document presets: a classified request gets a skeleton, guidance, schema version and party slots.
export type DocPreset = {
  id: string;
  label: string;
  schemaVersion: string;
  keywords: string[];
  sections: Array<{ section_type: string; title: string; guidance?: string }>;
  parties: Array<{ label: string; role: string; name: string; address: string; representative: string }>;
  guidance: string;
  /** Template family (all must appear in the file name) + markers (any must appear) identify standard documents to anchor on. */
  anchorFamily: string[];
  anchorMarkers: string[];
};

export const FREE_STRUCTURE = "(자유 구조)";
export const DEFAULT_DOC_LABEL = "문서";
export const TEMPLATE_MARKERS = ["표준", "양식", "서식", "template", "standard"];

export const DOC_PRESETS: Record<string, DocPreset> = {
  contract: {
    id: "contract",
    label: "계약서",
    schemaVersion: "contract.v1",
    keywords: ["계약", "계약서", "협약", "약정", "용역", "위탁", "contract"],
    sections: [
      { section_type: "preamble", title: "전문", guidance: "계약 당사자와 체결 배경" },
      { section_type: "article", title: "본문 조항", guidance: "목적·대금·기간·해지·손해배상 등 핵심 조항" },
      { section_type: "signature", title: "서명란", guidance: "갑·을 서명/날인" },
    ],
    parties: [
      { label: "갑", role: "client", name: "", address: "", representative: "" },
      { label: "을", role: "vendor", name: "", address: "", representative: "" },
    ],
    guidance: "갑/을 당사자를 명확히 구분하고, 금액·날짜·상대방 정보처럼 아직 확정되지 않은 값은 placeholder 블록으로 두고 missing_terms에 정리하라.",
    anchorFamily: ["계약"],
    anchorMarkers: TEMPLATE_MARKERS,
  },
  proposal: {
    id: "proposal",
    label: "기안서",
    schemaVersion: "proposal.v1",
    keywords: ["기안", "기안서", "품의", "결재", "proposal"],
    sections: [
      { section_type: "preamble", title: "제목/개요", guidance: "기안 제목과 목적" },
      { section_type: "article", title: "본문", guidance: "배경·내용·기대효과" },
      { section_type: "signature", title: "결재란", guidance: "기안/검토/승인" },
    ],
    parties: [],
    guidance: "결재 흐름을 고려해 간결하게 작성하고, 미정 항목은 missing_terms에 정리하라.",
    anchorFamily: ["기안"],
    anchorMarkers: TEMPLATE_MARKERS,
  },
  generic: {
    id: "generic",
    label: "문서",
    schemaVersion: "document.v1",
    keywords: [],
    sections: [],
    parties: [],
    guidance: "요청에 맞는 일반 문서를 의미 단위 섹션으로 작성하라.",
    anchorFamily: [],
    anchorMarkers: TEMPLATE_MARKERS,
  },
};

export const DEFAULT_PRESET_ID = "generic";

export const getPreset = (id?: string | null): DocPreset => DOC_PRESETS[id ?? ""] ?? DOC_PRESETS[DEFAULT_PRESET_ID];

export function scaffoldText(preset: DocPreset): string {
  if (!preset.sections.length) return FREE_STRUCTURE;
  return preset.sections.map((section) => `- ${section.title}(${section.section_type})${section.guidance ? `: ${section.guidance}` : ""}`).join("\n");
}

export const presetChoicesText = (): string =>
  Object.values(DOC_PRESETS).map((preset) => `- ${preset.id}: ${preset.label} (${preset.keywords.join(", ") || "기타/일반"})`).join("\n");

export function matchPresetByKeyword(instruction: string): string | undefined {
  const text = instruction.toLowerCase();
  return Object.values(DOC_PRESETS).find((preset) => preset.keywords.some((keyword) => text.includes(keyword.toLowerCase())))?.id;
}

/** Finds a preset id mentioned in the classifier's output. */
export function matchPresetId(text: string): string | undefined {
  const lower = text.trim().toLowerCase();
  return Object.keys(DOC_PRESETS).find((id) => lower.includes(id));
}
