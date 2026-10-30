import { useEffect, useState } from "react";
import type { KetchupEAgentAPI } from "@app-types/Agent.types";

/** Development-only model picker; the gateway and key come from the logged-in account. */
const ModelSettingsForm = ({
  api,
}: {
  api: KetchupEAgentAPI;
}): React.JSX.Element => {
  const [modelAlias, setModelAlias] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    void api.getModelSettings().then((settings) => setModelAlias(settings.modelAlias));
    void api
      .listModels()
      .then(setModels)
      .catch((cause) => setMessage(cause instanceof Error ? cause.message : String(cause)));
  }, [api]);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      await api.setModelSettings({ modelAlias });
      setMessage(`사용 모델: ${modelAlias}`);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const field =
    "w-full px-2 py-1.5 text-sm rounded border border-[#E4E4E7] dark:border-[#27272A] bg-white dark:bg-[#0F0F0F] text-[#18181B] dark:text-[#FAFAFA]";
  return (
    <form onSubmit={save} className="flex flex-col gap-3 text-sm">
      <label className="flex flex-col gap-1">
        <span className="text-xs text-[#71717A]">모델 (LiteLLM에 연결된 모델)</span>
        <select
          value={modelAlias}
          onChange={(event) => setModelAlias(event.target.value)}
          className={field}
          disabled={!models.length}
        >
          {!models.includes(modelAlias) && <option value={modelAlias}>{modelAlias || "선택"}</option>}
          {models.map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </select>
      </label>
      <button
        type="submit"
        disabled={!modelAlias}
        className="self-start px-3 py-1.5 rounded-lg text-sm font-semibold bg-[#0066FF] text-white disabled:opacity-50"
      >
        적용
      </button>
      {message && <p className="text-xs text-[#71717A]">{message}</p>}
      <p className="text-[11px] text-[#71717A]">
        개발 모드 전용입니다. 앱을 다시 시작하면 기본 모델로 돌아갑니다.
      </p>
    </form>
  );
};

export default ModelSettingsForm;
