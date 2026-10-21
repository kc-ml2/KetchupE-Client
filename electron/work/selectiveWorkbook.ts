import { posix } from "node:path";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { DOMParser, XMLSerializer, type Document, type Element } from "@xmldom/xmldom";

const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE_REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const CONTENT = "http://schemas.openxmlformats.org/package/2006/content-types";
const xml = (doc: Document | Element) => new XMLSerializer().serializeToString(doc);
const children = (node: Element): Element[] => Array.from(node.childNodes).filter((n): n is Element => n.nodeType === 1);
const elements = (doc: Document | Element, name: string): Element[] => Array.from(doc.getElementsByTagNameNS("*", name));
function parse(value: string): Document {
  if (/<!DOCTYPE/i.test(value)) throw new Error("DOCTYPE이 포함된 XLSX XML은 지원하지 않습니다.");
  return new DOMParser({ onError: (level, message) => { if (level !== "warning") throw new Error(message); } }).parseFromString(value, "application/xml");
}
async function document(zip: JSZip, path: string) {
  const file = zip.file(path);
  if (!file) throw new Error(`XLSX 구성 파일이 없습니다: ${path}`);
  return parse(await file.async("string"));
}
const relPath = (path: string) => posix.join(posix.dirname(path), "_rels", `${posix.basename(path)}.rels`);
function targetPath(owner: string, target: string) {
  const path = posix.normalize(target.startsWith("/") ? target.slice(1) : posix.join(posix.dirname(owner), target));
  if (path.startsWith("../") || /[\\?#]/.test(path) || /^[a-z]+:/i.test(path)) throw new Error("잘못된 XLSX 내부 경로입니다.");
  return path;
}
function append(doc: Document, parent: Element, namespace: string, name: string, attrs: Record<string, string>) {
  const node = doc.createElementNS(namespace, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  parent.appendChild(node); return node;
}

/** Keeps archived sheets compressed; only the selected sheet enters ExcelJS. */
export class SelectiveWorkbook {
  private constructor(private readonly zip: JSZip, private readonly workbook: Document, private readonly relationships: Document) {}
  static async open(bytes: Uint8Array) {
    const zip = await JSZip.loadAsync(bytes);
    return new SelectiveWorkbook(zip, await document(zip, "xl/workbook.xml"), await document(zip, "xl/_rels/workbook.xml.rels"));
  }
  get sheetNames() { return elements(this.workbook, "sheet").map((sheet) => sheet.getAttribute("name")!); }
  private sheet(name: string) {
    const matches = elements(this.workbook, "sheet").filter((sheet) => sheet.getAttribute("name") === name);
    if (matches.length !== 1) throw new Error(`시트를 유일하게 찾을 수 없습니다: ${name}`);
    const node = matches[0];
    const relation = elements(this.relationships, "Relationship").find((r) => r.getAttribute("Id") === node.getAttributeNS(REL, "id"));
    if (!relation || !relation.getAttribute("Type")?.endsWith("/worksheet") || relation.getAttribute("TargetMode") === "External") throw new Error(`지원하지 않는 시트입니다: ${name}`);
    return { node, path: targetPath("xl/workbook.xml", relation.getAttribute("Target")!) };
  }
  async loadSheet(name: string): Promise<ExcelJS.Workbook> {
    const selected = this.sheet(name); const selectedIndex = this.sheetNames.indexOf(name);
    const subset = new JSZip(); const book = parse(xml(this.workbook));
    for (const sheet of elements(book, "sheet")) {
      if (sheet.getAttribute("name") !== name) sheet.parentNode!.removeChild(sheet);
      else { sheet.setAttribute("sheetId", "1"); sheet.setAttributeNS(REL, "r:id", "selectedSheet"); }
    }
    for (const item of elements(book, "definedName")) {
      if (item.getAttribute("localSheetId") !== String(selectedIndex)) item.parentNode!.removeChild(item);
      else item.setAttribute("localSheetId", "0");
    }
    const rels = parse(`<Relationships xmlns="${PACKAGE_REL}"/>`);
    append(rels, rels.documentElement!, PACKAGE_REL, "Relationship", { Id: "selectedSheet", Type: `${REL}/worksheet`, Target: "worksheets/sheet1.xml" });
    const copied = new Set<string>();
    const copy = async (path: string) => {
      if (copied.has(path)) return; copied.add(path);
      const file = this.zip.file(path); if (!file) throw new Error(`XLSX 구성 파일이 없습니다: ${path}`);
      subset.file(path, await file.async("uint8array"));
      if (this.zip.file(relPath(path))) {
        const related = await document(this.zip, relPath(path));
        subset.file(relPath(path), xml(related));
        for (const r of elements(related, "Relationship")) if (r.getAttribute("TargetMode") !== "External") await copy(targetPath(path, r.getAttribute("Target")!));
      }
    };
    for (const r of elements(this.relationships, "Relationship")) if (/\/(styles|sharedStrings|theme)$/.test(r.getAttribute("Type") ?? "")) {
      if (r.getAttribute("TargetMode") === "External") throw new Error("외부 XLSX 스타일은 지원하지 않습니다.");
      rels.documentElement!.appendChild(rels.importNode(r, true)); await copy(targetPath("xl/workbook.xml", r.getAttribute("Target")!));
    }
    // Worksheet relationships are relative to the same worksheets directory after renaming.
    await copy(selected.path);
    const sheetBytes = subset.file(selected.path)!; subset.remove(selected.path);
    subset.file("xl/worksheets/sheet1.xml", await sheetBytes.async("uint8array"));
    if (subset.file(relPath(selected.path))) {
      const relationships = await subset.file(relPath(selected.path))!.async("string"); subset.remove(relPath(selected.path));
      subset.file("xl/worksheets/_rels/sheet1.xml.rels", relationships);
    }
    subset.file("xl/workbook.xml", xml(book)); subset.file("xl/_rels/workbook.xml.rels", xml(rels));
    const result = new ExcelJS.Workbook();
    await result.xlsx.load(await subset.generateAsync({ type: "nodebuffer" }) as unknown as ExcelJS.Buffer);
    if (result.worksheets.length !== 1 || result.worksheets[0].name !== name) throw new Error("선택한 시트를 읽지 못했습니다.");
    return result;
  }

  async appendSheet(book: ExcelJS.Workbook, name: string): Promise<Uint8Array> {
    if (this.sheetNames.includes(name)) throw new Error(`${name} 시트가 이미 있습니다.`);
    const added = book.getWorksheet(name);
    if (!added) throw new Error(`추가할 시트가 없습니다: ${name}`);
    // Table names are workbook-global; cloning one would invalidate the preserved archive.
    if (added.getTables().length) throw new Error("일보 양식의 Excel 표는 복제할 수 없습니다. 표를 일반 셀 범위로 변환한 양식을 사용해 주세요.");
    // Inline strings avoid changing the original shared-string table and every archived cell index.
    const generated = await SelectiveWorkbook.open(new Uint8Array(await book.xlsx.writeBuffer()));
    const newSheet = generated.sheet(name);
    const strings = generated.zip.file("xl/sharedStrings.xml") ? elements(await document(generated.zip, "xl/sharedStrings.xml"), "si") : [];
    const styles = await mergeStyles(this.zip, generated.zip);
    const types = await document(this.zip, "[Content_Types].xml");
    if (!elements(this.relationships, "Relationship").some((r) => r.getAttribute("Type") === `${REL}/styles`)) {
      let id = 1; while (elements(this.relationships, "Relationship").some((r) => r.getAttribute("Id") === `rId${id}`)) id++;
      append(this.relationships, this.relationships.documentElement!, PACKAGE_REL, "Relationship", { Id: `rId${id}`, Type: `${REL}/styles`, Target: "styles.xml" });
    }
    if (!elements(types, "Override").some((n) => n.getAttribute("PartName") === "/xl/styles.xml")) append(types, types.documentElement!, CONTENT, "Override", { PartName: "/xl/styles.xml", ContentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml" });
    const generatedTypes = await document(generated.zip, "[Content_Types].xml");
    const paths = new Map<string, string>();
    const copy = async (path: string): Promise<string> => {
      if (paths.has(path)) return paths.get(path)!;
      let output = path; let suffix = 1;
      const ext = posix.extname(path); const stem = path.slice(0, -ext.length).replace(/\d+$/, "");
      while (this.zip.file(output) || this.zip.file(relPath(output))) output = `${stem}${suffix++}${ext}`;
      paths.set(path, output);
      const file = generated.zip.file(path); if (!file) throw new Error(`새 시트 구성 파일이 없습니다: ${path}`);
      if (path === newSheet.path) {
        const sheet = await document(generated.zip, path);
        for (const cell of elements(sheet, "c")) {
          cell.setAttribute("s", String(styles.cellXfs[Number(cell.getAttribute("s") || 0)]));
          if (cell.getAttribute("t") === "s") {
            const value = elements(cell, "v")[0]; const string = strings[Number(value?.textContent)];
            if (!string) throw new Error("새 시트의 공유 문자열이 없습니다.");
            cell.removeChild(value); cell.setAttribute("t", "inlineStr");
            const inline = append(sheet, cell, MAIN, "is", {});
            for (const child of Array.from(string.childNodes)) inline.appendChild(sheet.importNode(child, true));
          }
        }
        for (const row of elements(sheet, "row")) if (row.hasAttribute("s")) row.setAttribute("s", String(styles.cellXfs[Number(row.getAttribute("s"))]));
        for (const col of elements(sheet, "col")) col.setAttribute("style", String(styles.cellXfs[Number(col.getAttribute("style") || 0)]));
        for (const rule of elements(sheet, "cfRule")) if (rule.hasAttribute("dxfId")) rule.setAttribute("dxfId", String(styles.dxfs[Number(rule.getAttribute("dxfId"))]));
        this.zip.file(output, xml(sheet));
      } else this.zip.file(output, await file.async("uint8array"));
      const override = elements(generatedTypes, "Override").find((n) => n.getAttribute("PartName") === `/${path}`);
      if (override) append(types, types.documentElement!, CONTENT, "Override", { PartName: `/${output}`, ContentType: override.getAttribute("ContentType")! });
      else {
        const extension = ext.slice(1); const type = elements(generatedTypes, "Default").find((n) => n.getAttribute("Extension") === extension);
        if (type && !elements(types, "Default").some((n) => n.getAttribute("Extension") === extension)) types.documentElement!.appendChild(types.importNode(type, true));
      }
      if (generated.zip.file(relPath(path))) {
        const rels = await document(generated.zip, relPath(path));
        for (const r of elements(rels, "Relationship")) if (r.getAttribute("TargetMode") !== "External") {
          r.setAttribute("Target", posix.relative(posix.dirname(output), await copy(targetPath(path, r.getAttribute("Target")!))));
        }
        this.zip.file(relPath(output), xml(rels));
      }
      return output;
    };
    const path = await copy(newSheet.path);
    let id = 1; while (elements(this.relationships, "Relationship").some((r) => r.getAttribute("Id") === `rId${id}`)) id++;
    const relationId = `rId${id}`;
    append(this.relationships, this.relationships.documentElement!, PACKAGE_REL, "Relationship", { Id: relationId, Type: `${REL}/worksheet`, Target: posix.relative("xl", path) });
    const index = this.sheetNames.length;
    const sheetId = Math.max(...elements(this.workbook, "sheet").map((s) => Number(s.getAttribute("sheetId")))) + 1;
    const node = this.workbook.importNode(newSheet.node, true); node.setAttribute("sheetId", String(sheetId)); node.setAttributeNS(REL, "r:id", relationId);
    elements(this.workbook, "sheets")[0].appendChild(node);
    for (const defined of elements(generated.workbook, "definedName")) if (defined.getAttribute("localSheetId") === String(generated.sheetNames.indexOf(name))) {
      let names = elements(this.workbook, "definedNames")[0];
      if (!names) {
        names = this.workbook.createElementNS(MAIN, "definedNames");
        const following = ["calcPr", "oleSize", "customWorkbookViews", "pivotCaches", "smartTagPr", "smartTagTypes", "webPublishing", "fileRecoveryPr", "webPublishObjects", "extLst"];
        this.workbook.documentElement!.insertBefore(names, children(this.workbook.documentElement!).find((n) => following.includes(n.localName!)) ?? null);
      }
      const added = this.workbook.importNode(defined, true); added.setAttribute("localSheetId", String(index)); names.appendChild(added);
    }
    const calc = elements(this.workbook, "calcPr")[0] ?? append(this.workbook, this.workbook.documentElement!, MAIN, "calcPr", {});
    calc.setAttribute("fullCalcOnLoad", "1");
    this.zip.file("xl/workbook.xml", xml(this.workbook)); this.zip.file("xl/_rels/workbook.xml.rels", xml(this.relationships)); this.zip.file("[Content_Types].xml", xml(types));
    return this.zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  }
}

/** Append/deduplicate style records; existing indexes must never move. */
async function mergeStyles(original: JSZip, generated: JSZip) {
  const fresh = await document(generated, "xl/styles.xml");
  const old = original.file("xl/styles.xml") ? await document(original, "xl/styles.xml") : parse(xml(fresh));
  const order = ["numFmts", "fonts", "fills", "borders", "cellStyleXfs", "cellXfs", "cellStyles", "dxfs", "tableStyles", "colors", "extLst"];
  const table = (name: string) => {
    let node = elements(old, name)[0];
    if (!node) {
      node = old.createElementNS(MAIN, name);
      old.documentElement!.insertBefore(node, children(old.documentElement!).find((n) => order.indexOf(n.localName!) > order.indexOf(name)) ?? null);
    }
    return node;
  };
  const remap: Record<string, number[]> = {};
  const formats = new Map<number, number>();
  const oldFormats = table("numFmts");
  for (const format of elements(fresh, "numFmt").filter((n) => n.parentNode === elements(fresh, "numFmts")[0])) {
    const found = children(oldFormats).find((n) => n.getAttribute("formatCode") === format.getAttribute("formatCode"));
    const id = found ? Number(found.getAttribute("numFmtId")) : Math.max(163, ...children(oldFormats).map((n) => Number(n.getAttribute("numFmtId")))) + 1;
    formats.set(Number(format.getAttribute("numFmtId")), id);
    if (!found) { const added = old.importNode(format, true); added.setAttribute("numFmtId", String(id)); oldFormats.appendChild(added); }
  }
  oldFormats.setAttribute("count", String(children(oldFormats).length));
  for (const name of ["fonts", "fills", "borders", "cellStyleXfs", "cellXfs", "dxfs"]) {
    const destination = table(name); const source = elements(fresh, name)[0]; remap[name] = [];
    const existing = children(destination).map(xml);
    for (const item of source ? children(source) : []) {
      const added = old.importNode(item, true);
      if (name === "cellStyleXfs" || name === "cellXfs") {
        for (const [attr, category] of [["fontId", "fonts"], ["fillId", "fills"], ["borderId", "borders"], ["xfId", "cellStyleXfs"]]) if (added.hasAttribute(attr)) added.setAttribute(attr, String(remap[category][Number(added.getAttribute(attr))]));
        const id = Number(added.getAttribute("numFmtId")); if (formats.has(id)) added.setAttribute("numFmtId", String(formats.get(id)));
      }
      const serialized = xml(added); let index = existing.indexOf(serialized);
      if (index < 0) { index = existing.length; existing.push(serialized); destination.appendChild(added); }
      remap[name].push(index);
    }
    destination.setAttribute("count", String(children(destination).length));
  }
  original.file("xl/styles.xml", xml(old));
  return remap;
}
