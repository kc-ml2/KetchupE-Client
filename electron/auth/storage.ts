import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { safeStorage } from "electron";
import { z } from "zod";
import { emailSchema, keysSchema, type ServiceKeys } from "./broker.ts";

const accountSchema = z.object({ email: emailSchema, keys: keysSchema });
export type AccountCredentials = { email: string; keys: ServiceKeys };

export function accountId(email: string): string {
  const validated = emailSchema.parse(email);
  const at = validated.lastIndexOf("@");
  // The broker supplies no canonical user ID; preserve the case-sensitive local part.
  return createHash("sha256").update(`${validated.slice(0, at)}@${validated.slice(at + 1).toLowerCase()}`).digest("hex");
}
export function accountDirectory(root: string, email: string): string { return join(root, "accounts", accountId(email)); }

function encryptionAvailable(): boolean {
  return safeStorage.isEncryptionAvailable() && (process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text");
}

/** Only the active login is persisted; signing out removes credentials, never account data. */
export class CredentialStore {
  private readonly path: string;
  constructor(private readonly root: string) { this.path = join(root, "login.enc"); }

  load(): AccountCredentials | undefined {
    if (!encryptionAvailable()) return undefined;
    try {
      const value = accountSchema.parse(JSON.parse(safeStorage.decryptString(readFileSync(this.path))));
      return value.keys.mock ? undefined : value;
    } catch { return undefined; }
  }

  save(account: AccountCredentials): void {
    const validated = accountSchema.parse(account);
    if (validated.keys.mock) throw new Error("테스트용 키로 로그인할 수 없습니다.");
    if (!encryptionAvailable()) throw new Error("이 환경에서는 로그인 정보를 안전하게 저장할 수 없습니다.");
    mkdirSync(this.root, { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, safeStorage.encryptString(JSON.stringify(validated)), { mode: 0o600, flag: "wx" });
      renameSync(temporary, this.path);
    } finally { rmSync(temporary, { force: true }); }
  }

  clear(): void { rmSync(this.path, { force: true }); }
}
