import { z } from "zod";
import { EXCEL_LIMITS } from "./limits.ts";

/** Colour names a user says (English or Korean, as in plotkit) are stored as hex. */
const NAMED_COLORS: Record<string, string> = {
  black: "#000000", 검정: "#000000", 검은색: "#000000", white: "#ffffff", 흰색: "#ffffff", gray: "#808080", grey: "#808080", 회색: "#808080",
  lightgray: "#d3d3d3", lightgrey: "#d3d3d3", "연한 회색": "#d3d3d3", 연회색: "#d3d3d3", darkgray: "#a9a9a9", red: "#ff0000", 빨강: "#ff0000", 빨간색: "#ff0000",
  blue: "#0000ff", 파랑: "#0000ff", 파란색: "#0000ff", navy: "#000080", 남색: "#000080", green: "#008000", 초록: "#008000", 초록색: "#008000",
  orange: "#ffa500", 주황: "#ffa500", 주황색: "#ffa500", purple: "#800080", 보라: "#800080", 보라색: "#800080", brown: "#a52a2a", 갈색: "#a52a2a",
  yellow: "#ffd700", 노랑: "#ffd700", 노란색: "#ffd700", pink: "#ffc0cb", 분홍: "#ffc0cb", skyblue: "#87ceeb", 하늘색: "#87ceeb",
};
const color = z.preprocess(value => typeof value === "string" ? NAMED_COLORS[value.trim().toLowerCase()] ?? NAMED_COLORS[value.trim()] ?? value : value, z.string().regex(/^#[0-9a-fA-F]{6}$/, "색은 #RRGGBB 또는 색 이름(black, 남색 등)으로 지정하세요."));
const title = z.string().max(120);
const fontSize = z.number().min(6).max(40);
const axisFields = {
  min: z.number().finite(), max: z.number().finite(), tickStep: z.number().finite().positive(),
  tickValues: z.array(z.number().finite()).min(1).max(50), decimals: z.number().int().min(0).max(10), label: title, scale: z.enum(["linear", "log"]),
  // Display-only axis styling (plotkit x/y1/y2 keys): tick-number and axis-name font, colours, direction and minor ticks.
  tickSize: fontSize, tickColor: color, labelSize: fontSize, labelColor: color, invert: z.boolean(), minor: z.boolean(),
};
export const axisView = z.object(axisFields).partial().strict().superRefine((axis, ctx) => {
  if (axis.min !== undefined && axis.max !== undefined && axis.min >= axis.max) ctx.addIssue({ code: "custom", message: "축 최소값은 최대값보다 작아야 합니다." });
  if (axis.tickValues?.some((v, i, values) => i > 0 && v <= values[i - 1])) ctx.addIssue({ code: "custom", message: "눈금은 중복 없이 오름차순으로 지정하세요." });
});
export const annotationLabels = { max: "최대점", min: "최소점", mean: "평균", valueAt: "값", peak: "피크" } as const;
const annotationFields = {
  series: z.number().int().min(0).max(11), kind: z.enum(["max", "min", "mean", "valueAt", "peak"]), x: z.number().finite().optional(), scope: z.enum(["selectedData", "visibleData"]).default("selectedData"),
  // peak: the `count` highest peaks of the smoothed curve between xMin and xMax (direction "down" finds dips); valueAt: nearest point or interpolation.
  count: z.number().int().min(1).max(10).optional(), xMin: z.number().finite().optional(), xMax: z.number().finite().optional(), direction: z.enum(["up", "down"]).optional(),
  method: z.enum(["nearest", "interp"]).optional(),
  // Label template: {} = the main value (peak → x, others → y), {x} / {y}, with an optional precision such as {y:.2f}.
  format: z.string().min(1).max(120).optional(), color: color.optional(), size: fontSize.optional(),
};
/** valueAt reads the measured point nearest to x; the other kinds find their own position. */
const annotationShape = (item: { kind: string; x?: number; count?: number; xMin?: number; xMax?: number; method?: string }, ctx: z.RefinementCtx) => {
  if ((item.kind === "valueAt") !== (item.x !== undefined)) ctx.addIssue({ code: "custom", message: "x는 valueAt 주석에만, valueAt에는 반드시 지정합니다." });
  if (item.kind !== "peak" && (item.count !== undefined || item.xMin !== undefined || item.xMax !== undefined)) ctx.addIssue({ code: "custom", message: "count·xMin·xMax는 peak 주석에만 씁니다." });
  if (item.method && item.kind !== "valueAt") ctx.addIssue({ code: "custom", message: "method는 valueAt 주석에만 씁니다." });
};
/** A label template written as the label ("Residue {y:.1f}%") is the format; the label falls back to the kind's name. */
const templateLabel = (value: unknown) => {
  const item = value as { label?: unknown; format?: unknown; kind?: keyof typeof annotationLabels } | null;
  return item && typeof item === "object" && typeof item.label === "string" && item.label.includes("{") && item.format === undefined
    ? { ...item, format: item.label, label: undefined } : value;
};
const referenceLine = z.object({ axis: z.enum(["x", "left", "right"]), value: z.number().finite(), label: title.optional() }).strict();
const annotation = z.preprocess(templateLabel, z.object({ ...annotationFields, label: title.optional() }).strict().superRefine(annotationShape).transform(item => ({ ...item, label: item.label ?? annotationLabels[item.kind] })));
const samplePoints = z.number().int().min(2).max(EXCEL_LIMITS.chartRows);
const lineType = z.enum(["solid", "dashed", "dotted"]);
export const legendPositions = ["upper right", "upper left", "lower right", "lower left", "upper center", "lower center", "center left", "center right", "outside right", "outside bottom"] as const;
const seriesStyle = z.object({ series: z.number().int().min(0).max(11), color: color.optional(), width: z.number().min(0.5).max(8).optional(), lineType: lineType.optional(), symbol: z.boolean().optional(), name: title.optional() }).strict();
const band = z.object({ from: z.number().finite(), to: z.number().finite(), color: color.optional(), opacity: z.number().min(0).max(1).optional(), label: title.optional() }).strict()
  .refine(item => item.from < item.to, "구간 음영은 from < to로 지정하세요.");
const note = z.object({ text: z.string().min(1).max(200), position: z.enum(["upper left", "upper right", "lower left", "lower right"]).default("upper right") }).strict();
const chartFields = {
  title: title.optional(), description: z.string().max(2000).optional(), axes: z.object({ x: axisView.optional(), left: axisView.optional(), right: axisView.optional() }).strict().optional(),
  labels: z.boolean().optional(), samplePoints: samplePoints.optional(), colors: z.array(color).min(1).max(12).optional(), grid: z.enum(["none", "solid", "dashed"]).optional(),
  referenceLines: z.array(referenceLine).max(12).optional(),
  // Figure styling from the plotkit spec: title font, legend, global text, tick direction, figure size (inches at 96 px), per-series lines,
  // shaded x ranges (bands) and corner notes.
  titleStyle: z.object({ size: fontSize.optional(), color: color.optional() }).strict().optional(),
  legend: z.object({ show: z.boolean().optional(), position: z.enum(legendPositions).optional(), size: fontSize.optional() }).strict().optional(),
  text: z.object({ size: fontSize.optional(), color: color.optional() }).strict().optional(),
  tickDirection: z.enum(["in", "out"]).optional(),
  size: z.object({ width: z.number().min(3).max(20), height: z.number().min(2).max(15) }).strict().optional(),
  series: z.array(seriesStyle).max(12).optional(),
  bands: z.array(band).max(8).optional(),
  notes: z.array(note).max(6).optional(),
};
const chartView = z.object({ ...chartFields, annotations: z.array(annotation).max(12).optional() }).strict();
export const reportView = z.object({ charts: z.record(z.string().regex(/^[0-9]$/), chartView) }).strict();
const axisPatch = z.object(Object.fromEntries(Object.entries(axisFields).map(([key, schema]) => [key, schema.nullable().optional()])) as { [K in keyof typeof axisFields]: z.ZodOptional<z.ZodNullable<(typeof axisFields)[K]>> }).strict();
const chartPatch = z.object({
  title: title.nullable().optional(), description: z.string().max(2000).nullable().optional(),
  axes: z.object({ x: axisPatch.nullable().optional(), left: axisPatch.nullable().optional(), right: axisPatch.nullable().optional() }).strict().optional(),
  annotations: z.array(z.preprocess(templateLabel, z.object({ ...annotationFields, label: title.optional() }).strict().superRefine(annotationShape))).max(12).optional(),
  labels: z.boolean().nullable().optional(), colors: z.array(color).min(1).max(12).nullable().optional(),
  samplePoints: samplePoints.nullable().optional(),
  grid: z.enum(["none", "solid", "dashed"]).nullable().optional(), referenceLines: z.array(referenceLine).max(12).nullable().optional(),
  titleStyle: chartFields.titleStyle.unwrap().nullable().optional(), legend: chartFields.legend.unwrap().nullable().optional(), text: chartFields.text.unwrap().nullable().optional(),
  tickDirection: z.enum(["in", "out"]).nullable().optional(), size: chartFields.size.unwrap().nullable().optional(),
  series: z.array(seriesStyle).max(12).nullable().optional(), bands: z.array(band).max(8).nullable().optional(), notes: z.array(note).max(6).nullable().optional(),
}).strict();
export const viewPatch = z.object({ charts: z.record(z.string().regex(/^[0-9]$/), chartPatch) }).strict();
export type ReportView = z.infer<typeof reportView>;
export type ViewPatch = z.input<typeof viewPatch>;
export type AxisView = z.infer<typeof axisView>;
export type ChartView = z.infer<typeof chartView>;
