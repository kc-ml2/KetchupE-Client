import { useEffect, useRef, useState } from "react";
import type { ExtractionPreview, SourceMapping, SourceProfile, SourceValueType, WorkbookOverview, WorkFile, WorkSource, WorkSourceAPI } from "@app-types/WorkSource.types";

const FIELDS: Array<{ field: string; label: string; type: SourceValueType }> = [
  { field: "date", label: "거래일", type: "date" },
  { field: "accountId", label: "계좌번호", type: "text" },
  { field: "counterpartyId", label: "거래처 코드", type: "text" },
  { field: "counterpartyName", label: "거래처명", type: "text" },
  { field: "currency", label: "통화", type: "text" },
  { field: "openingBalance", label: "기초잔액", type: "decimal" },
  { field: "inflow", label: "입금액", type: "decimal" },
  { field: "outflow", label: "출금액", type: "decimal" },
  { field: "closingBalance", label: "마감잔액", type: "decimal" },
  { field: "amount", label: "금액", type: "decimal" },
  { field: "description", label: "적요", type: "text" },
];
const blankMapping = (): SourceMapping => ({ sheet: "", headerRow: 1, firstDataRow: 2, columns: [], filters: [] });
const control = "rounded border border-[#D4D4D8] dark:border-[#52525B] bg-white dark:bg-[#18181B] p-1.5 text-xs disabled:opacity-50";
const labelFor = (field: string) => FIELDS.find((item) => item.field === field)?.label ?? field;

