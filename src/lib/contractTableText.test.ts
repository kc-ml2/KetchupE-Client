import { describe, expect, it } from "vitest";
import {
  parseContractTableGrid,
  serializeContractTableGrid,
} from "./contractTableText";

describe("parseContractTableGrid", () => {
  it("행 구분과 셀 내부 줄바꿈이 모두 <br>인 2열 표를 파싱한다", () => {
    const text =
      "| 회사 | 주식회사 케이씨○○○○<br>{회사 주소}<br>대표이사 {대표이사 성명} |<br>" +
      "| --- | --- |<br>" +
      "| 대표이사 | {대표이사 성명} ({생년월일})<br>{주소} |";

    expect(parseContractTableGrid(text)).toEqual({
      header: [
        "회사",
        "주식회사 케이씨○○○○\n{회사 주소}\n대표이사 {대표이사 성명}",
      ],
      rows: [["대표이사", "{대표이사 성명} ({생년월일})\n{주소}"]],
    });
  });

  it("실제 줄바꿈으로 구분된 4열 표를 컬럼 수 가정 없이 파싱한다", () => {
    const text =
      "| 구분 | 기준가격 | 수량 | 부여일 |\n" +
      "| --- | --- | --- | --- |\n" +
      "| 1회차 | {1회차 기준가격} | {1회차 수량} | {1회차 부여일} |\n" +
      "| 2회차 | {2회차 기준가격} | {2025년도의 CEO 연봉의 10%} ÷ {기준가격} | 2025년 정기주주총회 |\n" +
      "| … | … | … | … |\n" +
      "| N회차 | {N회차 기준가격} | {2024+(N-1)년도의 CEO 연봉의 10%} ÷ {기준가격} | 2024+(N-1)년 정기주주총회 |";

    const grid = parseContractTableGrid(text);

    expect(grid.header).toEqual(["구분", "기준가격", "수량", "부여일"]);
    expect(grid.rows).toHaveLength(4);
    expect(grid.rows[0]).toEqual([
      "1회차",
      "{1회차 기준가격}",
      "{1회차 수량}",
      "{1회차 부여일}",
    ]);
    expect(grid.rows[3]).toEqual([
      "N회차",
      "{N회차 기준가격}",
      "{2024+(N-1)년도의 CEO 연봉의 10%} ÷ {기준가격}",
      "2024+(N-1)년 정기주주총회",
    ]);
  });

  it("표 문법이 아닌 일반 문자열은 빈 grid를 반환한다", () => {
    expect(parseContractTableGrid("그냥 문단 텍스트입니다.")).toEqual({
      header: null,
      rows: [],
    });
  });
});

describe("serializeContractTableGrid", () => {
  it("header/셀 내부 줄바꿈을 포함한 grid를 마크다운으로 직렬화하고 파싱과 round-trip된다", () => {
    const grid = {
      header: ["구분", "내용"],
      rows: [["대표이사", "{성명} ({생년월일})\n{주소}"]],
    };

    const markdown = serializeContractTableGrid(grid);

    expect(markdown).toBe(
      "| 구분 | 내용 |\n| --- | --- |\n| 대표이사 | {성명} ({생년월일})<br>{주소} |",
    );
    expect(parseContractTableGrid(markdown)).toEqual(grid);
  });

  it("header 없는 grid는 데이터 행만 직렬화한다", () => {
    expect(
      serializeContractTableGrid({
        header: null,
        rows: [["회사", "케이씨"]],
      }),
    ).toBe("| 회사 | 케이씨 |");
  });
});
