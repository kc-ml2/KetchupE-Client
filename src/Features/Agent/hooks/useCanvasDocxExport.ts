import { useState } from "react";
import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import toast from "react-hot-toast";
import {
  ContractTableGrid,
  parseContractTableGrid,
} from "@lib/contractTableText";
import {
  ContractBlock,
  ContractCanvas,
  ContractSection,
  ContractTableCell,
} from "@app-types/Canvas.types";

const DEFAULT_FILE_TITLE = "contract";
const INVALID_FILENAME_CHARS = /[\\/:*?"<>|]/g;
const LABEL_COLUMN_WIDTH_PERCENT = 30;
const VALUE_COLUMN_WIDTH_PERCENT = 70;
const HEADING_TEXT_COLOR = "000000";

const getCanvasTitle = (canvas: ContractCanvas): string =>
  canvas.title || canvas.metadata?.title || DEFAULT_FILE_TITLE;

const toDocxFileName = (title: string): string => {
  const safeTitle =
    title.replace(INVALID_FILENAME_CHARS, "_").trim() || DEFAULT_FILE_TITLE;
  return `${safeTitle}.docx`;
};

// CanvasPanel의 표시 규칙과 동일: phase5 스펙 table 필드 또는 구버전 호환 {cell, value} 배열
const getBlockPairRows = (block: ContractBlock): ContractTableCell[][] => {
  if (block.table?.rows) return block.table.rows.map((row) => row.cells);
  if (Array.isArray(block.text)) return [block.text];
  return [];
};

// 개행이 포함된 본문은 docx에서 줄바꿈(TextRun break)으로 유지한다
const toTextRuns = (text: string): TextRun[] =>
  text
    .split("\n")
    .map((line, index) => new TextRun({ text: line, break: index > 0 ? 1 : 0 }));

const buildParagraph = (block: ContractBlock): Paragraph => {
  const text = typeof block.text === "string" ? block.text : "";
  const content = block.numbering ? `${block.numbering} ${text}` : text;
  return new Paragraph({
    children: toTextRuns(content),
    spacing: { after: 120 },
  });
};

const buildTable = (rows: ContractTableCell[][]): Table =>
  new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: rows.flatMap((row) =>
      row.map(
        (cell) =>
          new TableRow({
            children: [
              new TableCell({
                width: {
                  size: LABEL_COLUMN_WIDTH_PERCENT,
                  type: WidthType.PERCENTAGE,
                },
                children: [
                  new Paragraph({
                    children: [new TextRun({ text: cell.cell, bold: true })],
                  }),
                ],
              }),
              new TableCell({
                width: {
                  size: VALUE_COLUMN_WIDTH_PERCENT,
                  type: WidthType.PERCENTAGE,
                },
                children: [new Paragraph({ children: toTextRuns(cell.value) })],
              }),
            ],
          }),
      ),
    ),
  });

// 실제 서버가 table 블록 text에 보내는 마크다운 표 문자열 → 임의 열 개수의 grid를 docx 표로 변환
const buildGridTable = ({ header, rows }: ContractTableGrid): Table => {
  const columnCount = (header ?? rows[0] ?? []).length;
  const columnWidth = { size: 100 / columnCount, type: WidthType.PERCENTAGE };

  const buildRow = (cells: string[], bold: boolean): TableRow =>
    new TableRow({
      children: cells.map(
        (cell) =>
          new TableCell({
            width: columnWidth,
            children: [
              new Paragraph({ children: [new TextRun({ text: cell, bold })] }),
            ],
          }),
      ),
    });

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      ...(header ? [buildRow(header, true)] : []),
      ...rows.map((row) => buildRow(row, false)),
    ],
  });
};

const buildBlockContent = (block: ContractBlock): (Paragraph | Table)[] => {
  const pairRows = getBlockPairRows(block);
  if (pairRows.length > 0) return [buildTable(pairRows)];

  if (block.block_type === "table" && typeof block.text === "string") {
    const grid = parseContractTableGrid(block.text);
    if (grid.header || grid.rows.length > 0) return [buildGridTable(grid)];
  }

  if (block.block_type === "table") return [];

  return [buildParagraph(block)];
};

const buildSectionChildren = (
  section: ContractSection,
): (Paragraph | Table)[] => {
  const heading = [section.metadata?.article_no, section.title]
    .filter(Boolean)
    .join(" ");

  const children: (Paragraph | Table)[] = [
    new Paragraph({
      text: heading,
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 240, after: 120 },
    }),
  ];

  section.blocks.forEach((block) => {
    children.push(...buildBlockContent(block));
  });

  return children;
};

const buildMissingTermsChildren = (canvas: ContractCanvas): Paragraph[] => {
  if (canvas.missing_terms.length === 0) return [];
  return [
    new Paragraph({
      text: `작성이 필요한 항목 (${canvas.missing_terms.length})`,
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 240, after: 120 },
    }),
    ...canvas.missing_terms.map(
      (term) =>
        new Paragraph({
          text: `${term.label} — ${term.description}`,
          bullet: { level: 0 },
        }),
    ),
  ];
};

const buildContractDocument = (canvas: ContractCanvas): Document => {
  const orderedSections = [...canvas.sections].sort(
    (a, b) => a.order - b.order,
  );

  return new Document({
    styles: {
      paragraphStyles: [
        {
          id: "Heading1",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { color: HEADING_TEXT_COLOR, bold: true, size: 32 },
        },
        {
          id: "Heading2",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { color: HEADING_TEXT_COLOR, bold: true, size: 26 },
        },
      ],
    },
    sections: [
      {
        children: [
          new Paragraph({
            text: getCanvasTitle(canvas),
            heading: HeadingLevel.HEADING_1,
            alignment: AlignmentType.CENTER,
            spacing: { after: 360 },
          }),
          ...orderedSections.flatMap(buildSectionChildren),
          ...buildMissingTermsChildren(canvas),
        ],
      },
    ],
  });
};

const downloadBlob = (blob: Blob, fileName: string): void => {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
};

// Canvas(계약서 초안)를 .docx 파일로 변환해 다운로드한다
export const useCanvasDocxExport = () => {
  const [isExporting, setIsExporting] = useState(false);

  const exportCanvasToDocx = async (canvas: ContractCanvas): Promise<void> => {
    if (isExporting) return;
    setIsExporting(true);
    try {
      const blob = await Packer.toBlob(buildContractDocument(canvas));
      downloadBlob(blob, toDocxFileName(getCanvasTitle(canvas)));
    } catch (error) {
      console.error("docx export failed:", error);
      toast.error("docx 파일 내보내기에 실패했어요.");
    } finally {
      setIsExporting(false);
    }
  };

  return { isExporting, exportCanvasToDocx };
};
