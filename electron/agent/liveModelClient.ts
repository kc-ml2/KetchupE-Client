import { AgentError } from "./contracts.ts";
import { createLiteLLMClient, type ModelCallInfo, type ModelClient } from "./modelClient.ts";
import type { ModelSettings } from "./settings.ts";

/** Model client that reads the current settings on every call so the settings screen takes effect immediately. */
export function settingsBackedModelClient(settings: () => ModelSettings, resolvedAlias: () => Promise<string>): ModelClient {
  const client = async () => {
    const current = settings();
    if (!current.apiKey) throw new AgentError("MODEL_AUTH", "LiteLLM 도메인과 API key를 설정에서 입력하세요.");
    return { client: createLiteLLMClient({ baseURL: current.baseURL, apiKey: current.apiKey }), modelAlias: await resolvedAlias() };
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
      const { client: live, modelAlias } = await client();
      try {
        return await live.complete(input, { ...profile, modelAlias }, signal);
      } finally {
        report(live, signal);
      }
    },
  };
  return self;
}
