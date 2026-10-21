import type { KetchupEAgentAPI } from "@app-types/Agent.types";

/** The local agent only exists inside Electron; the web build renders a hint instead. */
export const useAgentApi = (): KetchupEAgentAPI | null =>
  typeof window === "undefined" ? null : (window.agentAPI ?? null);