export default function WorkSourcePanel({ api, onClose, request }: { api: WorkSourceAPI; onClose: () => void; request?: { runId: string; actionId: string } }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [sources, setSources] = useState<WorkSource[]>([]);
  const [files, setFiles] = useState<WorkFile[]>([]);
  const [sourceId, setSourceId] = useState("");
  const [file, setFile] = useState<WorkFile | null>(null);
  const [overview, setOverview] = useState<WorkbookOverview | null>(null);
  const [mapping, setMapping] = useState<SourceMapping>(blankMapping);
  const [profiles, setProfiles] = useState<SourceProfile[]>([]);
  const [profileId, setProfileId] = useState("");
  const [revision, setRevision] = useState(0);
  const [name, setName] = useState("");
  const [preview, setPreview] = useState<ExtractionPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    dialog.current?.showModal();
    let alive = true;
    Promise.all([api.listWorkSources(), api.listSourceProfiles()]).then(([items, saved]) => {
      if (alive) { setSources(items); setProfiles(saved); }
    }).catch((cause) => { if (alive) setError(String(cause)); });
    return () => { alive = false; };
  }, [api]);

  const perform = async (action: () => Promise<void>) => {
    setBusy(true); setError(""); setNotice("");
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const change = (next: SourceMapping) => { setMapping(next); setPreview(null); setNotice(""); };
  const inspect = async (selected: WorkFile, sheet?: string, headerRow = mapping.headerRow) => {
    setOverview(null); setPreview(null);
    const result = await api.inspectWorkFile(selected, sheet, headerRow);
    setOverview(result);
    setMapping((current) => ({ ...current, sheet: result.sheet }));
  };
  const loadProfile = (id: string) => {
    const profile = profiles.find((item) => item.id === id);
    setProfileId(id); setRevision(profile?.revision ?? 0); setName(profile?.name ?? "");
    const next = profile?.mapping ?? { ...blankMapping(), sheet: overview?.sheet ?? "" };
    change(next);
    if (file) void perform(() => inspect(file, next.sheet || undefined, next.headerRow));
  };
  const mapColumn = (field: typeof FIELDS[number], header: string) => {
    const old = mapping.columns.find((column) => column.field === field.field);
    const columns = mapping.columns.filter((column) => column.field !== field.field);
    if (header) columns.push({ field: field.field, header, type: field.type, required: old?.required ?? true });
    change({ ...mapping, columns, filters: mapping.filters.filter((filter) => header || filter.field !== field.field) });
  };

  return <dialog ref={dialog} onCancel={onClose} aria-labelledby="work-source-title" className="w-[min(1100px,94vw)] max-h-[90vh] rounded-xl bg-white dark:bg-[#18181B] text-[#18181B] dark:text-[#FAFAFA] p-6 backdrop:bg-black/40">
    <div className="flex items-center justify-between gap-4 mb-2">
      <h2 id="work-source-title" className="text-lg font-semibold">업무 자료 연결</h2>
      <button type="button" className={control} onClick={onClose}>닫기</button>
    </div>
    <p className="text-sm text-[#71717A] mb-4">PC의 파일·폴더를 선택하고 가져올 정보를 지정하세요. 원본은 업로드·복사·수정하지 않습니다. 이 화면의 미리보기는 PC에서 처리됩니다.</p>
    {error && <p role="alert" className="mb-3 text-sm text-red-600">{error}</p>}
    {notice && <p role="status" className="mb-3 text-sm">{notice}</p>}
    <fieldset disabled={busy} className="space-y-5 min-w-0">
      <div className="flex flex-wrap gap-2">
        <button type="button" className={control} onClick={() => void perform(async () => setSources(await api.pickWorkSources("file")))}>파일 선택</button>
        <button type="button" className={control} onClick={() => void perform(async () => setSources(await api.pickWorkSources("folder")))}>폴더 선택</button>
        <span className="text-xs self-center text-[#71717A]">XLSX · 하위 폴더 포함 · 연결은 이 PC에 저장됩니다</span>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="grid gap-1 text-xs">연결된 자료
          <select className={control} value={sourceId} onChange={(event) => {
            const id = event.target.value; setSourceId(id); setFile(null); setFiles([]); setOverview(null); setPreview(null);
            if (id) void perform(async () => setFiles(await api.listWorkFiles(id)));
          }}><option value="">자료 선택</option>{sources.map((source) => <option key={source.id} value={source.id}>{source.displayPath}</option>)}</select>
        </label>
        {sourceId && <>
          <button type="button" className={control} onClick={() => void perform(async () => { setFiles(await api.listWorkFiles(sourceId)); setFile(null); setOverview(null); setPreview(null); })}>파일 목록 새로고침</button>
          <button type="button" className={control} onClick={() => void perform(async () => { await api.removeWorkSource(sourceId); setSources(await api.listWorkSources()); setSourceId(""); setFiles([]); setFile(null); setOverview(null); setPreview(null); })}>연결 해제</button>
        </>}
        <label className="grid gap-1 text-xs">작업 파일
          <select className={control} value={file ? JSON.stringify(file) : ""} onChange={(event) => {
            const selected = files.find((item) => JSON.stringify(item) === event.target.value) ?? null;
            setFile(selected); setOverview(null); setPreview(null);
            if (selected) void perform(() => inspect(selected, profileId ? mapping.sheet : undefined));
          }}><option value="">파일 선택</option>{files.map((item) => <option key={item.relativePath} value={JSON.stringify(item)}>{item.relativePath || item.name}</option>)}</select>
        </label>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="grid gap-1 text-xs">저장된 매핑
          <select className={control} value={profileId} onChange={(event) => loadProfile(event.target.value)}><option value="">새로 만들기</option>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · v{profile.revision}</option>)}</select>
        </label>
        <label className="grid gap-1 text-xs">매핑 이름<input className={control} maxLength={100} value={name} onChange={(event) => setName(event.target.value)} placeholder="예: ERP 입출금 내역" /></label>
        {profileId && <button type="button" className={control} onClick={() => void perform(async () => { await api.removeSourceProfile(profileId); setProfiles(await api.listSourceProfiles()); setProfileId(""); setRevision(0); setNotice("저장된 매핑을 삭제했습니다."); })}>매핑 삭제</button>}
      </div>
      {file && <div className="flex flex-wrap items-end gap-3">
        <label className="grid gap-1 text-xs">시트<select className={control} value={mapping.sheet} onChange={(event) => { const sheet = event.target.value; change({ ...mapping, sheet }); void perform(() => inspect(file, sheet)); }}>
          {overview?.sheets.map((sheet) => <option key={sheet.name} value={sheet.name}>{sheet.name}{sheet.hidden ? " (숨김)" : ""}</option>)}
        </select></label>
        <label className="grid gap-1 text-xs">헤더 행<input className={`${control} w-24`} type="number" min={1} max={100000} value={mapping.headerRow} onChange={(event) => { setOverview(null); change({ ...mapping, headerRow: Number(event.target.value) }); }} /></label>
        <label className="grid gap-1 text-xs">데이터 시작 행<input className={`${control} w-24`} type="number" min={1} max={100000} value={mapping.firstDataRow} onChange={(event) => change({ ...mapping, firstDataRow: Number(event.target.value) })} /></label>
        <label className="grid gap-1 text-xs">마지막 행 (빈칸: 끝까지)<input className={`${control} w-24`} type="number" min={1} max={100000} value={mapping.lastDataRow ?? ""} onChange={(event) => change({ ...mapping, lastDataRow: event.target.value ? Number(event.target.value) : undefined })} /></label>
        <button type="button" className={control} onClick={() => void perform(() => inspect(file, mapping.sheet || undefined))}>원본 다시 읽기</button>
      </div>}
      {overview && <>
        <div className="overflow-auto max-h-56 border border-[#D4D4D8] dark:border-[#52525B]">
          <table className="text-xs border-collapse w-full"><caption className="text-left p-2">원본 미리보기 · 헤더 행부터 최대 12행·30열 · 수식은 표시만 하며 추출 시 확인 필요</caption>
            <thead><tr><th className="p-2">행</th>{overview.rows[0]?.cells.map((cell) => <th className="p-2" key={cell.address}>{cell.address.replace(/\d+$/, "")}</th>)}</tr></thead>
            <tbody>{overview.rows.map((row) => <tr key={row.row}><th className="p-2">{row.row}</th>{row.cells.map((cell) => <td key={cell.address} title={cell.address} className="p-2 border-t border-[#E4E4E7] dark:border-[#52525B] whitespace-nowrap">{cell.formula ? "[수식] " : ""}{cell.text}</td>)}</tr>)}</tbody>
          </table>
        </div>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {FIELDS.map((field) => {
            const column = mapping.columns.find((item) => item.field === field.field);
            return <div key={field.field} className="flex items-end gap-2">
              <label className="grid gap-1 text-xs flex-1">{field.label}<select className={`${control} w-full`} value={column?.header ?? ""} onChange={(event) => mapColumn(field, event.target.value)}>
                <option value="">사용 안 함</option>{overview.headers.filter((item) => item.text).map((item) => <option key={item.column} value={item.text}>{item.text} ({item.column}열)</option>)}
              </select></label>
              {column && <label className="text-xs pb-2"><input type="checkbox" aria-label={`${field.label} 필수`} checked={column.required} onChange={(event) => change({ ...mapping, columns: mapping.columns.map((item) => item.field === field.field ? { ...item, required: event.target.checked } : item) })} /> 필수</label>}
            </div>;
          })}
        </div>
        <div className="space-y-2">
          <p className="text-xs">행 조건 · 모든 조건을 만족하는 행만 가져옵니다. 조건이 없으면 지정 범위 전체를 읽습니다.</p>
          {mapping.filters.map((filter, index) => <div key={index} className="flex gap-2">
            <select aria-label={`조건 ${index + 1} 항목`} className={control} value={filter.field} onChange={(event) => change({ ...mapping, filters: mapping.filters.map((item, i) => i === index ? { ...item, field: event.target.value } : item) })}>{mapping.columns.map((column) => <option key={column.field} value={column.field}>{labelFor(column.field)}</option>)}</select>
            <select aria-label={`조건 ${index + 1} 비교`} className={control} value={filter.operator} onChange={(event) => change({ ...mapping, filters: mapping.filters.map((item, i) => i === index ? { ...item, operator: event.target.value as "equals" | "notEquals" } : item) })}><option value="equals">같음</option><option value="notEquals">다름</option></select>
            <input aria-label={`조건 ${index + 1} 값`} className={control} value={filter.value} placeholder="예: 2026-10-14 또는 KRW" onChange={(event) => change({ ...mapping, filters: mapping.filters.map((item, i) => i === index ? { ...item, value: event.target.value } : item) })} />
            <button type="button" className={control} onClick={() => change({ ...mapping, filters: mapping.filters.filter((_, i) => i !== index) })}>삭제</button>
          </div>)}
          <button type="button" className={control} disabled={!mapping.columns.length} onClick={() => change({ ...mapping, filters: [...mapping.filters, { field: mapping.columns[0].field, operator: "equals", value: "" }] })}>행 조건 추가</button>
        </div>
        <div className="flex gap-2">
          <button type="button" className={control} disabled={!mapping.columns.length} onClick={() => void perform(async () => { setPreview(null); setPreview(await api.previewSourceMapping(file!, overview.fingerprint, mapping)); })}>추출 검증</button>
          <button type="button" className={control} disabled={!name.trim() || !preview || preview.issueCount > 0 || !preview.matchedRows} onClick={() => void perform(async () => {
            const saved = await api.saveSourceProfile(file!, overview.fingerprint, { id: profileId, name, revision, mapping });
            setProfileId(saved.id); setRevision(saved.revision); setProfiles(await api.listSourceProfiles()); setNotice(`'${saved.name}' 매핑 v${saved.revision}을 저장했습니다. 다른 파일에도 불러와 적용할 수 있습니다.`);
          })}>검증한 매핑 저장</button>
        </div>
      </>}
      {preview && <div className="space-y-2 text-xs">
        <p role="status">검사 {preview.scannedRows}행 · 추출 {preview.matchedRows}행 · 조건 제외 {preview.excludedRows}행 · 빈 행 {preview.blankRows}개 · 오류 {preview.issueCount}건</p>
        {preview.issues.length > 0 && <ul className="text-red-600">{preview.issues.map((issue, index) => <li key={index}>{issue.row}행 / {labelFor(issue.field)}: {issue.message}</li>)}{preview.issueCount > preview.issues.length && <li>처음 100건만 표시합니다.</li>}</ul>}
        <div className="overflow-auto max-h-64"><table className="w-full"><caption className="text-left">추출 결과 · 처음 20행 · 셀에 마우스를 올리면 출처 표시</caption><thead><tr><th>원본 행</th>{mapping.columns.map((column) => <th key={column.field} className="p-2">{labelFor(column.field)}</th>)}</tr></thead><tbody>{preview.rows.map((row) => <tr key={row.row}><th>{row.row}</th>{mapping.columns.map((column) => <td key={column.field} title={`${mapping.sheet}!${row.cells[column.field]}`} className="p-2 whitespace-nowrap">{row.values[column.field] ?? "(빈 값)"}</td>)}</tr>)}</tbody></table></div>
      </div>}
      {request && <button type="button" className={control} disabled={!file || !overview || !preview || preview.issueCount > 0 || !preview.matchedRows || !profiles.some((item) => item.id === profileId && item.revision === revision && JSON.stringify(item.mapping) === JSON.stringify(mapping))} onClick={() => void perform(async () => {
        await api.submitWorkSelection(request.runId, request.actionId, { file: file!, fingerprint: overview!.fingerprint, profileId, profileRevision: revision });
        onClose();
      })}>이 자료로 계속</button>}
    </fieldset>
    {busy && <p role="status" className="text-sm mt-3">업무 자료를 확인하는 중…</p>}
    <p className="text-xs text-[#71717A] mt-5">현재 단계는 원천 자료 연결과 추출 규칙 검증입니다. 일일자금일보 계산·출력은 담당자와 업무 기준을 확인한 뒤 연결합니다.</p>
  </dialog>;
}
