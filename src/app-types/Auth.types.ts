import type { KetchupEAgentAPI } from "./Agent.types";

export type ProviderStatus = { status: string; attempt_count: number; error_code: string | null; needs_attention: boolean };
export type AuthState = {
  phase: "signed_out" | "requesting" | "code" | "verifying" | "provisioning" | "paused" | "action_required" | "activating" | "ready" | "signing_out";
  email?: string;
  expiresAt?: string;
  providers?: { litellm: ProviderStatus; maru: ProviderStatus };
  message?: string;
  sessionId?: string;
};

export interface AuthAPI {
  getState(): Promise<AuthState>;
  requestCode(email: string): Promise<void>;
  verifyCode(code: string): Promise<void>;
  retry(): Promise<void>;
  logout(): Promise<void>;
  onChange(listener: (state: AuthState) => void): () => void;
  agent(sessionId: string): KetchupEAgentAPI;
}
