import PptxGenJS from "pptxgenjs";
import JSZip from "jszip";
import sharp from "sharp";
import { PDFiumLibrary } from "@hyzyla/pdfium";
import { ExcelError } from "./limits.ts";

export const MAX_REPORT_IMAGES = 10;
export type ReportImage = { bytes: Uint8Array; title: string; description: string };

/** Table reports use bounded PDF pages, retaining all rows instead of clipping a long screenshot. */
export async function reportPageImages(pdf: Uint8Array, signal: AbortSignal): Promise<Uint8Array[]> {
  const library = await PDFiumLibrary.init();
  try {
    const document = await library.loadDocument(pdf);
    try {
      if (document.getPageCount() > MAX_REPORT_IMAGES) throw new ExcelError("LIMIT", `이미지는 최대 ${MAX_REPORT_IMAGES}페이지입니다. 범위를 줄이거나 PDF로 저장해 주세요.`);
      const images: Uint8Array[] = [];
      for (let i = 0; i < document.getPageCount(); i++) {
        signal.throwIfAborted();
        const page = document.getPage(i);
        if (page.getOriginalSize().originalWidth * page.getOriginalSize().originalHeight * 4 > 16000000) throw new ExcelError("LIMIT", "출력 이미지 크기가 너무 큽니다.");
        const image = await page.render({ scale: 2, render: async ({ data, width, height }) => sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer() });
        images.push(image.data);
      }
      return images;
    } finally { document.destroy(); }
  } finally { library.destroy(); }
}

export async function renderPptx(images: ReportImage[], signal: AbortSignal): Promise<Uint8Array> {
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "KetchupE";
  pptx.subject = "엑셀 분석 결과";
  pptx.title = images[0]?.title ?? "엑셀 분석";
  const textStyle = { fontFace: process.platform === "darwin" ? "Apple SD Gothic Neo" : "Malgun Gothic", lang: "ko-KR" };
  pptx.theme = { headFontFace: textStyle.fontFace, bodyFontFace: textStyle.fontFace };
  for (const image of images) {
    signal.throwIfAborted();
    const slide = pptx.addSlide();
    slide.background = { color: "FFFFFF" };
    slide.addText(image.title, { ...textStyle, x: .4, y: .15, w: 12.5, h: .65, fontSize: 22, bold: true, breakLine: false, fit: "shrink", margin: 0 });
    const data = `image/png;base64,${Buffer.from(image.bytes).toString("base64")}`;
    const meta = await sharp(image.bytes).metadata();
    const ratio = Math.min(12.3 / meta.width!, 5.7 / meta.height!);
    const w = meta.width! * ratio, h = meta.height! * ratio;
    slide.addImage({ data, x: (13.333 - w) / 2, y: .9 + (5.7 - h) / 2, w, h });
    const chunks = image.description.match(/[\s\S]{1,360}/g) ?? [];
    slide.addText(chunks.shift() ?? "", { ...textStyle, x: .5, y: 6.65, w: 12.3, h: .7, fontSize: 12, margin: 0, fit: "shrink" });
    for (let i = 0; i < chunks.length; i += 4) {
      const continuation = pptx.addSlide();
      continuation.addText(`${image.title} · 설명`, { ...textStyle, x: .5, y: .3, w: 12.3, h: .7, fontSize: 22, fit: "shrink" });
      continuation.addText(chunks.slice(i, i + 4).join(""), { ...textStyle, x: .5, y: 1.2, w: 12.3, h: 5.8, fontSize: 16, fit: "shrink" });
    }
  }
  signal.throwIfAborted();
  const bytes = await pptx.write({ outputType: "nodebuffer" });
  signal.throwIfAborted();
  return new Uint8Array(bytes as Buffer);
}

export async function validateImageExport(name: string, bytes: Uint8Array): Promise<boolean> {
  if (name.endsWith(".png")) {
    const image = sharp(bytes, { limitInputPixels: 16000000 });
    const metadata = await image.metadata();
    if (metadata.format !== "png" || !metadata.width || !metadata.height) throw new Error("PNG 이미지를 읽을 수 없습니다.");
    await image.stats();
    return true;
  }
  if (name.endsWith(".pptx")) {
    const zip = await JSZip.loadAsync(bytes);
    if (!zip.file("[Content_Types].xml") || !zip.file("ppt/presentation.xml") || !zip.file(/^ppt\/slides\/slide\d+\.xml$/).length || !zip.file(/^ppt\/media\//).length) throw new Error("PowerPoint 파일 구조가 올바르지 않습니다.");
    return true;
  }
  return false;
}
