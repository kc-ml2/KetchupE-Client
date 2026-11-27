// Summarises results.jsonl files from scripts/plot-eval/run.ts into a markdown table (criteria 1–3).
//   npx vite-node scripts/plot-eval/summary.ts outputs/plot-eval/results.jsonl [more.jsonl ...]
import { readFile } from "node:fs/promises";

type Turn = { turn: number; status: string; pass: boolean; ms: number; modelCalls: number; promptTokens: number; completionTokens: number; autoAnswers: number; askReasons?: string[]; checks?: { pass: boolean | null }[] };
type Row = { id: string; set: string; status: string; pass?: boolean; turns: Turn[] };

const median = (xs: number[]) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pct = (a: number, b: number) => b ? `${(100 * a / b).toFixed(0)}% (${a}/${b})` : "—";
const fmt = (x: number) => Number.isFinite(x) ? x.toFixed(0) : "—";

const rows: Row[] = [];
for (const file of process.argv.slice(2)) for (const line of (await readFile(file, "utf8")).split("\n")) if (line.trim()) rows.push(JSON.parse(line));

const lines = ["| 세트 | 케이스 | 입력 미지원 | ① 전체 통과 | ① 실행 가능분 통과 | 검사 항목 통과 | ② 첫 턴 시간 중앙값(ms) | ② 첫 턴 토큰 중앙값(입력+출력) | ② 첫 턴 호출 수 중앙값 | 되묻기 | ③ 수정 턴 통과 | ③ 수정 턴 시간 중앙값(ms) | ③ 수정 턴 토큰 중앙값 |", "|" + " --- |".repeat(13)];
for (const set of [...new Set(rows.map(r => r.set))]) {
  const all = rows.filter(r => r.set === set), runnable = all.filter(r => r.status !== "input_unsupported");
  const first = runnable.map(r => r.turns[0]).filter(Boolean), later = runnable.flatMap(r => r.turns.slice(1));
  const checks = runnable.flatMap(r => r.turns.flatMap(t => t.checks ?? [])).filter(c => c.pass !== null);
  lines.push(`| ${set} | ${all.length} | ${all.length - runnable.length} | ${pct(all.filter(r => r.pass).length, all.length)} | ${pct(runnable.filter(r => r.pass).length, runnable.length)} | ${pct(checks.filter(c => c.pass).length, checks.length)} | ${fmt(median(first.map(t => t.ms)))} | ${fmt(median(first.map(t => t.promptTokens)))}+${fmt(median(first.map(t => t.completionTokens)))} | ${fmt(median(first.map(t => t.modelCalls)))} | ${runnable.flatMap(r => r.turns).filter(t => t.autoAnswers).length} | ${pct(later.filter(t => t.pass).length, later.length)} | ${fmt(median(later.map(t => t.ms)))} | ${fmt(median(later.map(t => t.promptTokens)))}+${fmt(median(later.map(t => t.completionTokens)))} |`);
}
const KEPT = new Set(["criteria", "candidates", "sheets", "aggregation", "dataLoss", "location"]);
const reasons = new Map<string, number>();
for (const reason of rows.flatMap(r => r.turns.flatMap(t => t.askReasons ?? []))) reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
lines.push("", `질문 사유 (모델 응답 기준, 코드가 거부한 것 포함): ${[...reasons].map(([k, v]) => `${k}${KEPT.has(k) ? "" : "(불필요)"} ${v}`).join(", ") || "없음"}`);
lines.push("", "| 케이스 | 상태 | 턴별 결과 (통과/시간ms/토큰) |", "| --- | --- | --- |");
for (const r of rows) lines.push(`| ${r.id} | ${r.status} | ${r.turns.map(t => `${t.pass ? "✓" : "✗"} ${t.status} ${t.ms}ms ${t.promptTokens}+${t.completionTokens}`).join(" → ") || "—"} |`);
console.log(lines.join("\n"));
