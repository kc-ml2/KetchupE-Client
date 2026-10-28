import { useEffect, useState } from "react";
import { LuArrowUp, LuCheck, LuChevronDown, LuDownload, LuFile, LuPaperclip, LuX } from "react-icons/lu";
import type { KetchupEAgentAPI } from "@app-types/Agent.types";
import type { BusinessAction, BusinessArtifact, BusinessField, BusinessInput } from "@app-types/BusinessTool.types";
import type { WorkFile, WorkSource } from "@app-types/WorkSource.types";
import KetchupE from "@images/rag.png";
import MovementsEditor from "./MovementsEditor";

const control = "rounded border border-[#D4D4D8] dark:border-[#52525B] p-2 bg-white dark:bg-[#18181B] text-sm disabled:opacity-50";
const fieldControl = "min-w-0 border border-[#D4D4D8] bg-white px-3 py-2 text-sm text-[#18181B] outline-none hover:border-[#A1A1AA] focus-visible:border-[#71717A] focus-visible:ring-1 focus-visible:ring-[#71717A] dark:border-[#52525B] dark:bg-[#27272A] dark:text-[#FAFAFA] dark:hover:border-[#71717A] dark:focus-visible:border-[#A1A1AA] dark:focus-visible:ring-[#A1A1AA] disabled:cursor-not-allowed disabled:opacity-50 dark:[color-scheme:dark]";
const fieldLabel = "text-xs font-medium leading-5 text-[#52525B] dark:text-[#A1A1AA]";
const fileButton = "inline-flex min-h-9 items-center justify-center gap-2 rounded-full border border-[#E4E4E7] bg-white px-3 py-1.5 text-xs text-[#52525B] hover:bg-[#F4F4F5] active:bg-[#E4E4E7] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#71717A] dark:border-[#3F3F46] dark:bg-[#27272A] dark:text-[#D4D4D8] dark:hover:bg-[#3F3F46] dark:active:bg-[#52525B] disabled:cursor-not-allowed disabled:opacity-50";
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
  const open = action.fields.filter((field) => !locked.has(field.key) && (field.key !== "revision" || Boolean(action.input.values.revision)));
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
  return <div className="flex items-start gap-3 w-full mt-6 mb-3">
    <img src={KetchupE} alt="" className="w-7 h-7 shrink-0 object-cover" />
    <form aria-label={`${action.title} 입력`} onSubmit={(event) => { event.preventDefault(); void perform(async () => { await api.submitBusinessInput(runId, action.id, input); }); }}
      className="flex-1 min-w-0 rounded-2xl border border-[#E4E4E7] bg-[#FAFAFA] p-4 text-sm text-[#18181B] dark:border-[#3F3F46] dark:bg-[#202022] dark:text-[#FAFAFA] sm:p-5">
      {confirmed.length > 0 && <details className="mb-4 rounded-xl bg-black/[0.03] px-3 py-2 text-xs text-[#52525B] dark:bg-white/[0.04] dark:text-[#A1A1AA]">
        <summary className="cursor-pointer rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#71717A]">확정된 입력 {confirmed.length}개</summary>
        <ul className="mt-2 grid gap-1 break-words">{confirmed.map((field) => <li key={field.key}>{field.label}: {confirmedValue(field, input)}</li>)}</ul>
      </details>}
      {error && <p role="alert" className="mb-4 rounded-lg bg-[#FEF2F2] px-3 py-2 text-xs leading-relaxed text-[#B91C1C] dark:bg-[#450A0A] dark:text-[#FCA5A5]">{error}</p>}
      <fieldset disabled={busy} className="grid min-w-0 gap-5">
        {open.map((field) => {
          const label = `${field.label}${field.required ? " *" : ""}`;
          if (field.confirm) return <p key={field.key} className="flex items-center gap-2 text-[#52525B] dark:text-[#A1A1AA]"><LuCheck aria-hidden className="shrink-0" />{field.label}</p>;
          if (field.type === "movements") return <fieldset key={field.key} className="grid min-w-0 gap-2"><legend className={`${fieldLabel} mb-2`}>{label}</legend>
            <MovementsEditor field={field} value={input.values[field.key]} disabled={busy} onChange={(value) => setValue(field.key, value)} />
          </fieldset>;
          if (field.type === "select") return <label key={field.key} className="flex flex-wrap items-center justify-between gap-2"><span className={fieldLabel}>{label}</span>
            <span className="relative max-w-full">
            <select className={`${fieldControl} w-full appearance-none rounded-full pr-9`} required={field.required} value={input.values[field.key] ?? ""} onChange={(event) => setValue(field.key, event.target.value)}>
              <option value="">{field.required ? "선택해 주세요" : "요청에서 판단"}</option>
              {field.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            <LuChevronDown aria-hidden className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#71717A] dark:text-[#A1A1AA]" />
            </span>
          </label>;
          if (field.type !== "file") return <label key={field.key} className={field.type === "text" ? "grid gap-2" : "flex flex-wrap items-center justify-between gap-2"}><span className={fieldLabel}>{label}</span>
            {field.type === "text" ? <textarea className={`${fieldControl} w-full min-h-24 resize-y rounded-xl leading-7 placeholder:text-[#71717A] dark:placeholder:text-[#A1A1AA]`} rows={3} placeholder="내용을 입력해 주세요" required={field.required} maxLength={4000} value={input.values[field.key] ?? ""} onChange={(event) => setValue(field.key, event.target.value)} /> : <input className={`${fieldControl} w-full max-w-xs rounded-lg`} type={field.type} step={field.type === "number" ? "any" : undefined} inputMode={field.type === "number" ? "decimal" : undefined} required={field.required} maxLength={4000} value={input.values[field.key] ?? ""} onChange={(event) => setValue(field.key, event.target.value)} />}
          </label>;
          const chosen = input.files[field.key] ?? [];
          // Single-file fields replace the selection; multi-file fields append without duplicates.
          const choose = (picked: WorkFile[]) => setInput((current) => {
            const merged = field.multiple ? [...(current.files[field.key] ?? []), ...picked] : picked.slice(0, 1);
            const unique = merged.filter((file, index) => merged.findIndex((item) => sameFile(item, file)) === index);
            return { ...current, files: { ...current.files, [field.key]: unique } };
          });
          const remove = (file: WorkFile) => setInput((current) => ({ ...current, files: { ...current.files, [field.key]: (current.files[field.key] ?? []).filter((item) => !sameFile(item, file)) } }));
          return <fieldset key={field.key} className="grid min-w-0 gap-3">
            <legend className={`${fieldLabel} mb-2`}>{label}{field.multiple && <span className="ml-2 font-normal">여러 파일 가능</span>}</legend>
            <ul aria-label={`${field.label} 선택된 파일`} className="flex min-w-0 flex-wrap gap-2 empty:hidden">
              {chosen.map((file) => <li key={`${file.sourceId}:${file.relativePath}`} className="flex max-w-full items-center gap-2 rounded-xl border border-[#E4E4E7] bg-white py-1 pl-3 pr-1 dark:border-[#3F3F46] dark:bg-[#27272A]"><LuFile aria-hidden className="h-4 w-4 shrink-0 text-[#71717A] dark:text-[#A1A1AA]" /><span title={file.relativePath || file.name} className="min-w-0 truncate text-xs">{file.relativePath || file.name}</span><button type="button" onClick={() => remove(file)} aria-label={`${file.name} 빼기`} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[#71717A] hover:bg-[#F4F4F5] hover:text-[#18181B] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#71717A] dark:text-[#A1A1AA] dark:hover:bg-[#3F3F46] dark:hover:text-white"><LuX aria-hidden className="h-3.5 w-3.5" /></button></li>)}
            </ul>
            <div className="flex flex-wrap gap-2">
              <button className={fileButton} type="button" onClick={() => void perform(async () => choose(await api.pickWorkFiles(Boolean(field.multiple))))}><LuPaperclip aria-hidden className="h-3.5 w-3.5" />{field.multiple ? "파일 추가…" : "파일 선택…"}</button>
              {files.length > 0 && <span className="relative min-w-0 max-w-full"><select aria-label={`${field.label} 연결된 자료에서 고르기`} className={`${fileButton} w-full appearance-none pr-9 dark:[color-scheme:dark]`} value="" onChange={(event) => { const file = files.find((item) => JSON.stringify(item) === event.target.value); if (file) choose([file]); }}>
                <option value="">연결된 자료에서 고르기</option>
                {files.filter((file) => !chosen.some((item) => sameFile(item, file))).map((file) => <option key={`${file.sourceId}:${file.relativePath}`} value={JSON.stringify(file)}>{file.relativePath || file.name}</option>)}
              </select><LuChevronDown aria-hidden className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#71717A] dark:text-[#A1A1AA]" /></span>}
            </div>
          </fieldset>;
        })}
        <div className="flex justify-end border-t border-[#E4E4E7] pt-4 dark:border-[#3F3F46]">
          <button type="submit" className="inline-flex min-h-9 items-center gap-2 rounded-full bg-[#18181B] py-2 pl-4 pr-3 text-xs font-medium text-white hover:bg-[#3F3F46] active:bg-[#52525B] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#71717A] dark:bg-[#FAFAFA] dark:text-[#18181B] dark:hover:bg-[#D4D4D8] dark:active:bg-[#A1A1AA] disabled:cursor-not-allowed disabled:opacity-50">{open.length === 0 ? "다시 실행" : needsFiles ? "이 자료로 실행" : "확인하고 계속"}<LuArrowUp aria-hidden className="h-4 w-4" /></button>
        </div>
      </fieldset>
      {busy && <p role="status" className="mt-3 text-xs leading-relaxed text-[#52525B] dark:text-[#A1A1AA]">업무를 실행하고 있습니다. 작업 중단으로 취소할 수 있습니다.</p>}
    </form>
  </div>;
}

export function BusinessArtifacts({ api, threadId, running, onRevise }: { api: KetchupEAgentAPI; threadId: string; running: boolean; onRevise?: () => void }) {
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
      return <span key={item.id} className="inline-flex gap-1"><button className={`${control} inline-flex items-center gap-1 text-black dark:text-white`} type="button" disabled={isPng && saving} onClick={() => {
        if (isPng) void save(item);
        else void api.openBusinessArtifact(item.id).catch((cause) => setError(String(cause)));
      }}>{isPng ? <LuDownload aria-hidden /> : <LuFile aria-hidden />}{item.name} {isPng ? "다운로드" : "열기"} · v{item.version}</button>{!isPng && <button type="button" className={control} disabled={saving} aria-label={`${item.name} 저장`} onClick={() => void save(item)}><LuDownload aria-hidden /> 저장</button>}</span>;
    })}
    {onRevise && items.some(item => item.toolId === "excel_work") && <button type="button" className={control} disabled={running} onClick={onRevise}>엑셀 결과 수정하기</button>}
    {saved && <p role="status">{saved}</p>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
