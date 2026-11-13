import { parse } from "yaml";
import { z } from "zod";
import source from "../../llm.config.yaml?raw";

const model = z.string().trim().min(1);
const schema = z.strictObject({
  decision: z.strictObject({ default: model }),
  generation: z.strictObject({ default: model, document: model.optional() }),
});
export type ModelConfig = z.infer<typeof schema>;

export function parseModelConfig(source: string): ModelConfig {
  return schema.parse(parse(source));
}

/** Validate bundled YAML before opening account resources. Unknown categories never fall back. */
export const modelConfig = parseModelConfig(source);

export function configuredModel(config: ModelConfig, role: "decision", category?: "default"): string;
export function configuredModel(config: ModelConfig, role: "generation", category?: "default" | "document"): string;
export function configuredModel(config: ModelConfig, role: string, category = "default"): string {
  if (role === "decision" && category === "default") return config.decision.default;
  if (role === "generation") {
    if (category === "default") return config.generation.default;
    if (category === "document") return config.generation.document ?? config.generation.default;
  }
  throw new Error(`Unknown LLM category: ${role}.${category}`);
}
