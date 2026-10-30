import { getQuickJS } from "quickjs-emscripten";
import type { InputRow } from "./contracts.ts";
import { validateResult } from "./contracts.ts";

/** No host callbacks, module loader, files, credentials or network enter the guest runtime. */
export async function runAnalysis(code: string, rows: InputRow[], timeoutMs = 5000) {
  if (code.length > 30000) throw new Error("분석 코드가 너무 큽니다.");
  const engine = await getQuickJS();
  const runtime = engine.newRuntime();
  const deadline = Date.now() + timeoutMs;
  runtime.setInterruptHandler(() => Date.now() > deadline);
  const context = runtime.newContext();
  try {
    const input = JSON.stringify(JSON.stringify({ rows }));
    const result = context.evalCode(`(() => { const encode = JSON.stringify; const finite = Number.isFinite; const output = (function(input) { "use strict";\n${code}\n})(JSON.parse(${input})); if (output === undefined) throw new Error("코드가 값을 반환하지 않았습니다. code는 함수 선언이 아니라 함수 본문이며 마지막에 return {tables, excluded, notes, chart}가 있어야 합니다. 함수를 선언만 하고 호출하지 않았는지 확인하세요."); if (typeof output === "function") throw new Error("함수 자체를 반환했습니다. 함수를 호출한 결과 객체를 return하세요."); return encode(output, (_key, value) => { if (typeof value === "number" && !finite(value)) throw new Error("Non-finite number in result"); return value; }); })()`, "analysis.js");
    if (result.error) {
      let detail = "실행 오류 또는 시간 초과";
      try {
        const message = context.getProp(result.error, "message");
        try { if (context.typeof(message) === "string") detail = context.getString(message).slice(0, 500); }
        finally { message.dispose(); }
      } finally { result.error.dispose(); }
      throw new Error(`분석 코드 실행 실패 (실행 시간 ${timeoutMs / 1000}초 제한): ${detail}`);
    }
    try {
      if (context.typeof(result.value) !== "string") throw new Error("JSON 결과를 반환해야 합니다.");
      const json = context.getString(result.value);
      if (json.length > 4 * 1024 * 1024) throw new Error("분석 결과가 4MB를 초과했습니다.");
      return validateResult(JSON.parse(json), rows);
    } finally { result.value.dispose(); }
  } finally { context.dispose(); runtime.dispose(); }
}
