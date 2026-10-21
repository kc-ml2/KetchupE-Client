// Check authenticated Trolley capabilities; the user supplies the key privately.
import "dotenv/config";
import { DEFAULT_TROLLEY_ENDPOINT, TrolleyClient } from "../electron/agent/trolley.ts";

const apiKey = process.env.TROLLEY_API_KEY?.trim();
if (!apiKey) {
  console.error(".env의 TROLLEY_API_KEY에 키를 직접 입력한 뒤 다시 실행하세요. 채팅에 키를 보내지 마세요.");
  process.exit(2);
}

const client = new TrolleyClient(apiKey, "probe", new URL(process.env.TROLLEY_MCP_ENDPOINT?.trim() || DEFAULT_TROLLEY_ENDPOINT.href));
try {
  const result = await client.call("get_my_capabilities", AbortSignal.timeout(30_000));
  console.log("Trolley MCP 연결 확인: get_my_capabilities 성공");
  console.log(result.summary);
} catch (error) {
  console.error("Trolley 연결을 확인하지 못했습니다. endpoint·API key·서버 권한을 확인하세요.", {
    errorType: error instanceof Error ? error.name : "UnknownError",
  });
  process.exitCode = 1;
} finally {
  await client.close();
}
