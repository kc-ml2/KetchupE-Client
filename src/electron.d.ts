import type { KetchupEAgentAPI } from "@app-types/Agent.types";

declare global {
  interface Window {
    agentAPI?: KetchupEAgentAPI;
  }
}

export {};
