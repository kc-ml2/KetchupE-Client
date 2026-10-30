import JSZip from "jszip";
import { reportCharts, type Report } from "./contracts.ts";

const xml = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]!);
const chartNs = "http://schemas.openxmlformats.org/drawingml/2006/chart";
const relNs = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const packageNs = "http://schemas.openxmlformats.org/package/2006/relationships";

/** ExcelJS does not author native charts; add the standard OOXML parts after it writes the workbook. */
export async function addNativeCharts(bytes: Uint8Array, report: Report): Promise<Uint8Array> {
  const charts = reportCharts(report);
  if (!charts.length) return bytes;
  const zip = await JSZip.loadAsync(bytes);
  let types = await zip.file("[Content_Types].xml")!.async("string");
  for (const [index, chart] of charts.entries()) {
    const n = index + 1, table = report.result.tables[chart.table], sheetId = report.result.tables.length + 3 + index;
    const reference = (column: number, numeric: boolean) => {
      const letter = String.fromCharCode(65 + column), kind = numeric ? "num" : "str";
      const points = table.rows.map((row, i) => `<c:pt idx="${i}"><c:v>${xml(row.cells[column])}</c:v></c:pt>`).join("");
      return `<c:${kind}Ref><c:f>'결과 ${chart.table + 1}'!$${letter}$3:$${letter}$${table.rows.length + 2}</c:f><c:${kind}Cache>${numeric ? "<c:formatCode>General</c:formatCode>" : ""}<c:ptCount val="${table.rows.length}"/>${points}</c:${kind}Cache></c:${kind}Ref>`;
    };
    const scatter = chart.type === "scatter", pie = chart.type === "pie";
    const series = `<c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:v>${xml(table.columns[chart.y])}</c:v></c:tx>${chart.trendline ? '<c:trendline><c:trendlineType val="linear"/><c:dispRSqr val="0"/><c:dispEq val="0"/></c:trendline>' : ""}${scatter ? `<c:xVal>${reference(chart.x, true)}</c:xVal><c:yVal>${reference(chart.y, true)}</c:yVal>` : `<c:cat>${reference(chart.x, false)}</c:cat><c:val>${reference(chart.y, true)}</c:val>`}</c:ser>`;
    const tag = chart.type === "bar" ? "barChart" : chart.type === "line" ? "lineChart" : scatter ? "scatterChart" : "pieChart";
    const options = chart.type === "bar" ? '<c:barDir val="col"/><c:grouping val="clustered"/>' : scatter ? '<c:scatterStyle val="marker"/>' : chart.type === "line" ? '<c:grouping val="standard"/>' : "";
    const axes = pie ? "" : `<c:${scatter ? "valAx" : "catAx"}><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="b"/><c:crossAx val="2"/><c:crosses val="autoZero"/></c:${scatter ? "valAx" : "catAx"}><c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="l"/><c:crossAx val="1"/><c:crosses val="autoZero"/></c:valAx>`;
    zip.file(`xl/charts/chart${n}.xml`, `<?xml version="1.0" encoding="UTF-8"?><c:chartSpace xmlns:c="${chartNs}" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><c:chart><c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${xml(chart.title)}</a:t></a:r></a:p></c:rich></c:tx></c:title><c:plotArea><c:layout/><c:${tag}>${options}${series}${pie ? "" : '<c:axId val="1"/><c:axId val="2"/>'}</c:${tag}>${axes}</c:plotArea><c:plotVisOnly val="1"/></c:chart></c:chartSpace>`);
    zip.file(`xl/drawings/drawing${n}.xml`, `<?xml version="1.0" encoding="UTF-8"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><xdr:twoCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>0</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>12</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>20</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${n}" name="Chart ${n}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="${chartNs}"><c:chart xmlns:c="${chartNs}" xmlns:r="${relNs}" r:id="rId1"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>`);
    zip.file(`xl/drawings/_rels/drawing${n}.xml.rels`, `<Relationships xmlns="${packageNs}"><Relationship Id="rId1" Type="${relNs}/chart" Target="../charts/chart${n}.xml"/></Relationships>`);
    zip.file(`xl/worksheets/_rels/sheet${sheetId}.xml.rels`, `<Relationships xmlns="${packageNs}"><Relationship Id="rId1" Type="${relNs}/drawing" Target="../drawings/drawing${n}.xml"/></Relationships>`);
    const sheet = await zip.file(`xl/worksheets/sheet${sheetId}.xml`)!.async("string");
    zip.file(`xl/worksheets/sheet${sheetId}.xml`, sheet.replace("</worksheet>", '<drawing r:id="rId1"/></worksheet>'));
    types = types.replace("</Types>", `<Override PartName="/xl/charts/chart${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/><Override PartName="/xl/drawings/drawing${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>`);
  }
  zip.file("[Content_Types].xml", types);
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
