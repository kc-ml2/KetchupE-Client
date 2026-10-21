// Offline reproducible demo. All money/rates/counterparties are synthetic, not real financial output.
// node --experimental-strip-types scripts/daily-cash-demo.ts <output directory>
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { fixtureBooks } from "../electron/business/dailyCash/fixtures.ts";
import { dailyCashTool } from "../electron/business/dailyCash.ts";
import type { BusinessTool } from "../electron/business/contracts.ts";
const directory = resolve(process.argv[2] ?? "fixtures/daily-cash"); await mkdir(directory, { recursive: true });
const books = fixtureBooks();
const file = async (book: typeof books.report, name: string) => { const bytes = Buffer.from(await book.xlsx.writeBuffer()); await writeFile(join(directory, name), bytes); return { name, bytes, fingerprint: createHash("sha256").update(bytes).digest("hex") }; };
const input: Parameters<BusinessTool["execute"]>[0] = { values: { workDate: "2026-10-14", actualEdits: "확인", planEdits: "확인" }, files: { previousReport: [await file(books.report, "테스트_전일일보.xlsx")], weeklyPlans: [await file(books.weekly, "테스트_주간계획.xlsx")], cashStatus: [await file(books.status, "261013_테스트_자금현황표[KC].xlsx")] }, checkpoint: { rates: { date: "2026-10-13", requestedDate: "2026-10-13", round: "DEMO", publishedAt: "테스트 전용 고정환율", source: "synthetic fixture; not Hana market data", fetchedAt: "2026-10-14T00:00:00Z", responseHash: "demo-only", perUnit: { USD: "1400", JPY: "9.5", CNY: "200" } } }, signal: new AbortController().signal };
const review = await dailyCashTool.execute(input);
const code = review.status === "needs_input" ? review.fields.find((field) => field.key === "review")?.confirm : undefined;
if (review.status !== "needs_input" || !code?.match(/^확인 [a-f0-9]{12}$/)) throw new Error(JSON.stringify(review));
await writeFile(join(directory, "확인요청.txt"), review.question);
input.values.review = code; input.checkpoint = review.checkpoint ?? input.checkpoint;
const result = await dailyCashTool.execute(input); if (result.status !== "completed") throw new Error(JSON.stringify(result));
await writeFile(join(directory, `테스트_${result.file.name}`), result.file.bytes); await writeFile(join(directory, `테스트_${result.image!.name}`), result.image!.bytes);
console.log(JSON.stringify({ directory, summary: result.summary, checks: result.checks }, null, 2));
