import { useEffect, useState } from "react";
import { LuCheck, LuDownload, LuFile } from "react-icons/lu";
import type { KetchupEAgentAPI } from "@app-types/Agent.types";
import type { BusinessAction, BusinessArtifact, BusinessField, BusinessInput } from "@app-types/BusinessTool.types";
import type { WorkFile, WorkSource } from "@app-types/WorkSource.types";
import KetchupE from "@images/rag.png";
import MovementsEditor from "./MovementsEditor";

const control = "rounded border border-[#D4D4D8] dark:border-[#52525B] p-2 bg-white dark:bg-[#18181B] text-sm disabled:opacity-50";
const sameFile = (a: WorkFile, b: WorkFile) => a.sourceId === b.sourceId && a.relativePath === b.relativePath;
async function availableFiles(api: KetchupEAgentAPI, sources: WorkSource[]) {
  const results = await Promise.allSettled(sources.map((source) => api.listWorkFiles(source.id)));
  return { files: results.flatMap((result) => result.status === "fulfilled" ? result.value : []), missing: results.some((result) => result.status === "rejected") };
}
/** Short read-only rendering of a confirmed field for the "확정된 입력" summary. */
const confirmedValue = (field: BusinessField, input: BusinessInput): string => {
  if (field.type === "file") return (input.files[field.key] ?? []).map((file) => file.relativePath || file.name).join(", ");
  if (field.type === "movements") return "확인 완료";
  return input.values[field.key] ?? "";
};

/**
 * Pressing the card's submit button is the acknowledgement: an untouched movements table means "plan as-is" (the tool reads "확인" as
 * no edits) and a `confirm` field carries exactly the string the tool expects. Confirm values override stale ones from an earlier round.
 */
const withDefaults = (action: BusinessAction): BusinessInput => ({
  ...action.input,
  values: {
    ...Object.fromEntries(action.fields.filter((field) => field.type === "movements").map((field) => [field.key, "확인"])),
    ...action.input.values,
    ...Object.fromEntries(action.fields.flatMap((field) => field.confirm ? [[field.key, field.confirm]] : [])),
  },
});

/**
 * Inline chat card for one `business_tool` question. The question itself is already an assistant message,
 * so the card shows only the fields still open for this step; confirmed inputs collapse into a summary.
 */
