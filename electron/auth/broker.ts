import { z } from "zod";

export const BROKER_URL = "https://ketchupe.ml2-alpha.com/server/";
export const emailSchema = z.string().trim().email().max(254);
export const codeSchema = z.string().regex(/^[0-9]{6}$/);
const dateTime = z.string().datetime({ offset: true });
export const challengeSchema = z.object({ challenge_id: z.string().uuid(), expires_at: dateTime });
const verificationSchema = z.object({
  access_token: z.string().min(1), expires_at: dateTime,
  token_type: z.literal("bearer").default("bearer"),
  provisioning_status: z.literal("pending").default("pending"),
  status_url: z.string().default("/v1/keys/status"),
});
const providerStatusSchema = z.object({
  status: z.string(), attempt_count: z.number().int(), error_code: z.string().nullable(), needs_attention: z.boolean(),
});
const statusSchema = z.object({
  provisioning_status: z.enum(["pending", "ready", "action_required"]),
  providers: z.object({ litellm: providerStatusSchema, maru: providerStatusSchema }),
});
function endpoint(path: string) {
  return z.string().refine((value) => {
    try {
      const url = new URL(value);
      return url.origin === "https://ketchupe.ml2-alpha.com" && !url.username && !url.password && !url.search && !url.hash
        && url.pathname.replace(/\/$/, "") === path;
    } catch { return false; }
  }, "지원하지 않는 서비스 주소입니다.");
}
export const keysSchema = z.object({
  litellm: z.object({ base_url: endpoint("/gateway"), api_key: z.string().trim().min(1) }),
  maru: z.object({ base_url: endpoint("/maru/mcp"), api_key: z.string().trim().min(1) }),
  mock: z.boolean().default(true),
});
export type ServiceKeys = z.infer<typeof keysSchema>;

export class BrokerError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}

export class CredentialBroker {
  constructor(private readonly request: typeof fetch = fetch) {}

  requestCode(email: string, signal: AbortSignal) {
    return this.call("v1/auth/email/request", challengeSchema, signal, undefined, { email });
  }
  verifyCode(email: string, challengeId: string, code: string, signal: AbortSignal) {
    return this.call("v1/auth/email/verify", verificationSchema, signal, undefined, { email, challenge_id: challengeId, code });
  }
  status(token: string, signal: AbortSignal) { return this.call("v1/keys/status", statusSchema, signal, token); }
  keys(token: string, signal: AbortSignal) { return this.call("v1/keys", keysSchema, signal, token); }

  private async call<T>(path: string, schema: z.ZodType<T>, signal: AbortSignal, token?: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.request(new URL(path, BROKER_URL), {
        method: body === undefined ? "GET" : "POST", redirect: "error",
        headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      });
    } catch {
      throw new BrokerError("인증 서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    }
    if (response.status !== (body === undefined ? 200 : 202)) {
      // Error bodies may echo the code or credentials (including FastAPI's ValidationError.input).
      const messages: Record<number, string> = {
        401: "인증이 만료되었거나 인증코드가 올바르지 않습니다. 이메일 인증을 다시 진행해 주세요.",
        403: "접근이 허용되지 않았습니다. 운영자에게 확인해 주세요.",
        422: "입력 내용을 확인해 주세요. 이메일과 6자리 인증코드가 필요합니다.",
        429: "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
      };
      throw new BrokerError(messages[response.status] ?? "인증 요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.", response.status);
    }
    let parsed: T;
    try { parsed = schema.parse(await response.json()); }
    catch { throw new BrokerError("인증 서버의 응답 형식이 올바르지 않습니다. 운영자에게 확인해 주세요."); }
    // expires_at is server time; re-anchor it to the local clock so a skewed PC clock cannot expire codes or tokens early.
    const serverNow = Date.parse(response.headers.get("date") ?? "");
    const timed = parsed as { expires_at?: unknown };
    if (Number.isFinite(serverNow) && typeof timed.expires_at === "string") {
      timed.expires_at = new Date(Date.now() + Date.parse(timed.expires_at) - serverNow).toISOString();
    }
    return parsed;
  }
}
