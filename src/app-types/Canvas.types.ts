// Canvas 스키마 — contract.v1
// canvas = 계약서 전체, block = 제N조 안의 항/문단/표 (부분 수정의 최소 단위)
// 계약서는 조항(section) > 블록(block) 계층으로 구성된다

// RAG 참조 문서 (블록 생성 근거)
export interface CanvasSourceRef {
  chunk_id?: string;
  document_id: string;
  document_name: string;
  section_title?: string;
  score: number;
}

// table 블록의 행 (항목명 + 값)
export interface ContractTableCell {
  cell: string;
  value: string;
}

export interface ContractTableRow {
  cells: ContractTableCell[];
}

export interface ContractTable {
  rows: ContractTableRow[];
}

// 계약서 최소 단위. block_type: paragraph | table | list_item | signature_field 등
// text는 기존 서버 호환을 위해 table 블록의 {cell, value} 배열도 허용한다.
// 신규 table 블록은 table 필드를 우선 사용한다.
export interface ContractBlock {
  block_id: string;
  block_type: string;
  numbering?: string | null;
  text?: string | ContractTableCell[];
  table?: ContractTable;
  meta_data?: Record<string, unknown>;
  source_refs?: CanvasSourceRef[];
}

// 조항 단위. section_type: preamble | article | signature 등
export interface ContractSection {
  section_id: string;
  section_type: string;
  title: string;
  order: number;
  metadata: {
    article_no?: string;
    clause_type?: string;
  };
  source_refs?: CanvasSourceRef[];
  blocks: ContractBlock[];
}

// 계약 당사자 (갑/을)
export interface ContractParty {
  label: string;
  role: string;
  name: string;
  address: string;
  representative: string;
}

// 사용자 입력이 필요한 항목 ({계약금액} 등 미기재 placeholder)
export interface MissingTerm {
  term_key?: string;
  label: string;
  description: string;
  block_ids: string[];
}

export interface ContractCanvasMetadata {
  title: string;
  contract_type: string;
  parties: ContractParty[];
}

// Canvas 문서 전체 (버전 관리 포함)
export interface ContractCanvas {
  schema_version: string;
  canvas_type: string;
  canvas_id: string;
  version_id: string;
  base_version_id: string | null;
  status: string;
  title?: string;
  metadata: ContractCanvasMetadata;
  sections: ContractSection[];
  missing_terms: MissingTerm[];
}
