import type { BusinessField } from "@app-types/BusinessTool.types";

const control = "min-h-9 min-w-0 rounded-lg border border-[#D4D4D8] bg-white px-3 py-2 text-sm text-[#18181B] outline-none focus-visible:ring-2 focus-visible:ring-[#71717A] dark:border-[#52525B] dark:bg-[#27272A] dark:text-[#FAFAFA] disabled:opacity-50 dark:[color-scheme:dark]";

export default function AccountBindingsEditor({ field, value, disabled, onChange }: { field: BusinessField; value?: string; disabled: boolean; onChange: (value: string) => void }) {
  let bindings: Record<string, string> = {};
  try {
    const parsed: unknown = JSON.parse(value ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) bindings = Object.fromEntries(Object.entries(parsed).filter(([, cell]) => typeof cell === "string"));
  } catch { /* A malformed older answer can be replaced through the form. */ }
  return <div className="grid gap-3">
    {(field.accountRows ?? []).map((account) => {
      const cell = bindings[account.key]?.match(/^([HP]?)(\d*)$/);
      const column = cell?.[1] ?? "", row = cell?.[2] ?? "";
      const update = (nextColumn: string, nextRow: string) => onChange(JSON.stringify({ ...bindings, [account.key]: `${nextColumn}${nextRow}` }));
      return <fieldset key={account.key} className="min-w-0 rounded-xl border border-[#E4E4E7] p-3 dark:border-[#3F3F46]">
        <legend className="px-1 text-sm font-medium">{account.name}</legend>
        <dl className="mb-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs leading-5">
          <dt>계좌코드</dt><dd className="break-all">{account.key.slice(0, account.key.lastIndexOf(":"))}</dd>
          <dt>통화</dt><dd>{account.currency}</dd>
          <dt>계좌잔고</dt><dd>{account.balance}</dd>
          <dt>만기일</dt><dd>{account.maturity ?? "없음"}</dd>
        </dl>
        <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
          <label className="grid gap-1 text-xs">일보 영역
            <select aria-label={`${account.key} 일보 영역`} className={control} required={field.required} disabled={disabled} value={column} onChange={(event) => update(event.target.value, row)}>
              <option value="">선택해 주세요</option>
              <option value="H">H열 · 본표 금일금액</option>
              <option value="P">P열 · 사업부문 잔고</option>
            </select>
          </label>
          <label className="grid gap-1 text-xs">행 번호
            <input aria-label={`${account.key} 행 번호`} className={control} type="number" inputMode="numeric" min={1} max={999} step={1} required={field.required} disabled={disabled} placeholder="예: 12" value={row} onChange={(event) => update(column, event.target.value)} />
          </label>
        </div>
        {column && row && <p className="mt-2 text-xs text-[#52525B] dark:text-[#A1A1AA]">연결할 셀: {column}{row}</p>}
      </fieldset>;
    })}
  </div>;
}
