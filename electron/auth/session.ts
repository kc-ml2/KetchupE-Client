import type { AuthState } from "../../src/app-types/Auth.types.ts";
import { BrokerError, CredentialBroker, codeSchema, emailSchema } from "./broker.ts";
import type { AccountCredentials, CredentialStore } from "./storage.ts";

const POLL_MS = 5_000;
const MAX_WAIT_MS = 120_000;

export class AuthSession {
  private state: AuthState = { phase: "signed_out" };
  private controller = new AbortController();
  private challenge?: { id: string; email: string; expiresAt: string };
  private token?: { value: string; expiresAt: string };
  private timer?: ReturnType<typeof setTimeout>;
  private deadline = 0;
  private activation?: Promise<void>;

  constructor(
    private readonly broker: CredentialBroker,
    private readonly store: Pick<CredentialStore, "load" | "save" | "clear">,
    private readonly lifecycle: { activate(account: AccountCredentials): Promise<string>; deactivate(): Promise<void> },
    private readonly emit: (state: AuthState) => void,
  ) {}

  getState(): AuthState { return structuredClone(this.state); }

  async restore(): Promise<void> {
    const account = this.store.load();
    if (account) await this.activate(account, this.controller.signal);
  }

  async requestCode(rawEmail: string): Promise<void> {
    if (["ready", "activating", "signing_out"].includes(this.state.phase)) return;
    this.reset();
    const parsed = emailSchema.safeParse(rawEmail);
    if (!parsed.success) { this.update({ phase: "signed_out", message: "올바른 사내 이메일을 입력해 주세요." }); return; }
    const email = parsed.data;
    const signal = this.controller.signal;
    this.update({ phase: "requesting", email });
    try {
      const result = await this.broker.requestCode(email, signal);
      if (signal.aborted) return;
      this.challenge = { id: result.challenge_id, email, expiresAt: result.expires_at };
      this.update({ phase: "code", email, expiresAt: result.expires_at });
    } catch (error) {
      if (!signal.aborted) this.update({ phase: "signed_out", email, message: this.message(error) });
    }
  }

  async verifyCode(rawCode: string): Promise<void> {
    if (this.state.phase !== "code" || !this.challenge) return;
    const code = codeSchema.safeParse(rawCode);
    if (!code.success) { this.update({ ...this.state, message: "숫자 6자리 인증코드를 입력해 주세요." }); return; }
    const challenge = this.challenge;
    if (Date.now() >= Date.parse(challenge.expiresAt)) {
      this.update({ ...this.state, message: "인증코드가 만료되었습니다. 새 코드를 요청해 주세요." }); return;
    }
    const signal = this.controller.signal;
    this.update({ phase: "verifying", email: challenge.email, expiresAt: challenge.expiresAt });
    try {
      const result = await this.broker.verifyCode(challenge.email, challenge.id, code.data, signal);
      if (signal.aborted) return;
      this.token = { value: result.access_token, expiresAt: result.expires_at };
      this.challenge = undefined;
      this.deadline = Date.now() + MAX_WAIT_MS;
      await this.poll(signal);
    } catch (error) {
      if (!signal.aborted) this.update({ phase: "code", email: challenge.email, expiresAt: challenge.expiresAt, message: this.message(error) });
    }
  }

  async retry(): Promise<void> {
    if (this.state.phase !== "paused") return;
    this.deadline = Date.now() + MAX_WAIT_MS;
    await this.poll(this.controller.signal);
  }

  async logout(): Promise<void> {
    if (this.state.phase === "signing_out") return;
    this.reset();
    this.update({ phase: "signing_out" });
    // Keep the app locked on any teardown failure; never open another user's database early.
    try {
      let cleared = true;
      try { this.store.clear(); } catch { cleared = false; }
      await this.activation;
      await this.lifecycle.deactivate();
      if (!cleared) throw new Error("credential removal failed");
      this.update({ phase: "signed_out" });
    } catch {
      this.update({ phase: "signing_out", message: "로그인 정보를 정리하지 못했습니다. 앱을 종료한 뒤 다시 실행해 주세요." });
    }
  }

  async shutdown(): Promise<void> {
    this.reset();
    this.update({ phase: "signing_out" });
    await this.activation;
    await this.lifecycle.deactivate();
  }

  private async poll(signal: AbortSignal): Promise<void> {
    if (signal.aborted || !this.token) return;
    if (Date.now() >= Date.parse(this.token.expiresAt)) { this.expire(); return; }
    this.update({ ...this.state, phase: "provisioning", expiresAt: this.token.expiresAt, message: undefined });
    try {
      const status = await this.broker.status(this.token.value, signal);
      if (signal.aborted) return;
      if (Date.now() >= Date.parse(this.token.expiresAt)) { this.expire(); return; }
      const attention = status.provisioning_status === "action_required" || Object.values(status.providers).some((provider) => provider.needs_attention);
      this.update({ ...this.state, providers: status.providers, phase: attention ? "action_required" : "provisioning" });
      if (attention) return;
      if (status.provisioning_status === "ready") {
        const keys = await this.broker.keys(this.token.value, signal);
        if (signal.aborted) return;
        if (keys.mock) {
          this.update({ ...this.state, phase: "action_required", message: "테스트용 키가 반환되었습니다. 운영자에게 실제 서비스 키 발급을 요청해 주세요." }); return;
        }
        await this.activate({ email: this.state.email!, keys }, signal);
        return;
      }
      if (Date.now() >= this.deadline) {
        this.update({ ...this.state, phase: "paused", message: "서비스 키가 아직 준비 중입니다. 잠시 후 다시 확인해 주세요." }); return;
      }
      this.timer = setTimeout(() => { void this.poll(signal); }, Math.min(POLL_MS, Math.max(0, Date.parse(this.token.expiresAt) - Date.now())));
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof BrokerError && error.status === 401) { this.expire(); return; }
      this.update({ ...this.state, phase: error instanceof BrokerError && error.status === 403 ? "action_required" : "paused", message: this.message(error) });
    }
  }

  private async activate(account: AccountCredentials, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    this.update({ phase: "activating", email: account.email });
    this.activation = (async () => {
      let saved = false;
      try {
        this.store.save(account);
        saved = true;
        const sessionId = await this.lifecycle.activate(account);
        if (!signal.aborted) {
          this.token = undefined;
          this.update({ phase: "ready", email: account.email, sessionId });
        }
      } catch {
        try {
          if (saved) this.store.clear();
          await this.lifecycle.deactivate();
        } catch {
          this.update({ phase: "signing_out", message: "작업 공간을 정리하지 못했습니다. 앱을 종료한 뒤 다시 실행해 주세요." });
          return;
        }
        if (!signal.aborted) this.update({ phase: "signed_out", email: account.email, message: "로그인 정보를 저장하거나 작업 공간을 열지 못했습니다. 다시 시도해 주세요." });
      }
    })();
    await this.activation;
  }

  private expire(): void {
    const email = this.state.email;
    this.reset();
    this.update({ phase: "signed_out", email, message: "임시 인증이 만료되었습니다. 이메일 인증을 다시 진행해 주세요." });
  }
  private reset(): void {
    this.controller.abort();
    clearTimeout(this.timer);
    this.controller = new AbortController();
    this.challenge = undefined;
    this.token = undefined;
  }
  private message(error: unknown): string { return error instanceof BrokerError ? error.message : "요청을 처리하지 못했습니다. 다시 시도해 주세요."; }
  private update(state: AuthState): void { this.state = state; this.emit(this.getState()); }
}
