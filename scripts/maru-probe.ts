// Verifies the current MARU MCP connection without printing credentials or signed URLs.
// Usage: npm run probe:maru            (reads MARU_API_TOKEN from .env)
//        npm run probe:maru -- find_storage '{"query":"연차"}'
import "dotenv/config";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { DEFAULT_MARU_ENDPOINT, normalizeMaruFindResult, sanitizeMaruResult } from "../electron/agent/maru.ts";

const token = process.env.MARU_API_TOKEN?.trim();
if (!token) {
  console.error("MARU_API_TOKEN is required (.env 또는 환경변수)");
  process.exit(2);
}

const [tool = "browse_storage", rawArgs = "{}"] = process.argv.slice(2);
if (tool !== "browse_storage" && tool !== "find_storage") {
  console.error("MARU onboarding의 browse_storage 또는 find_storage만 사용할 수 있습니다.");
  process.exit(2);
}
const args = JSON.parse(rawArgs) as Record<string, unknown>;
const endpoint = new URL(process.env.MARU_MCP_ENDPOINT?.trim() || DEFAULT_MARU_ENDPOINT.href);
const signal = AbortSignal.timeout(30_000);

const client = new Client({ name: "ketchupe-probe", version: "0.0.0" });
const transport = new StreamableHTTPClientTransport(endpoint, {
  authProvider: { token: async () => token },
});

const dump = (label: string, value: unknown) => console.log(`\n=== ${label} ===\n${JSON.stringify(value, null, 2)}`);

try {
  console.log("endpoint:", `${endpoint.origin}${endpoint.pathname}`);
  await client.connect(transport, { signal });
  dump("서버 정보 (initialize 응답)", { serverInfo: client.getServerVersion(), capabilities: client.getServerCapabilities() });
  const listed = await client.listTools(undefined, { signal, cacheMode: "refresh" });
  dump("tools/list", listed.tools.map((item) => ({ name: item.name, inputSchema: item.inputSchema })));
  if (!listed.tools.some((item) => item.name === tool)) throw new Error("server does not expose the requested tool");

  const result = await client.callTool({ name: tool, arguments: args }, { signal });
  let payload: unknown = result.structuredContent;
  if (payload === undefined) {
    const text = result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
    try { payload = JSON.parse(text); } catch { payload = text; }
  }
  dump("tools/call", {
    tool,
    isError: result.isError ?? false,
    result: tool === "find_storage" ? normalizeMaruFindResult(payload) : sanitizeMaruResult(payload),
  });
  if (result.isError) process.exitCode = 1;
} catch (error) {
  console.error("\n=== 실패 ===");
  console.error("MARU MCP 연결 실패. endpoint와 관리자에게 받은 API token 상태를 확인하세요.", {
    errorType: error instanceof Error ? error.name : "UnknownError",
  });
  process.exitCode = 1;
} finally {
  await client.close().catch(() => undefined);
}
