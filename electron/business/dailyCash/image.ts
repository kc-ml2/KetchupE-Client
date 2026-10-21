import sharp from "sharp";
import type ExcelJS from "exceljs";
import { raw } from "./values.ts";
const escape = (v: string) => v.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const colour = (argb?: string, fallback = "#ffffff") => argb && /^[A-Fa-f0-9]{6,8}$/.test(argb) ? `#${argb.slice(-6)}` : fallback;
/** Render the visible report cells (including merges and hidden rows/columns), not a redesigned summary. */
export async function renderSheet(sheet: ExcelJS.Worksheet, lastRow: number): Promise<Uint8Array> {
  // The report body is A:M, but the 사업부문 자금현황표(KC) side table sits further right (O:P); include every column that holds a value.
  let lastCol = 13;
  sheet.eachRow((row, r) => { if (r <= lastRow) row.eachCell((cell, c) => { const value = raw(cell); if (value != null && value !== "" && c > lastCol) lastCol = c; }); });
  const widths = Array.from({ length: lastCol }, (_, i) => sheet.getColumn(i + 1).hidden ? 0 : Math.round((sheet.getColumn(i + 1).width ?? 10) * 7 + 5));
  const heights = Array.from({ length: lastRow }, (_, i) => sheet.getRow(i + 1).hidden ? 0 : Math.round((sheet.getRow(i + 1).height ?? 15) * 4 / 3));
  const xs = [0], ys = [0]; widths.forEach((w) => xs.push(xs.at(-1)! + w)); heights.forEach((h) => ys.push(ys.at(-1)! + h));
  const width = xs.at(-1)!, height = ys.at(-1)!;
  if (width * height > 24000000 || !width || !height) throw new Error("일보 이미지 크기를 확인하세요.");
  const merges = sheet.model.merges.map((range) => { const [a, b] = range.split(":").map((v) => sheet.getCell(v)); return { top: Number(a.row), bottom: Number(b.row), left: Number(a.col), right: Number(b.col) }; });
  const parts: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="white"/>`];
  for (let r = 1; r <= lastRow; r++) for (let c = 1; c <= lastCol; c++) {
    if (!widths[c - 1] || !heights[r - 1]) continue;
    const cell = sheet.getCell(r, c); if (cell.isMerged && cell.master.address !== cell.address) continue;
    const merge = merges.find((m) => m.top === r && m.left === c);
    const x = xs[c - 1], y = ys[r - 1], w = xs[Math.min(merge?.right ?? c, lastCol)] - x, h = ys[Math.min(merge?.bottom ?? r, lastRow)] - y;
    const fill = cell.fill?.type === "pattern" ? colour(cell.fill.fgColor?.argb) : "#ffffff";
    parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"/>`);
    for (const [side, coords] of Object.entries({ top: [x, y, x + w, y], bottom: [x, y + h, x + w, y + h], left: [x, y, x, y + h], right: [x + w, y, x + w, y + h] })) {
      const edge = cell.border?.[side as "top" | "bottom" | "left" | "right"];
      if (edge?.style) parts.push(`<line x1="${coords[0]}" y1="${coords[1]}" x2="${coords[2]}" y2="${coords[3]}" stroke="${colour(edge.color?.argb, "#777777")}" stroke-width="${edge.style === "medium" || edge.style === "thick" ? 2 : 1}"/>`);
    }
    const value = raw(cell); if (value == null || value === "") continue;
    const number = typeof value === "number";
    const decimals = number ? (cell.numFmt?.split(";")[0]?.match(/\.([0#]+)/)?.[1].length ?? 0) : 0;
    const display = number ? value.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) : String(value);
    const size = Math.min((cell.font?.size ?? 10) * 4 / 3, 24); const right = cell.alignment?.horizontal === "right" || (number && cell.alignment?.horizontal !== "center"); const center = cell.alignment?.horizontal === "center";
    const tx = right ? x + w - 4 : center ? x + w / 2 : x + 4;
    const lines: string[] = [];
    for (const line of display.split("\n")) {
      if (!cell.alignment?.wrapText || number) { lines.push(line); continue; }
      let part = "", units = 0;
      for (const char of line) { const step = /[^\x00-\x7f]/.test(char) ? 1 : 0.55; if (units + step > (w - 8) / size && part) { lines.push(part); part = ""; units = 0; } part += char; units += step; } lines.push(part);
    }
    const fit = number ? Math.min(size, (w - 8) / Math.max(display.length * 0.57, 1)) : size;
    const clip = `c${r}_${c}`;
    parts.push(`<clipPath id="${clip}"><rect x="${x + 2}" y="${y + 1}" width="${Math.max(0, w - 4)}" height="${Math.max(0, h - 2)}"/></clipPath><text clip-path="url(#${clip})" font-family="Noto Sans KR, Apple SD Gothic Neo, Malgun Gothic, sans-serif" font-size="${fit}" font-weight="${cell.font?.bold ? 700 : 400}" fill="${colour(cell.font?.color?.argb, "#222222")}" text-anchor="${right ? "end" : center ? "middle" : "start"}">`);
    lines.forEach((line, i) => parts.push(`<tspan x="${tx}" y="${y + Math.max(size, (h - lines.length * size * 1.12) / 2 + size * 0.85) + i * size * 1.12}">${escape(line)}</tspan>`)); parts.push("</text>");
  }
  parts.push("</svg>");
  return sharp(Buffer.from(parts.join("")), { density: 144, limitInputPixels: 96000000 }).png().toBuffer();
}
