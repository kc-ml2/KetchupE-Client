import ExcelJS from "exceljs";
import { cashRows } from "./report.ts";
/** 5월 샘플 배치. layout()이 라벨로 다시 찾으므로 report.ts와 공유하지 않는다. */
const termRows = [...Array.from({ length: 47 }, (_, i) => i + 51), ...Array.from({ length: 18 }, (_, i) => i + 102)];
const otherRows = [35, 36, 37, 38, 39, 40, 41, 46, 124, 125];
/** Synthetic fixtures only; never copies account balances or counterparties from supplied workbooks. */
export function fixtureBooks() {
  const report = new ExcelJS.Workbook(); const s = report.addWorksheet("261012");
  s.columns = [6, 15, 23, 18, 6, 18, 15, 18, 15, 15, 15, 15, 17, 3, 25, 20].map((width) => ({ width }));
  for (let r = 1; r <= 248; r++) { const row = s.getRow(r); row.height = 22; row.hidden = true; }
  s.mergeCells("B2:H4"); s.getCell("B2").value = "테스트 일일자금일보\n2026.10.12"; s.getCell("B2").font = { name: "Apple SD Gothic Neo", size: 16, bold: true }; [2, 3, 4].forEach((r) => s.getRow(r).hidden = false);
  for (const [r, name] of [[7, "단기성 현금자산(원화)"], [19, "단기성 현금자산(외화)"], [49, "정기예금 현황(원화)"], [100, "정기예금 현황(외화)"], [122, "신탁현황"], [128, "주요 집행 내역"]] as const) { s.mergeCells(`A${r}:G${r}`); s.getCell(`A${r}`).value = name; s.getRow(r).hidden = false; }
  for (const row of [8, 20, 50, 101]) { s.getRow(row).hidden = false; ["구분", "", "거래처", "전일금액", "증가", "", "감소", "금일금액", "장부금액", "장부환율", "매매기준율", "기준금액", "환차"].forEach((label, i) => s.getCell(row, i + 1).value = label); }
  for (const row of [...cashRows, ...termRows, ...otherRows]) { ["D", "E", "G", "H", "I"].forEach((col) => s.getCell(`${col}${row}`).value = 0); s.getCell(`C${row}`).value = cashRows.includes(row) ? `테스트 계좌 ${row}` : null; }
  s.getCell("C10").value = "신한-입출금(557434)"; s.getCell("H10").value = 100000; s.getCell("C51").value = "기업은행 테스트"; s.getCell("A51").value = "12개월/2.0%/251013~261013"; s.getCell("H51").value = 10000;
  for (const r of [10, 17, 21, 22, 23, 25, 26, 27, 28, 29, 30, 31, 51, 98, 120, 130, 131, 156, 157, 236, 237, 241, 242, 243, 244, 245, 246, 247, 248]) s.getRow(r).hidden = false;
  for (const [cell, expression] of [["D98", "SUM(D51:D97)"], ["D120", "SUM(D102:D119)"], ["D126", "SUM(D124:D125)"], ["D156", "SUM(D131:D155)"], ["D236", "SUM(D157:D235)"]] as const) s.getCell(cell).value = { formula: expression, result: 0 }; s.getCell("A237").value = "마감잔액(10/12)"; s.getCell("E237").value = "마감잔액(10/13)";
  s.getCell("A130").value = "기초금액(10/12)"; s.getCell("E130").value = "기초금액(10/13)"; s.getCell("A131").value = "입금"; s.getCell("E131").value = "입금"; s.getCell("A157").value = "지급"; s.getCell("E157").value = "지급";
  for (let r = 131; r <= 235; r++) { s.mergeCells(`B${r}:C${r}`); s.mergeCells(`F${r}:G${r}`); }
  for (const range of ["A130:C130", "E130:G130", "A237:C237", "E237:G237", "A51:B51"]) s.mergeCells(range);
  s.getRow(51).height = 42;
  s.getCell("O238").value = "사업부문 자금현황표(KC)";
  ["기업USD", "신한CNY", "신한JPY", "신한USD", "하나USD", "MMT하나", "보통예금하나", "보통예금신한1", "보통예금신한2", "기업원화", "우리원화"].forEach((label, i) => s.getCell(`O${239 + i}`).value = label);
  for (const [r, label] of [[241, "합계(지주)"], [243, "합계(사업)"], [245, "정기예금"], [247, "총"]] as const) { s.getCell(`F${r}`).value = `${label} 외화`; s.getCell(`G${r}`).value = `${label} 원화`; s.getCell(`H${r}`).value = `${label}계`; }
  s.getCell("G247").value = "총 원화";
  for (let r = 7; r <= 248; r++) for (let c = 1; c <= 13; c++) { const cell = s.getCell(r, c); cell.font = { name: "Apple SD Gothic Neo", size: 9 }; cell.alignment = { vertical: "middle", wrapText: true }; cell.border = { bottom: { style: "hair", color: { argb: "FFCCD5DE" } } }; if ([7, 19, 49, 100, 128, 247].includes(r)) { cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EEF5" } }; cell.font.bold = true; } if ([4, 5, 7, 8].includes(c)) cell.numFmt = "#,##0"; }
  for (const col of ["I", "J", "K", "L"]) s.getColumn(col).hidden = true;
  const weekly = new ExcelJS.Workbook(); const w = weekly.addWorksheet("세부계획(원화,외화)");
  w.getCell("B3").value = "일자"; w.getCell("C4").value = "구분"; w.getCell("H4").value = "구분"; w.getCell("L4").value = "금액";
  w.getCell("B7").value = new Date("2026-10-13T00:00:00Z"); w.getCell("C7").value = "지주현금"; w.getCell("D7").value = "정기예금 만기 원금"; w.getCell("F7").value = "기업은행 테스트"; w.getCell("G7").value = 10000; w.getCell("H7").value = "지주현금"; w.getCell("I7").value = "소모품 지급"; w.getCell("K7").value = "가상문구"; w.getCell("L7").value = 1000;
  w.getCell("B8").value = new Date("2026-10-14T00:00:00Z"); w.getCell("H8").value = "지주현금"; w.getCell("I8").value = "익일 지급 계획"; w.getCell("K8").value = "가상상사"; w.getCell("L8").value = 2000; w.getCell("B9").value = "지주-현금입금";
  const status = new ExcelJS.Workbook(); const k = status.addWorksheet("Sheet1");
  k.addRow(["No", "(금융)거래처", "계좌코드", "계좌명", "계좌번호", "환종", "기초(원화)\n잔액", "기초(거래)\n잔액", "입금(장부)", "입금(거래)", "출금(장부)", "출금(거래)", "기말잔액\n(장부)", "기말잔액\n(거래)", "계좌잔고", "차액", "상품구분", "등록계정", "가입일", "만기일", "중복유무"]);
  k.addRow([1, "신한은행 테스트", "140013557434", "신한_입출금_지주_원화", "TEST-CASH", "KRW", 100000, 100000, 10000, 10000, 1000, 1000, 109000, 109000, 109000, 0, "보통예금"]);
  k.addRow([2, "기업은행 테스트", "TEST-TERM", "원화정기예금_기업", "TEST-TERM", "KRW", 10000, 10000, 0, 0, 10000, 10000, 0, 0, 0, 0, "정기예금", "", new Date("2025-10-13T00:00:00Z"), new Date("2026-10-13T00:00:00Z")]);
  k.addRow([3, "", "", "", "환종별합계", "KRW", 110000, 110000, 10000, 10000, 11000, 11000, 109000, 109000, 109000]);
  return { report, weekly, status };
}