export default function BusinessToolCard({ api, runId, action }: { api: KetchupEAgentAPI; runId: string; action: BusinessAction }) {
  const [input, setInput] = useState<BusinessInput>(() => withDefaults(action));
  const [files, setFiles] = useState<WorkFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const locked = new Set(action.lockedKeys ?? []);
  const open = action.fields.filter((field) => !locked.has(field.key));
  const confirmed = action.fields.filter((field) => locked.has(field.key) && confirmedValue(field, input));
  const needsFiles = open.some((field) => field.type === "file");
  useEffect(() => {
    if (!needsFiles) return;
    let alive = true;
    void api.listWorkSources().then((sources) => availableFiles(api, sources)).then((result) => { if (alive) { setFiles(result.files); if (result.missing) setError("일부 연결된 자료를 찾을 수 없습니다. 파일 탭의 검색 폴더를 확인하거나 파일을 다시 선택해 주세요."); } }).catch((cause) => { if (alive) setError(String(cause)); });
    return () => { alive = false; };
  }, [api, needsFiles]);
  const perform = async (fn: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await fn(); } catch (cause) { setError(String(cause)); } finally { setBusy(false); }
  };
  const setValue = (key: string, value: string) => setInput((current) => ({ ...current, values: { ...current.values, [key]: value } }));
  return <div className="flex items-start w-full mb-3">
    <img src={KetchupE} alt="" className="w-7 h-7 object-cover" />
    <form aria-label={`${action.title} 입력`} onSubmit={(event) => { event.preventDefault(); void perform(async () => { await api.submitBusinessInput(runId, action.id, input); }); }}
      className="flex-1 min-w-0 px-4 py-3 rounded-2xl border border-[#E4E4E7] dark:border-[#27272A] bg-white dark:bg-[#18181B] text-sm text-[#18181B] dark:text-[#FAFAFA]">
      {confirmed.length > 0 && <details className="mb-3 text-xs text-[#71717A]">
        <summary className="cursor-pointer">확정된 입력 {confirmed.length}개</summary>
        <ul className="mt-1 grid gap-0.5">{confirmed.map((field) => <li key={field.key}>{field.label}: {confirmedValue(field, input)}</li>)}</ul>
      </details>}
      {error && <p role="alert" className="mb-2 text-xs text-[#DC2626]">{error}</p>}
      <fieldset disabled={busy} className="grid gap-3">
        {open.map((field) => {
          const label = `${field.label}${field.required ? " *" : ""}`;
          if (field.confirm) return <p key={field.key} className="flex items-center gap-1.5 text-[#52525B] dark:text-[#A1A1AA]"><LuCheck aria-hidden className="shrink-0 text-[#0066FF]" />{field.label}</p>;
          if (field.type === "movements") return <fieldset key={field.key} className="grid gap-1"><legend className="font-medium">{label}</legend>
            <MovementsEditor field={field} value={input.values[field.key]} disabled={busy} onChange={(value) => setValue(field.key, value)} />
          </fieldset>;
          if (field.type !== "file") return <label key={field.key} className="grid gap-1"><span className="font-medium">{label}</span>
            {field.type === "text" ? <textarea className={control} rows={3} required={field.required} maxLength={4000} value={input.values[field.key] ?? ""} onChange={(event) => setValue(field.key, event.target.value)} /> : <input className={control} type={field.type} step={field.type === "number" ? "any" : undefined} inputMode={field.type === "number" ? "decimal" : undefined} required={field.required} maxLength={4000} value={input.values[field.key] ?? ""} onChange={(event) => setValue(field.key, event.target.value)} />}
          </label>;
          const chosen = input.files[field.key] ?? [];
          // Single-file fields replace the selection; multi-file fields append without duplicates.
          const choose = (picked: WorkFile[]) => setInput((current) => {
            const merged = field.multiple ? [...(current.files[field.key] ?? []), ...picked] : picked.slice(0, 1);
            const unique = merged.filter((file, index) => merged.findIndex((item) => sameFile(item, file)) === index);
            return { ...current, files: { ...current.files, [field.key]: unique } };
          });
          const remove = (file: WorkFile) => setInput((current) => ({ ...current, files: { ...current.files, [field.key]: (current.files[field.key] ?? []).filter((item) => !sameFile(item, file)) } }));
          return <fieldset key={field.key} className="grid gap-1">
            <legend className="font-medium">{label}{field.multiple ? " (여러 파일 가능)" : ""}</legend>
            <ul aria-label={`${field.label} 선택된 파일`} className="grid gap-1">
              {chosen.map((file) => <li key={`${file.sourceId}:${file.relativePath}`} className="flex justify-between gap-2"><span className="inline-flex items-center gap-1 min-w-0 truncate"><LuFile aria-hidden className="shrink-0" />{file.relativePath || file.name}</span><button type="button" onClick={() => remove(file)} aria-label={`${file.name} 빼기`} className="text-xs text-[#71717A] hover:text-[#DC2626]">빼기</button></li>)}
            </ul>
            <div className="flex flex-wrap gap-2">
              <button className={control} type="button" onClick={() => void perform(async () => choose(await api.pickWorkFiles(Boolean(field.multiple))))}>{field.multiple ? "파일 추가…" : "파일 선택…"}</button>
              {files.length > 0 && <select aria-label={`${field.label} 연결된 자료에서 고르기`} className={control} value="" onChange={(event) => { const file = files.find((item) => JSON.stringify(item) === event.target.value); if (file) choose([file]); }}>
                <option value="">연결된 자료에서 고르기</option>
                {files.filter((file) => !chosen.some((item) => sameFile(item, file))).map((file) => <option key={`${file.sourceId}:${file.relativePath}`} value={JSON.stringify(file)}>{file.relativePath || file.name}</option>)}
              </select>}
            </div>
          </fieldset>;
        })}
        <div className="flex justify-end">
          <button type="submit" className="rounded-lg bg-[#0066FF] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#0052CC] disabled:opacity-60">{open.length === 0 ? "다시 실행" : needsFiles ? "이 자료로 실행" : "확인하고 계속"}</button>
        </div>
      </fieldset>
      {busy && <p role="status" className="mt-2 text-xs text-[#71717A]">업무를 실행하고 있습니다. 작업 중단으로 취소할 수 있습니다.</p>}
    </form>
  </div>;
}

export function BusinessArtifacts({ api, threadId, running }: { api: KetchupEAgentAPI; threadId: string; running: boolean }) {
  const [items, setItems] = useState<BusinessArtifact[]>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState("");
  useEffect(() => {
    let alive = true; setItems([]); setError(""); setSaved("");
    void api.listBusinessArtifacts(threadId).then((result) => { if (alive) setItems(result); }).catch((cause) => { if (alive) setError(String(cause)); });
    return () => { alive = false; };
  }, [api, threadId, running]);
  const save = async (item: BusinessArtifact) => {
    setSaving(true); setError(""); setSaved("");
    try { if (await api.saveBusinessArtifact(item.id)) setSaved(`${item.name} 저장 완료`); }
    catch (cause) { setError(String(cause)); }
    finally { setSaving(false); }
  };
  return <div className="flex flex-wrap gap-2 mb-2">
    {items.map((item) => {
      const isPng = /\.png$/i.test(item.name);
      return <button key={item.id} className={`${control} inline-flex items-center gap-1 text-black dark:text-white`} type="button" disabled={isPng && saving} onClick={() => {
        if (isPng) void save(item);
        else void api.openBusinessArtifact(item.id).catch((cause) => setError(String(cause)));
      }}>{isPng ? <LuDownload aria-hidden /> : <LuFile aria-hidden />}{item.name} {isPng ? "다운로드" : "열기"} · v{item.version}</button>;
    })}
    {saved && <p role="status">{saved}</p>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
