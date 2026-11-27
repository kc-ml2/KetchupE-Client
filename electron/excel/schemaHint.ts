import type { z } from "zod";

/**
 * Model-facing schema help (the plotkit protocol: aliases accepted, every rejection carries a hint).
 * - normalizeKeys renames keys that differ from an allowed key only by case, "_", "-" or spaces (tick_step → tickStep).
 * - explainSchemaError turns zod issues into short lines naming the path, the allowed keys and the closest one.
 */
type Def = { type: string; shape?: Record<string, z.ZodType>; element?: z.ZodType; innerType?: z.ZodType; in?: z.ZodType; options?: z.ZodType[]; valueType?: z.ZodType; discriminator?: string };
const def = (schema: z.ZodType) => (schema as unknown as { def: Def }).def;
const squash = (key: string) => key.toLowerCase().replace(/[\s_-]/g, "");

function unwrap(schema: z.ZodType): z.ZodType {
  let current = schema;
  for (;;) {
    const d = def(current);
    if (["optional", "nullable", "default", "nonoptional", "readonly", "catch", "prefault"].includes(d.type) && d.innerType) current = d.innerType;
    else if (d.type === "pipe" && d.in) current = d.in;
    else return current;
  }
}

/** The object schemas that can sit at `data` (a discriminated union picks by the data's discriminator). */
function objectsFor(schema: z.ZodType, data: unknown): Def[] {
  const d = def(unwrap(schema));
  if (d.type === "object") return [d];
  if (d.type === "union" && d.options) {
    const objects = d.options.flatMap(option => objectsFor(option, data));
    const tag = d.discriminator && data && typeof data === "object" ? (data as Record<string, unknown>)[d.discriminator] : undefined;
    const hit = tag === undefined ? [] : objects.filter(object => {
      const field = object.shape?.[d.discriminator!];
      return field && (def(unwrap(field)) as unknown as { values?: unknown[] }).values?.includes(tag);
    });
    return hit.length ? hit : objects;
  }
  return [];
}

function childSchema(schema: z.ZodType, key: string | number, data: unknown): z.ZodType | undefined {
  const d = def(unwrap(schema));
  if (d.type === "array") return d.element;
  if (d.type === "record") return d.valueType;
  for (const object of objectsFor(schema, data)) if (object.shape && typeof key === "string" && key in object.shape) return object.shape[key];
}

function at(schema: z.ZodType, path: PropertyKey[], data: unknown): { schema?: z.ZodType; data: unknown } {
  let current: z.ZodType | undefined = schema, value = data;
  for (const key of path) {
    if (!current) break;
    current = childSchema(current, key as string | number, value);
    value = value && typeof value === "object" ? (value as Record<string, unknown>)[key as string] : undefined;
  }
  return { schema: current, data: value };
}

export function allowedKeys(schema: z.ZodType, path: PropertyKey[], data?: unknown): string[] {
  const target = at(schema, path, data);
  return target.schema ? [...new Set(objectsFor(target.schema, target.data).flatMap(object => Object.keys(object.shape ?? {})))] : [];
}

/** Returns a copy with near-miss key spellings renamed to the schema's keys; values are untouched otherwise. */
export function normalizeKeys(schema: z.ZodType, data: unknown): unknown {
  if (Array.isArray(data)) {
    const d = def(unwrap(schema));
    return d.type === "array" && d.element ? data.map(item => normalizeKeys(d.element!, item)) : data;
  }
  if (!data || typeof data !== "object") return data;
  const d = def(unwrap(schema));
  if (d.type === "record" && d.valueType) return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, normalizeKeys(d.valueType!, v)]));
  const objects = objectsFor(schema, data);
  if (!objects.length) return data;
  const shape = Object.assign({}, ...objects.map(object => object.shape)) as Record<string, z.ZodType>;
  const bySquash = new Map(Object.keys(shape).map(key => [squash(key), key]));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    const target = key in shape ? key : bySquash.get(squash(key)) ?? key;
    if (target !== key && target in data) out[key] = value; // never overwrite a key the model also wrote correctly
    else out[target] = shape[target] ? normalizeKeys(shape[target], value) : value;
  }
  return out;
}

const distance = (a: string, b: string) => {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j++) { const keep = row[j]; row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1)); previous = keep; }
  }
  return row[b.length];
};
const closest = (key: string, keys: string[]) => {
  const scored = keys.map(k => [k, distance(squash(key), squash(k))] as const).sort((x, y) => x[1] - y[1])[0];
  return scored && scored[1] <= Math.max(2, Math.floor(key.length / 3)) ? scored[0] : undefined;
};

type Issue = { code?: string; path?: PropertyKey[]; keys?: string[]; message?: string; expected?: string; input?: unknown };
/** Issues from a ZodError, or from its JSON message after it crossed the worker boundary. */
export function schemaIssues(error: unknown): Issue[] | undefined {
  if (error && typeof error === "object" && Array.isArray((error as { issues?: unknown }).issues)) return (error as { issues: Issue[] }).issues;
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const start = message.indexOf("[");
  if (start < 0) return undefined;
  try { const parsed = JSON.parse(message.slice(start)); return Array.isArray(parsed) && parsed.every(item => item && typeof item === "object" && "code" in item) ? parsed : undefined; }
  catch { return undefined; }
}

const showPath = (path: PropertyKey[] = []) => path.length ? path.map(String).join(".") : "(최상위)";

export function explainSchemaError(error: unknown, schema: z.ZodType, data?: unknown, displayHint?: (path: PropertyKey[]) => string | undefined): string | undefined {
  const issues = schemaIssues(error);
  if (!issues?.length) return undefined;
  const lines = issues.slice(0, 8).map(issue => {
    const path = issue.path ?? [];
    if (issue.code === "unrecognized_keys") {
      const keys = allowedKeys(schema, path, data);
      const named = (issue.keys ?? []).map(key => { const near = closest(key, keys); return near ? `${key}(→ ${near}?)` : key; });
      return `- ${showPath(path)}: 알 수 없는 키 ${named.join(", ")}. 이 위치에서 쓸 수 있는 키: ${keys.join(", ") || "없음"}.${displayHint?.(path) ? ` ${displayHint(path)}` : ""}`;
    }
    if (issue.code === "invalid_type" && issue.message?.includes("received undefined")) return `- ${showPath(path)}: 필수 값(${issue.expected ?? "값"})이 없습니다.`;
    return `- ${showPath(path)}: ${issue.message ?? issue.code}`;
  });
  return `응답이 계약과 맞지 않습니다. 아래만 고쳐 같은 응답을 다시 보내세요.\n${lines.join("\n")}${issues.length > 8 ? `\n- 외 ${issues.length - 8}건` : ""}`;
}
