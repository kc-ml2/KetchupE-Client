// @vitest-environment node
// Office/PDF/HWP fixtures go through KorDoc; this test generates a DOCX and an XLSX-free table markdown
// to check that structure and locators survive parse → chunk → index → search.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Document, Packer, Paragraph, HeadingLevel, Table, TableCell, TableRow } from "docx";
import { afterAll, beforeAll, expect, it } from "vitest";
import { parseSource, Tomato } from "./tomato.ts";

let temporary: string;
let tomato: Tomato;

beforeAll(async () => {
  temporary = await mkdtemp(join(tmpdir(), "tomato-formats-"));
  const documents = join(temporary, "docs");
  await mkdir(documents);
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({ text: "출장 규정", heading: HeadingLevel.HEADING_1 }),
        new Paragraph({ text: "숙박비", heading: HeadingLevel.HEADING_2 }),
        new Paragraph("국내 출장 숙박비는 1박당 십만원 한도로 실비 정산한다."),
        new Table({
          rows: [
            new TableRow({ children: [new TableCell({ children: [new Paragraph("지역")] }), new TableCell({ children: [new Paragraph("한도")] })] }),
            new TableRow({ children: [new TableCell({ children: [new Paragraph("서울")] }), new TableCell({ children: [new Paragraph("십이만원")] })] }),
          ],
        }),
      ],
    }],
  });
  await writeFile(join(documents, "travel.docx"), await Packer.toBuffer(doc));
  await writeFile(join(documents, "notes.txt"), "회의록\n\n다음 분기 예산은 삼천만원이다.\n");
  tomato = new Tomato(join(temporary, "home"));
  await tomato.registerCollection(documents, "formats");
});

afterAll(async () => {
  await rm(temporary, { recursive: true, force: true });
});

it("indexes DOCX through KorDoc with breadcrumb and searches TXT", async () => {
  const status = await tomato.status();
  expect(status[0]).toMatchObject({ name: "formats", sources: 2 });
  const docx = await tomato.search("숙박비 한도", { collections: ["formats"], mode: "keyword" });
  expect(docx.results[0]?.relativePath).toBe("travel.docx");
  expect(docx.results[0]?.breadcrumb.length).toBeGreaterThan(0);
  const table = await tomato.search("십이만원", { collections: ["formats"], mode: "keyword" });
  expect(table.results[0]?.relativePath).toBe("travel.docx");
  const txt = await tomato.search("삼천만원", { collections: ["formats"], mode: "keyword" });
  expect(txt.results[0]?.relativePath).toBe("notes.txt");
});

it("replaces KorDoc's generic parse failure with an actionable format reason", async () => {
  await expect(parseSource("broken.pdf", Buffer.from("%PDF-1.7 broken"), "broken", "off"))
    .rejects.toThrow("PDF 문서 구조를 해석하지 못했습니다");
});
