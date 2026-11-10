import { z } from "zod";

const title = z.string().max(120);
const axisFields = {
  min: z.number().finite(), max: z.number().finite(), tickStep: z.number().finite().positive(),
  tickValues: z.array(z.number().finite()).min(1).max(50), decimals: z.number().int().min(0).max(10), label: title,
};
export const axisView = z.object(axisFields).partial().strict().superRefine((axis, ctx) => {
  if (axis.min !== undefined && axis.max !== undefined && axis.min >= axis.max) ctx.addIssue({ code: "custom", message: "축 최소값은 최대값보다 작아야 합니다." });
  if (axis.tickValues?.some((v, i, values) => i > 0 && v <= values[i - 1])) ctx.addIssue({ code: "custom", message: "눈금은 중복 없이 오름차순으로 지정하세요." });
});
const annotation = z.object({ series: z.number().int().min(0).max(3), kind: z.literal("max"), label: title.default("최대점"), scope: z.enum(["selectedData", "visibleData"]).default("selectedData") }).strict();
const chartView = z.object({ title: title.optional(), description: z.string().max(2000).optional(), axes: z.object({ x: axisView.optional(), left: axisView.optional(), right: axisView.optional() }).strict().optional(), annotations: z.array(annotation).max(12).optional() }).strict();
export const reportView = z.object({ charts: z.record(z.string().regex(/^[0-9]$/), chartView) }).strict();
const axisPatch = z.object(Object.fromEntries(Object.entries(axisFields).map(([key, schema]) => [key, schema.nullable().optional()])) as { [K in keyof typeof axisFields]: z.ZodOptional<z.ZodNullable<(typeof axisFields)[K]>> }).strict();
const chartPatch = chartView.extend({
  title: title.nullable().optional(), description: z.string().max(2000).nullable().optional(),
  axes: z.object({ x: axisPatch.nullable().optional(), left: axisPatch.nullable().optional(), right: axisPatch.nullable().optional() }).strict().optional(),
  annotations: z.array(annotation.extend({ label: title.optional() })).max(12).optional(),
});
export const viewPatch = z.object({ charts: z.record(z.string().regex(/^[0-9]$/), chartPatch) }).strict();
export type ReportView = z.infer<typeof reportView>;
export type ViewPatch = z.infer<typeof viewPatch>;
export type AxisView = z.infer<typeof axisView>;
export type ChartView = z.infer<typeof chartView>;
