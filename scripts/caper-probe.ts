// Read-only connectivity probe. Never print credentials, account values or remote error bodies.
// Usage: npm run probe:caper -- 20261027 20261027 (key in .env.caper.local)
import assert from "node:assert/strict";
import { config } from "dotenv";
import { z } from "zod";
import { McpConnection } from "../electron/agent/mcp.ts";

const tool = "erp_cash_status_kc";
const apiUrl = "https://caper.kct.co.kr/api/agent-tools";
const mcpUrl = "https://caper.kct.co.kr/api/mcp/mcp";
const day = z.string().regex(/^\d{8}$/).refine((value) => {
  const date = new Date(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10).replaceAll("-", "") === value;
});
const period = z.object({ from_dt: day, to_dt: day }).refine((value) => value.from_dt <= value.to_dt);
const cashResponse = z.object({
  success: z.literal(true),
  data: z.object({ rows: z.array(z.record(z.string(), z.unknown())), rowCount: z.number().int().nonnegative(), truncated: z.literal(false) })
    .refine((data) => data.rows.length === data.rowCount),
});

function summarizeCash(value: unknown) {
  const { data } = cashResponse.parse(value);
  return { rowCount: data.rowCount, truncated: data.truncated, columns: [...new Set(data.rows.flatMap((row) => Object.keys(row)))].sort() };
}

async function main() {
  if (process.argv[2] === "--self-test") {
    const sample = { success: true, data: { rows: [{ FINPRODUCT_NO: "PRIVATE_ACCOUNT", AM_FINAL: "PRIVATE_AMOUNT" }], rowCount: 1, truncated: false } };
    assert.deepEqual(summarizeCash(sample), { rowCount: 1, truncated: false, columns: ["AM_FINAL", "FINPRODUCT_NO"] });
    assert(!JSON.stringify(summarizeCash(sample)).includes("PRIVATE"));
    assert.throws(() => summarizeCash({ ...sample, success: false }));
    assert.throws(() => summarizeCash({ ...sample, data: { ...sample.data, truncated: true } }));
    assert.throws(() => summarizeCash({ ...sample, data: { ...sample.data, rowCount: 2 } }));
    assert.throws(() => period.parse({ from_dt: "20260230", to_dt: "20260301" }));
    assert.throws(() => period.parse({ from_dt: "20261028", to_dt: "20261027" }));
    assert.deepEqual(period.parse({ from_dt: "20261030", to_dt: "20261101" }), { from_dt: "20261030", to_dt: "20261101" });
    console.log("CAPER self-test passed (no network requests)");
    return;
  }

  const parsed = period.safeParse({ from_dt: process.argv[2], to_dt: process.argv[3] });
  if (!parsed.success) {
    console.error("Usage: npm run probe:caper -- YYYYMMDD YYYYMMDD (from_dt <= to_dt)");
    process.exitCode = 2;
    return;
  }
  config({ path: ".env.caper.local" });
  const token = process.env.CAPER_API_KEY?.trim();
  if (!token) {
    console.error(".env.caper.local의 CAPER_API_KEY에 키만 입력하세요 (Bearer 제외).");
    process.exitCode = 2;
    return;
  }
  console.log("조회 기간:", parsed.data);

  for (const protocol of ["REST", "MCP"] as const) {
    const started = Date.now();
    try {
      if (protocol === "REST") {
        const request = async (url: string, body?: unknown): Promise<unknown> => {
          const response = await fetch(url, {
            method: body === undefined ? "GET" : "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            redirect: "error", signal: AbortSignal.timeout(60_000),
          });
          console.log("REST HTTP:", response.status);
          if (!response.ok) { await response.body?.cancel(); throw new Error("HTTP failure"); }
          return response.json();
        };
        await request(apiUrl);
        console.log("REST 도구 목록: JSON 응답 수신");
        console.log("REST 조회 성공:", summarizeCash(await request(`${apiUrl}/${tool}`, parsed.data)));
      } else {
        const connection = new McpConnection({ id: "caper-probe", endpoint: new URL(mcpUrl), clientName: "ketchupe-probe", clientVersion: "0.0.0", token: async () => token, allowedTools: [tool] });
        try {
          const listed = await connection.listTools(AbortSignal.timeout(60_000));
          assert(listed.some((item) => item.name === tool));
          console.log("MCP initialize / tools/list 성공:", tool);
          const result = await connection.callTool(tool, parsed.data, AbortSignal.timeout(60_000));
          if (result.isError) throw new Error("MCP tool error");
          console.log("MCP tools/call 성공:", { isError: false, contentTypes: result.content.map((item) => item.type), textCharacters: result.content.reduce((sum, item) => sum + (item.type === "text" ? item.text.length : 0), 0) });
        } finally {
          await connection.close();
        }
      }
    } catch (error) {
      const cause = error instanceof Error ? error.cause as { code?: unknown } | undefined : undefined;
      console.error(`${protocol} 확인 실패:`, { errorType: error instanceof Error ? error.name : "UnknownError", code: typeof cause?.code === "string" && /^[A-Z_]+$/.test(cause.code) ? cause.code : undefined, elapsedMs: Date.now() - started });
      if (error instanceof z.ZodError) console.error("REST 응답 규격·rowCount·truncated를 확인하세요. 원문은 출력하지 않습니다.");
      process.exitCode = 1;
    }
  }
}

await main();
