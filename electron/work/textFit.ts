import ExcelJS from "exceljs";

/** A writable description area ends before its amount cell; never merge across populated cells. */
export function textFitArea(sheet: ExcelJS.Worksheet, range: string) {
  if (!/^[A-Z]+[1-9]\d*:[A-Z]+[1-9]\d*$/.test(range)) throw new Error(`잘못된 텍스트 표시 영역: ${range}`);
  const [start, end] = range.split(":").map(address => sheet.getCell(address));
  if (start.row !== end.row || Number(start.col) > Number(end.col) || start.formula || ![ExcelJS.ValueType.String, ExcelJS.ValueType.RichText].includes(start.type)) throw new Error(`${range}: 설명 텍스트 영역을 확인하세요.`);
  for (let col = Number(start.col); col <= Number(end.col); col++) {
    const cell = sheet.getCell(Number(start.row), col);
    if (cell.isMerged && cell.master.address !== start.address) throw new Error(`${range}: 다른 병합 셀과 겹칩니다.`);
    if (col > Number(start.col) && !cell.isMerged && cell.value !== null) throw new Error(`${range}: 옆 셀의 내용을 덮어쓸 수 없습니다.`);
  }
  for (const merged of sheet.model.merges) {
    const [a, b] = merged.split(":").map(address => sheet.getCell(address));
    if (Number(a.row) <= Number(start.row) && Number(b.row) >= Number(start.row) && Number(a.col) <= Number(end.col) && Number(b.col) >= Number(start.col) && merged !== range) throw new Error(`${range}: 기존 병합 범위를 변경할 수 없습니다.`);
  }
  return { start, end, row: sheet.getRow(Number(start.row)) };
}
