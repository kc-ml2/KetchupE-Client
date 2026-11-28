// @vitest-environment node
import { expect, it } from "vitest";
import type { BusinessField } from "../../src/app-types/BusinessTool.types.ts";
import { applyPatch, parseDecision, PatchError } from "./agentTurn.ts";

const fields: BusinessField[] = [
  { key: "actualEdits", label: "실적", type: "movements", required: true, rows: [{ index: 1, direction: "out", description: "급여", party: "", amount: "100" }, { index: 2, direction: "out", description: "임차료", party: "", amount: "200" }] },
  { key: "accountBindings", label: "계좌 연결", type: "text", required: true, accountRows: [{ key: "A:KRW", name: "입출금", currency: "KRW", balance: "10" }] },
  { key: "cashChanges", label: "입출금", type: "text", required: true, cashRows: [{ key: "A:KRW", name: "입출금", currency: "KRW", opening: "1", balance: "10" }] },
  { key: "carry", label: "이월 확인", type: "text", required: true, confirm: "확인" },
  { key: "cell_H21", label: "H21", type: "number", required: true },
];
const all = new Set(fields.map((field) => field.key));

it("merges a partial movement edit into earlier edits instead of replacing them", () => {
  const values = { actualEdits: JSON.stringify({ changes: [{ index: 1, amount: "50" }], add: [{ direction: "in", description: "환급", party: "", amount: "7" }] }) };
  const next = applyPatch(fields, values, { actualEdits: { changes: [{ index: 2, amount: 0 }] } }, all);
  expect(JSON.parse(next.actualEdits)).toEqual({ changes: [{ index: 1, amount: "50" }, { index: 2, amount: "0" }], add: [{ direction: "in", description: "환급", party: "", amount: "7" }] });
  expect(JSON.parse(applyPatch(fields, next, { actualEdits: { changes: [{ index: 1, amount: "1,000" }], clearAdded: true } }, all).actualEdits)).toEqual({ changes: [{ index: 1, amount: "1000" }, { index: 2, amount: "0" }], add: [] });
  expect(JSON.parse(applyPatch(fields, { actualEdits: "확인" }, { actualEdits: {} }, all).actualEdits)).toEqual({ changes: [], add: [] });
  // A model restating the planned amount must not turn an untouched row into a manual edit.
  expect(JSON.parse(applyPatch(fields, {}, { actualEdits: { changes: [{ index: 1, amount: "100" }, { index: 2, amount: "0" }] } }, all).actualEdits)).toEqual({ changes: [{ index: 2, amount: "0" }], add: [] });
});

it("fills each field kind in the serialized form the tool already reads", () => {
  expect(applyPatch(fields, {}, { accountBindings: { "A:KRW": "H12" }, cashChanges: { "A:KRW": { incoming: "10", outgoing: 0 } }, carry: true, cell_H21: -5 }, all))
    .toEqual({ accountBindings: '{"A:KRW":"H12"}', cashChanges: '{"A:KRW":{"incoming":"10","outgoing":"0"}}', carry: "확인", cell_H21: "-5" });
});

it("rejects what the person did not clearly say or may not change", () => {
  for (const patch of [{ actualEdits: { changes: [{ index: 3, amount: "1" }] } }, { actualEdits: { changes: [{ index: 1, amount: "삼백만" }] } }, { actualEdits: { add: [{ direction: "out", description: "", amount: "1" }] } },
    { accountBindings: { "B:KRW": "H12" } }, { accountBindings: { "A:KRW": "Z9" } }, { cashChanges: { "A:KRW": { incoming: "-1", outgoing: "0" } } }, { carry: "응" }, { unknown: "x" }])
    expect(() => applyPatch(fields, {}, patch, all), JSON.stringify(patch)).toThrow(PatchError);
  expect(() => applyPatch(fields, {}, { carry: true }, new Set(["actualEdits"]))).toThrow("대화로 바꿀 수 없는");
});

it("reads one decision out of surrounding model text and refuses unknown shapes", () => {
  expect(parseDecision('```json\n{"kind":"reply","message":"네"}\n```')).toEqual({ kind: "reply", message: "네" });
  // Seen from the live model: an extra note, a stray key outside the patch, and one closing brace too many.
  expect(parseDecision('{"kind":"set_inputs","patch":{"a":{"changes":[]}},"note":"반영함","cashChanges":{"x":1}}}')).toEqual({ kind: "set_inputs", patch: { a: { changes: [] } } });
  expect(parseDecision('{"kind":"set_inputs","patch":{"a":{"changes":[{"index":2,"amount":"0"}]}}')).toEqual({ kind: "set_inputs", patch: { a: { changes: [{ index: 2, amount: "0" }] } } });
  expect(() => parseDecision('{"kind":"approve"}')).toThrow();
  expect(() => parseDecision("모르겠습니다")).toThrow();
});
