import { AgentError } from "./contracts.ts";
import { createLiteLLMClient, type ModelCallInfo, type ModelClient } from "./modelClient.ts";
import type { ModelSettings } from "./settings.ts";

/** Chat calls are generation; Clef decisions are handled by the systemone router. */
export function settingsBackedModelClient(
  settings: () => ModelSettings,
  resolvedAlias: () => Promise<string>,
  resolvedDocumentAlias: () => Promise<string> = resolvedAlias,
): ModelClient {
  const client = async (document = false) => {
    const current = settings();
    if (!current.apiKey) throw new AgentError("MODEL_AUTH", "로그인 계정의 모델 연결 정보를 확인하세요.");
    return { client: createLiteLLMClient({ baseURL: current.baseURL, apiKey: current.apiKey }), modelAlias: await (document ? resolvedDocumentAlias() : resolvedAlias()) };
  };
  const lastCalls = new WeakMap<AbortSignal, ModelCallInfo>();
  const report = (live: ModelClient, signal: AbortSignal) => {
    self.lastCall = live.lastCall;
    if (live.lastCall) lastCalls.set(signal, live.lastCall);
    else lastCalls.delete(signal);
  };
  const self: ModelClient = {
    lastCallFor: (signal) => lastCalls.get(signal),
    decide: async (state, profile, signal) => {
      const { client: live, modelAlias } = await client();
      try {
        return await live.decide(state, { ...profile, modelAlias }, signal);
      } finally {
        report(live, signal);
      }
    },
    verify: async (input, profile, signal) => {
      const { client: live, modelAlias } = await client();
      try {
        return await live.verify(input, { ...profile, modelAlias }, signal);
      } finally {
        report(live, signal);
      }
    },
    async *streamAnswer(input, profile, signal) {
      const { client: live, modelAlias } = await client();
      try {
        yield* live.streamAnswer(input, { ...profile, modelAlias }, signal);
      } finally {
        report(live, signal);
      }
    },
    async complete(input, profile, signal) {
      const { client: live, modelAlias } = await client(input.purpose === undefined || input.purpose === "canvas");
      try {
        return await live.complete(input, { ...profile, modelAlias }, signal);
      } finally {
        report(live, signal);
      }
    },
  };
  return self;
}
