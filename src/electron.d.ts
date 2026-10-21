import type { KetchupEAgentAPI } from "@app-types/Agent.types";
import type { AuthAPI } from "@app-types/Auth.types";

declare global {
  interface Window {
    agentAPI?: KetchupEAgentAPI;
    authAPI?: AuthAPI;
  }
}

export {};
