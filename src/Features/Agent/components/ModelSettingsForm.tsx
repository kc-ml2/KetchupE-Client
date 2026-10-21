import { useEffect, useState } from "react";
import type { KetchupEAgentAPI } from "@app-types/Agent.types";

const ModelSettingsForm = ({
  api,
}: {
  api: KetchupEAgentAPI;
}): React.JSX.Element => {
  const [baseURL, setBaseURL] = useState("");
  const [modelAlias, setModelAlias] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [hasApiKey, setHasApiKey] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    void api.getModelSettings().then((settings) => {
      setBaseURL(settings.baseURL);
      setModelAlias(settings.modelAlias);
      setHasApiKey(settings.hasApiKey);
      if (settings.hasApiKey)
        void api
          .listModels()
          .then(setModels)
          .catch(() => setModels([]));
    });
  }, [api]);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      await api.setModelSettings({
        baseURL,
        modelAlias,
        apiKey: apiKey || undefined,
      });
      setApiKey("");
      setHasApiKey(hasApiKey || apiKey.length > 0);
      const result = await api.testModelConnection();
      setModels(result.models);
      setMessage(
        result.ok
          ? `연결 확인. 사용 모델: ${result.resolvedAlias}`
          : "저장했지만 모델 목록을 받지 못했습니다. 도메인과 키를 확인하세요.",
      );
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const field =
    "w-full px-2 py-1.5 text-sm rounded border border-[#E4E4E7] dark:border-[#27272A] bg-white dark:bg-[#0F0F0F] text-[#18181B] dark:text-[#FAFAFA]";
  return (
    <form onSubmit={save} className="flex flex-col gap-3 text-sm">
      <label className="flex flex-col gap-1">
        <span className="text-xs text-[#71717A]">LiteLLM 도메인</span>
        <input value={baseURL} onChange={(event) => setBaseURL(event.target.value)} placeholder="centinels.ml2-alpha.com" className={field} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-[#71717A]">API key {hasApiKey ? "(저장됨, 변경 시에만 입력)" : "(필수)"}</span>
        <input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} className={field} autoComplete="off" />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-[#71717A]">
          모델 (기본: loki)
        </span>
        {models.length ? (
          <select
            value={modelAlias}
            onChange={(event) => setModelAlias(event.target.value)}
            className={field}
          >
            {models.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        ) : (
          <input
            value={modelAlias}
            onChange={(event) => setModelAlias(event.target.value)}
            placeholder="loki"
            className={field}
          />
        )}
      </label>
      <button
        type="submit"
        className="self-start px-3 py-1.5 rounded-lg text-sm font-semibold bg-[#0066FF] text-white"
      >
        저장 및 연결 확인
      </button>
      {message && <p className="text-xs text-[#71717A]">{message}</p>}
      <p className="text-[11px] text-[#71717A]">
        키는 OS 보안 저장소로 암호화되며 화면, trace, export에 노출되지
        않습니다.
      </p>
    </form>
  );
};

export default ModelSettingsForm;
