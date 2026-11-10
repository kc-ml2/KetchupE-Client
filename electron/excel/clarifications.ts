import { z } from "zod";
import { chartRequest } from "./contracts.ts";

export const clarificationState = z.array(z.object({
  key: z.string().regex(/^answer[1-9]\d*$/), question: z.string().max(2000),
  answer: z.string().max(4000).optional(),
  history: z.array(z.string().max(4000)).max(12).optional(),
  options: z.array(z.object({ value: z.string().max(100), label: z.string().max(500), plan: chartRequest.optional() })).max(20).optional(),
})).max(12);

export function selectedOption(item: z.infer<typeof clarificationState>[number], value: string | undefined) {
  if (!value) return undefined;
  const exact = item.options?.find(option => option.value === value || option.label === value);
  if (exact) return exact;
  const ordinal = value.trim().match(/^([1-9]\d*)\s*(?:번)?$/);
  return ordinal ? item.options?.[Number(ordinal[1]) - 1] : undefined;
}

/** Legacy answer3 may name several questions. Only its last occurrence owns the current input. */
export function readClarifications(raw: unknown, values: Record<string, string>) {
  const items = clarificationState.parse(raw ?? []);
  return items.map((item, index) => {
    const last = items.findLastIndex(other => other.key === item.key) === index;
    const incoming = last && Object.hasOwn(values, item.key) ? values[item.key] : undefined;
    const choice = selectedOption(item, incoming);
    const answer = choice?.label ?? incoming ?? item.answer ?? "";
    return { ...item, answer, ...(item.answer !== undefined && item.answer !== answer ? { history: [...(item.history ?? []), item.answer].slice(-12) } : {}) };
  });
}
