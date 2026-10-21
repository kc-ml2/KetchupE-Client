// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHAT_ROUTE, DOC_ROUTE, routeMessage } from "./router.ts";
const signal = new AbortController().signal;
const settings = { baseURL: "https://gateway.example.com/v1/", apiKey: "test-key", modelAlias: "clef" };
const reply = (choice = "chat", probabilities: Record<string, number> = { chat: 0.9, doc: 0.1 }) => ({ answers: { workflow: { type: "choice", choice, confidence: 0.9, probabilities } } });
afterEach(() => vi.unstubAllGlobals());
describe("Clef workflow routing", () => {
  it("sends all manifests and context as typed choices, independently of the generation model", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(reply("summary", { chat: 0.05, doc: 0.05, summary: 0.9 })));
    vi.stubGlobal("fetch", fetcher);
    const routes = [CHAT_ROUTE, DOC_ROUTE, { id: "summary", description: "요약", matches: () => false, examples: ["핵심만 정리"], requiredInputs: ["원문"] }];
    const context = { recentUserMessages: ["이 문서"] };
    expect(await routeMessage({ ...settings, baseURL: "https://gateway.example.com", modelAlias: "custom-clef" }, "짧게 줄여줘", signal, routes, context)).toBe("summary");
    const [url, options] = fetcher.mock.calls[0];
    expect(String(url)).toBe("https://gateway.example.com/v1/systemone");
    expect(options.headers.Authorization).toBe("Bearer test-key");
    expect(options.method).toBe("POST");
    const body = JSON.parse(options.body);
    expect(body.model).toBe("custom-clef");
    expect(body.state).toEqual({ message: "짧게 줄여줘", context });
    expect(Object.keys(body.questions.workflow.criteria)).toEqual(["chat", "doc", "summary"]);
    for (const text of ["핵심만 정리", "원문"]) expect(body.questions.workflow.criteria.summary).toContain(text);
    expect(body.questions.workflow.instructions).toContain("설명·방법·개념");
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });
  it("uses the typed choice for questions and execution requests", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json(reply())).mockResolvedValueOnce(Response.json(reply("doc", { chat: 0.1, doc: 0.9 }))));
    expect(await routeMessage(settings, "계약서 작성 절차는?", signal)).toBe("chat");
    expect(await routeMessage(settings, "상대방에게 보낼 초안 준비해", signal)).toBe("doc");
  });
  it.each([
    reply("unknown"), {}, { answers: { workflow: { choice: "doc" } } },
    reply("chat", { chat: 1 }),
    reply("chat", { chat: 0.9, doc: 0.1, unknown: 0 }),
    reply("chat", { chat: 2, doc: -1 }),
  ])("rejects malformed or unregistered decisions without starting a workflow", async (body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body)));
    await expect(routeMessage(settings, "실행해", signal)).rejects.toMatchObject({ code: "MODEL_PROTOCOL" });
  });
  it.each([401, 403, 404, 500])("reports HTTP %s without retrying or silently falling back", async (status) => {
    const fetcher = vi.fn().mockResolvedValue(new Response("secret upstream details", { status }));
    vi.stubGlobal("fetch", fetcher);
    await expect(routeMessage(settings, "실행해", signal)).rejects.toMatchObject({ code: status === 401 || status === 403 ? "MODEL_AUTH" : "TOOL_UNAVAILABLE" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not expose transport errors or credentials", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("secret-key")));
    await expect(routeMessage(settings, "실행해", signal)).rejects.toThrow("연결하지 못");
  });
  it("preserves cancellation and timeout, including a late response", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => { controller.abort(); return Response.json(reply()); }));
    await expect(routeMessage(settings, "실행해", controller.signal)).rejects.toMatchObject({ code: "CANCELLED" });
    await expect(routeMessage(settings, "실행해", AbortSignal.abort(new DOMException("timeout", "TimeoutError")))).rejects.toMatchObject({ code: "MODEL_TIMEOUT" });
  });
  it("bypasses the model for explicit IDs and a single route, but rejects unknown IDs and empty routes", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const noKey = { ...settings, apiKey: undefined };
    expect(await routeMessage(noKey, "$doc 초안 작성", signal)).toBe("doc");
    expect(await routeMessage(noKey, "안녕", signal, [CHAT_ROUTE])).toBe("chat");
    await expect(routeMessage(noKey, "$missing 실행", signal)).rejects.toThrow("등록되지 않은");
    await expect(routeMessage(noKey, "안녕", signal, [])).rejects.toThrow("at least one");
    await expect(routeMessage(noKey, "안녕", signal)).rejects.toMatchObject({ code: "MODEL_AUTH" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
