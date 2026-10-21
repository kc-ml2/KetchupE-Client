/** Left rail tabs: home is the chat screen, the rest replace it with a full-width panel. */
export type AppTab = "home" | "settings" | "work" | "upload" | "context";

/** A registered workflow (electron/agent/runtime.ts) offered as a one-click start. */
export type WorkflowShortcut = { mode: string; label: string; description: string };
