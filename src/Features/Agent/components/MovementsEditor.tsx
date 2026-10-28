import { useState } from "react";
import { LuPlus } from "react-icons/lu";
import type { BusinessField, MovementEdits, PlannedMovement } from "@app-types/BusinessTool.types";

const cell = "min-h-9 min-w-0 rounded-lg border border-[#D4D4D8] bg-white px-2 py-1.5 text-sm text-[#18181B] outline-none hover:border-[#A1A1AA] focus-visible:border-[#71717A] focus-visible:ring-1 focus-visible:ring-[#71717A] dark:border-[#52525B] dark:bg-[#27272A] dark:text-[#FAFAFA] dark:hover:border-[#71717A] dark:focus-visible:border-[#A1A1AA] dark:focus-visible:ring-[#A1A1AA] disabled:cursor-not-allowed disabled:opacity-50 dark:[color-scheme:dark]";
const button = "inline-flex min-h-9 items-center justify-center gap-2 rounded-full border border-[#E4E4E7] bg-white px-3 py-1.5 text-xs text-[#52525B] hover:bg-[#F4F4F5] active:bg-[#E4E4E7] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#71717A] dark:border-[#3F3F46] dark:bg-[#27272A] dark:text-[#D4D4D8] dark:hover:bg-[#3F3F46] dark:active:bg-[#52525B] disabled:cursor-not-allowed disabled:opacity-50";
const DIRECTION_LABEL = { in: "입금", out: "지급" } as const;
const emptyEdits = (): MovementEdits => ({ changes: [], add: [] });
/** A submitted value is the JSON this table produced; "확인" or anything else means no edits. */
function parseEdits(value: string | undefined): MovementEdits {
  try { const parsed = JSON.parse(value ?? "") as Partial<MovementEdits>; return { changes: parsed.changes ?? [], add: parsed.add ?? [] }; }
  catch { return emptyEdits(); }
}

/** Table of planned movements with an editable actual amount per row (0 = not executed) plus rows for unplanned transactions. */
export default function MovementsEditor({ field, value, disabled, onChange }: { field: BusinessField; value: string | undefined; disabled: boolean; onChange: (serialized: string) => void }) {
  const rows: PlannedMovement[] = field.rows ?? [];
  const [edits, setEdits] = useState<MovementEdits>(() => parseEdits(value));
  const update = (next: MovementEdits) => { setEdits(next); onChange(JSON.stringify(next)); };
  const amountOf = (row: PlannedMovement) => edits.changes.find((change) => change.index === row.index)?.amount ?? row.amount;
  const setAmount = (row: PlannedMovement, amount: string) => update({ ...edits, changes: [...edits.changes.filter((change) => change.index !== row.index), ...(amount !== row.amount ? [{ index: row.index, amount }] : [])] });
  const setAdded = (position: number, patch: Partial<MovementEdits["add"][number]>) => update({ ...edits, add: edits.add.map((item, i) => i === position ? { ...item, ...patch } : item) });
  return <div className="grid min-w-0 gap-3">
    <div role="region" aria-label={`${field.label} 거래 표`} tabIndex={0} className="overflow-x-auto rounded-xl border border-[#E4E4E7] bg-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#71717A] dark:border-[#3F3F46] dark:bg-[#202022]">
    <table className="w-full min-w-[640px] text-sm [&_th]:px-3 [&_th]:py-2.5 [&_th]:font-medium [&_td]:px-3 [&_td]:py-2">
      <thead><tr className="bg-[#F4F4F5] text-left text-xs whitespace-nowrap text-[#52525B] dark:bg-[#27272A] dark:text-[#A1A1AA]"><th>#</th><th>구분</th><th>적요</th><th>거래처</th><th className="text-right">계획 금액</th><th className="text-right">실제 금액</th><th /></tr></thead>
      <tbody>
        {rows.length === 0 && edits.add.length === 0 && <tr><td colSpan={7} className="text-xs leading-6 text-[#52525B] dark:text-[#A1A1AA]">해당일 지주현금 계획 없음. 거래가 있었다면 아래에서 추가하세요.</td></tr>}
        {rows.map((row) => <tr key={row.index} className="border-t border-[#E4E4E7] dark:border-[#3F3F46]">
          <td className="text-xs text-[#52525B] dark:text-[#A1A1AA]">{row.index}</td><td className="whitespace-nowrap">{DIRECTION_LABEL[row.direction]}</td><td>{row.description}</td><td>{row.party}</td>
          <td className="text-right tabular-nums">{Number(row.amount).toLocaleString("ko-KR")}</td>
          <td className="text-right"><input className={`${cell} w-32 text-right tabular-nums`} type="number" step="any" min={0} inputMode="decimal" aria-label={`${row.index}번 실제 금액`} disabled={disabled} value={amountOf(row)} onChange={(event) => setAmount(row, event.target.value)} /></td>
          <td className="whitespace-nowrap text-xs text-[#52525B] dark:text-[#A1A1AA]">{amountOf(row) === "0" ? "미집행" : amountOf(row) !== row.amount ? "수정" : ""}</td>
        </tr>)}
        {edits.add.map((item, i) => <tr key={`add-${i}`} className="border-t border-[#E4E4E7] dark:border-[#3F3F46]">
          <td className="whitespace-nowrap text-xs text-[#52525B] dark:text-[#A1A1AA]">추가</td>
          <td><select className={cell} aria-label="추가 거래 구분" disabled={disabled} value={item.direction} onChange={(event) => setAdded(i, { direction: event.target.value as "in" | "out" })}><option value="in">입금</option><option value="out">지급</option></select></td>
          <td><input className={`${cell} w-full min-w-24`} aria-label="추가 거래 적요" required disabled={disabled} value={item.description} onChange={(event) => setAdded(i, { description: event.target.value })} /></td>
          <td><input className={`${cell} w-full min-w-24`} aria-label="추가 거래 거래처" disabled={disabled} value={item.party} onChange={(event) => setAdded(i, { party: event.target.value })} /></td>
          <td />
          <td className="text-right"><input className={`${cell} w-32 text-right tabular-nums`} type="number" step="any" min={0} inputMode="decimal" aria-label="추가 거래 금액" required disabled={disabled} value={item.amount} onChange={(event) => setAdded(i, { amount: event.target.value })} /></td>
          <td><button type="button" className={`${button} whitespace-nowrap`} disabled={disabled} onClick={() => update({ ...edits, add: edits.add.filter((_, j) => j !== i) })}>빼기</button></td>
        </tr>)}
      </tbody>
    </table>
    </div>
    <div><button type="button" className={button} disabled={disabled} onClick={() => update({ ...edits, add: [...edits.add, { direction: "out", description: "", party: "", amount: "" }] })}><LuPlus aria-hidden className="h-3.5 w-3.5" />계획에 없는 거래 추가</button></div>
  </div>;
}
