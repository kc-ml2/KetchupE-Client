import type { KetchupEAgentAPI } from "@app-types/Agent.types";
import { useContext } from "react";
import { AgentApiContext } from "@Contexts/AgentApiContext";

/** The local agent only exists inside Electron; the web build renders a hint instead. */
export const useAgentApi = (): KetchupEAgentAPI | null =>
  useContext(AgentApiContext) ?? (typeof window === "undefined" ? null : (window.agentAPI ?? null));
