// 서버가 table 블록의 text에 넣어 보내는 마크다운 표 문자열 파서.
// 실제로 관측된 두 형태를 모두 지원한다.
// 1) 실제 줄바꿈("\n")으로 행이 구분된 표준 GFM 표, 임의 개수의 컬럼
// 2) 행 구분과 셀 내부 줄바꿈이 모두 "<br>"로 표시된 표
// 컬럼 개수를 특정 값으로 가정하지 않고, delimiter(--- 구분) 행 앞의 행을 header로 취급한다.

export interface ContractTableGrid {
  header: string[] | null;
  rows: string[][];
}

const BREAK_TOKEN_PATTERN = /<br\s*\/?>|\n/gi;
const DELIMITER_CELL_PATTERN = /^:?-+:?$/;

const splitIntoRowLines = (text: string): string[] => {
  const rowLines: string[] = [];
  let buffer = "";

  text.split(BREAK_TOKEN_PATTERN).forEach((chunk) => {
    buffer = buffer ? `${buffer}\n${chunk}` : chunk;
    // "|"로 끝나는 조각까지 왔을 때만 한 행이 완성된 것으로 본다.
    // 그 전까지의 구분자는 같은 셀 안의 줄바꿈이다.
    if (buffer.trim().endsWith("|")) {
      rowLines.push(buffer.trim());
      buffer = "";
    }
  });
  if (buffer.trim()) rowLines.push(buffer.trim());

  return rowLines;
};

const toRowCells = (rowLine: string): string[] =>
  rowLine
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());

const isDelimiterRow = (cells: string[]): boolean =>
  cells.length > 0 && cells.every((cell) => DELIMITER_CELL_PATTERN.test(cell));

// grid → 마크다운 표 문자열. 셀 내부 줄바꿈은 <br>로 표기해 GFM 행 구조를 유지한다.
export const serializeContractTableGrid = ({
  header,
  rows,
}: ContractTableGrid): string => {
  const toLine = (cells: string[]) =>
    `| ${cells.map((cell) => cell.replace(/\n/g, "<br>")).join(" | ")} |`;
  const lines = rows.map(toLine);
  if (header) {
    lines.unshift(toLine(header), `| ${header.map(() => "---").join(" | ")} |`);
  }
  return lines.join("\n");
};

// 표 문법이 아닌 경우(구분자 "|"가 없는 일반 문단 등)에는 빈 grid를 반환한다.
export const parseContractTableGrid = (text: string): ContractTableGrid => {
  if (!text.includes("|")) return { header: null, rows: [] };

  const parsedRows = splitIntoRowLines(text).map(toRowCells);
  const delimiterIndex = parsedRows.findIndex(isDelimiterRow);

  if (delimiterIndex === -1) {
    return { header: null, rows: parsedRows };
  }

  return {
    header: parsedRows[delimiterIndex - 1] ?? null,
    rows: parsedRows.filter(
      (_, index) => index !== delimiterIndex && index !== delimiterIndex - 1,
    ),
  };
};
