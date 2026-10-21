import { useState } from "react";
import type { BusinessField, MovementEdits, PlannedMovement } from "@app-types/BusinessTool.types";

const cell = "rounded border border-[#D4D4D8] dark:border-[#52525B] px-2 py-1 bg-white dark:bg-[#18181B] text-sm disabled:opacity-50";
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
  return <div className="grid gap-2">
    <table className="w-full text-sm">
      <thead><tr className="text-left text-xs text-[#71717A]"><th className="py-1">#</th><th>구분</th><th>적요</th><th>거래처</th><th className="text-right">계획 금액</th><th className="text-right">실제 금액</th><th /></tr></thead>
      <tbody>
        {rows.length === 0 && edits.add.length === 0 && <tr><td colSpan={7} className="py-2 text-xs text-[#71717A]">해당일 지주현금 계획 없음. 거래가 있었다면 아래에서 추가하세요.</td></tr>}
        {rows.map((row) => <tr key={row.index} className="border-t border-[#E4E4E7] dark:border-[#27272A]">
          <td className="py-1 pr-2">{row.index}</td><td className="pr-2">{DIRECTION_LABEL[row.direction]}</td><td className="pr-2">{row.description}</td><td className="pr-2">{row.party}</td>
          <td className="pr-2 text-right tabular-nums">{Number(row.amount).toLocaleString("ko-KR")}</td>
          <td className="text-right"><input className={`${cell} w-36 text-right`} type="number" step="any" min={0} inputMode="decimal" aria-label={`${row.index}번 실제 금액`} disabled={disabled} value={amountOf(row)} onChange={(event) => setAmount(row, event.target.value)} /></td>
          <td className="pl-2 text-xs text-[#71717A]">{amountOf(row) === "0" ? "미집행" : amountOf(row) !== row.amount ? "수정" : ""}</td>
        </tr>)}
        {edits.add.map((item, i) => <tr key={`add-${i}`} className="border-t border-[#E4E4E7] dark:border-[#27272A]">
          <td className="py-1 pr-2 text-xs text-[#71717A]">추가</td>
          <td className="pr-2"><select className={cell} aria-label="추가 거래 구분" disabled={disabled} value={item.direction} onChange={(event) => setAdded(i, { direction: event.target.value as "in" | "out" })}><option value="in">입금</option><option value="out">지급</option></select></td>
          <td className="pr-2"><input className={`${cell} w-full`} aria-label="추가 거래 적요" required disabled={disabled} value={item.description} onChange={(event) => setAdded(i, { description: event.target.value })} /></td>
          <td className="pr-2"><input className={`${cell} w-full`} aria-label="추가 거래 거래처" disabled={disabled} value={item.party} onChange={(event) => setAdded(i, { party: event.target.value })} /></td>
          <td />
          <td className="text-right"><input className={`${cell} w-36 text-right`} type="number" step="any" min={0} inputMode="decimal" aria-label="추가 거래 금액" required disabled={disabled} value={item.amount} onChange={(event) => setAdded(i, { amount: event.target.value })} /></td>
          <td className="pl-2"><button type="button" disabled={disabled} onClick={() => update({ ...edits, add: edits.add.filter((_, j) => j !== i) })}>빼기</button></td>
        </tr>)}
      </tbody>
    </table>
    <div><button type="button" className={cell} disabled={disabled} onClick={() => update({ ...edits, add: [...edits.add, { direction: "out", description: "", party: "", amount: "" }] })}>계획에 없는 거래 추가</button></div>
  </div>;
}
