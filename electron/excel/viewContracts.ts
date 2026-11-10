import { z } from "zod";

const title = z.string().max(120);
const axisFields = {
  min: z.number().finite(), max: z.number().finite(), tickStep: z.number().finite().positive(),
  tickValues: z.array(z.number().finite()).min(1).max(50), decimals: z.number().int().min(0).max(10), label: title, scale: z.enum(["linear", "log"]),
};
export const axisView = z.object(axisFields).partial().strict().superRefine((axis, ctx) => {
  if (axis.min !== undefined && axis.max !== undefined && axis.min >= axis.max) ctx.addIssue({ code: "custom", message: "축 최소값은 최대값보다 작아야 합니다." });
  if (axis.tickValues?.some((v, i, values) => i > 0 && v <= values[i - 1])) ctx.addIssue({ code: "custom", message: "눈금은 중복 없이 오름차순으로 지정하세요." });
});
export const annotationLabels = { max: "최대점", min: "최소점", mean: "평균", valueAt: "값" } as const;
const annotationFields = { series: z.number().int().min(0).max(3), kind: z.enum(["max", "min", "mean", "valueAt"]), x: z.number().finite().optional(), scope: z.enum(["selectedData", "visibleData"]).default("selectedData") };
/** valueAt reads the measured point nearest to x; the other kinds find their own position. */
const annotationShape = (item: { kind: string; x?: number }, ctx: z.RefinementCtx) => { if ((item.kind === "valueAt") !== (item.x !== undefined)) ctx.addIssue({ code: "custom", message: "x는 valueAt 주석에만, valueAt에는 반드시 지정합니다." }); };
const referenceLine = z.object({ axis: z.enum(["x", "left", "right"]), value: z.number().finite(), label: title.optional() }).strict();
const annotation = z.object({ ...annotationFields, label: title.optional() }).strict().superRefine(annotationShape).transform(item => ({ ...item, label: item.label ?? annotationLabels[item.kind] }));
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const chartFields = { title: title.optional(), description: z.string().max(2000).optional(), axes: z.object({ x: axisView.optional(), left: axisView.optional(), right: axisView.optional() }).strict().optional(), labels: z.boolean().optional(), colors: z.array(color).min(1).max(8).optional(), grid: z.enum(["none", "solid", "dashed"]).optional(), referenceLines: z.array(referenceLine).max(12).optional() };
const chartView = z.object({ ...chartFields, annotations: z.array(annotation).max(12).optional() }).strict();
export const reportView = z.object({ charts: z.record(z.string().regex(/^[0-9]$/), chartView) }).strict();
const axisPatch = z.object(Object.fromEntries(Object.entries(axisFields).map(([key, schema]) => [key, schema.nullable().optional()])) as { [K in keyof typeof axisFields]: z.ZodOptional<z.ZodNullable<(typeof axisFields)[K]>> }).strict();
const chartPatch = z.object({
  title: title.nullable().optional(), description: z.string().max(2000).nullable().optional(),
  axes: z.object({ x: axisPatch.nullable().optional(), left: axisPatch.nullable().optional(), right: axisPatch.nullable().optional() }).strict().optional(),
  annotations: z.array(z.object({ ...annotationFields, label: title.optional() }).strict().superRefine(annotationShape)).max(12).optional(),
  labels: z.boolean().nullable().optional(), colors: z.array(color).min(1).max(8).nullable().optional(),
  grid: z.enum(["none", "solid", "dashed"]).nullable().optional(), referenceLines: z.array(referenceLine).max(12).nullable().optional(),
}).strict();
export const viewPatch = z.object({ charts: z.record(z.string().regex(/^[0-9]$/), chartPatch) }).strict();
export type ReportView = z.infer<typeof reportView>;
export type ViewPatch = z.input<typeof viewPatch>;
export type AxisView = z.infer<typeof axisView>;
export type ChartView = z.infer<typeof chartView>;
