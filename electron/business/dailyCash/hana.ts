import { createHash } from "node:crypto";
import { date, decimal } from "./values.ts";
export const HANA_URL = "https://www.kebhana.com/cms/rate/wpfxd651_01i_01.do";
export type Rates = { date: string; requestedDate: string; round: string; publishedAt: string; source: string; fetchedAt: string; responseHash: string; perUnit: Record<"USD" | "JPY" | "CNY", string> };
const plain = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/\s+/g, " ").trim();
export function parseHana(html: string, requestedDate: string): Rates {
  const box = html.match(/<p[^>]*class=["']txtRateBox["'][^>]*>([\s\S]*?)<\/p>/)?.[1];
  const content = plain(box ?? "");
  const basis = content.match(/기준일\s*:\s*(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/);
  const round = content.match(/\((\d+)회차\)/)?.[1];
  if (!basis || !round || !/매매[\s\S]*기준율/.test(html)) throw new Error("하나은행 응답 형식이 변경되었거나 고시가 없습니다.");
  const basisDate = date(`${basis[1]}-${basis[2].padStart(2, "0")}-${basis[3].padStart(2, "0")}`);
  const perUnit = {} as Rates["perUnit"];
  for (const code of ["USD", "JPY", "CNY"] as const) {
    const rows = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => [...m[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((td) => plain(td[1]))).filter((cells) => new RegExp(`\\b${code}\\b`).test(cells[0] ?? ""));
    if (rows.length !== 1 || rows[0].length !== 11 || (code === "JPY" && !/\(100\)/.test(rows[0][0]))) throw new Error(`하나은행 ${code} 행/단위를 확인할 수 없습니다.`);
    const quote = decimal(rows[0][8], `하나은행 ${code}`);
    if (quote.lte(0)) throw new Error(`하나은행 ${code} 고시값 오류`);
    perUnit[code] = quote.div(code === "JPY" ? 100 : 1).toString();
  }
  return { date: basisDate, requestedDate, round, publishedAt: content.split("고시일시")[1]?.split("조회시각")[0]?.replace(/^\s*:\s*/, "").trim() ?? "", source: HANA_URL, fetchedAt: new Date().toISOString(), responseHash: createHash("sha256").update(html).digest("hex"), perUnit };
}
export async function fetchHana(reportDate: string, signal: AbortSignal): Promise<Rates> {
  date(reportDate);
  const response = await fetch(HANA_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ajax: "true", curCd: "", inqStrDt: reportDate.replaceAll("-", ""), tmpInqStrDt: reportDate, pbldDvCd: "0", pbldSqn: "" }), signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]), redirect: "error" });
  if (!response.ok || !response.body) throw new Error(`하나은행 조회 실패 (${response.status})`);
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try { while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 1024 * 1024) throw new Error("환율 응답 크기 초과"); chunks.push(value); } }
  finally { await reader.cancel(); }
  return parseHana(Buffer.concat(chunks).toString("utf8"), reportDate);
}
