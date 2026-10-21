import { createContext } from "react";
import type { KetchupEAgentAPI } from "@app-types/Agent.types";

export const AgentApiContext = createContext<KetchupEAgentAPI | null>(null);
