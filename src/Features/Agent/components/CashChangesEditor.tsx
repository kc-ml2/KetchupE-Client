import type { BusinessField } from "@app-types/BusinessTool.types";

const control = "min-h-9 min-w-0 rounded-lg border border-[#D4D4D8] bg-white px-3 py-2 text-sm text-[#18181B] outline-none focus-visible:ring-2 focus-visible:ring-[#71717A] dark:border-[#52525B] dark:bg-[#27272A] dark:text-[#FAFAFA] disabled:opacity-50";

export default function CashChangesEditor({ field, value, disabled, onChange }: { field: BusinessField; value?: string; disabled: boolean; onChange: (value: string) => void }) {
  const rows = field.cashRows ?? [];
  const amounts: Record<string, { incoming: string; outgoing: string }> = {};
  try {
    const parsed = JSON.parse(value ?? "{}");
    for (const row of rows) {
      const entry = parsed?.[row.key];
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const amount = (v: unknown) => typeof v === "string" || typeof v === "number" ? String(v) : "";
      amounts[row.key] = { incoming: amount(entry.incoming), outgoing: amount(entry.outgoing) };
    }
  } catch { /* Malformed saved answers are replaced through the labeled inputs. */ }
  return <div className="grid gap-3">
    <p className="text-xs leading-5 text-[#52525B] dark:text-[#A1A1AA]">확인한 실제 입금·출금 총액을 입력하세요. 거래가 없으면 0을 입력하세요.</p>
    {rows.map((row) => <fieldset key={row.key} className="min-w-0 rounded-xl border border-[#E4E4E7] p-3 dark:border-[#3F3F46]">
      <legend className="px-1 text-sm font-medium">{row.name}</legend>
      <p className="mb-3 break-all text-xs leading-5">계좌코드: {row.key.slice(0, row.key.lastIndexOf(":"))} · 통화: {row.currency}<br />전일 금액: {row.opening} · 계좌잔고: {row.balance}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {(["incoming", "outgoing"] as const).map((direction) => {
          const label = direction === "incoming" ? "실제 입금 총액" : "실제 출금 총액";
          return <label key={direction} className="grid gap-1 text-xs">{label}
            <input className={control} aria-label={`${row.key} ${label}`} type="number" min={0} step="any" inputMode="decimal" required={field.required} disabled={disabled}
              value={amounts[row.key]?.[direction] ?? ""} onChange={(event) => onChange(JSON.stringify({ ...amounts, [row.key]: { ...(amounts[row.key] ?? { incoming: "", outgoing: "" }), [direction]: event.target.value } }))} />
          </label>;
        })}
      </div>
    </fieldset>)}
  </div>;
}
