/** Keep model diagnostics in the run trace; show a useful recovery message in chat and Canvas. */
export function agentErrorMessage(code: unknown, message: unknown): string {
  if (code === "MODEL_PROTOCOL" || code === "MODEL_TIMEOUT") return "케찹이가 잠깐 쉬고 있어요. 잠시 후 다시 시도해 주세요.";
  return `${String(code)}: ${String(message ?? "")}`;
}
