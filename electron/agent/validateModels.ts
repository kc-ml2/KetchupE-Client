import type { ServiceKeys } from "../auth/broker.ts";
import { ActivationError } from "../auth/activationError.ts";
import { listModels } from "./modelClient.ts";
import { configuredModel, modelConfig, type ModelConfig } from "./modelConfig.ts";

/** Check exact server IDs before creating workers, databases or session IPC. */
export async function validateAccountModels(keys: ServiceKeys, config: ModelConfig = modelConfig): Promise<void> {
  let available: string[];
  try {
    available = await listModels(keys.litellm.base_url, keys.litellm.api_key);
  } catch {
    throw new ActivationError("서버의 모델 목록을 확인하지 못했습니다. 네트워크와 로그인 계정의 모델 접근 권한을 확인한 뒤 다시 시도해 주세요.");
  }
  const configured = [
    ["decision.default", configuredModel(config, "decision")],
    ["generation.default", configuredModel(config, "generation")],
    ["generation.document", configuredModel(config, "generation", "document")],
  ];
  const missing = configured.filter(([, model]) => !available.includes(model));
  if (missing.length) {
    throw new ActivationError(`llm.config.yaml에 지정한 모델이 서버 모델 목록에 없습니다: ${missing.map(([category, model]) => `${category}=${model}`).join(", ")}. 대소문자를 포함한 모델명을 수정하고 앱을 다시 시작하세요. 배포 앱은 재빌드가 필요합니다.`);
  }
}
