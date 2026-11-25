# plotkit spec 키 → 케찹이 매핑

작성 2026-11-25. 기준: `tga_plot` 저장소 `lib/plotkit` 브랜치의 `schema/SPEC.md`(plotkit 2.0), 케찹이 `electron/excel/contracts.ts`(`chartRequest`, `chartSpec`), `viewContracts.ts`(`view`).
목적: plotkit의 명세 키를 케찹이 엑셀 작업의 두 층(계산/표시)에 배정하고, 이미 있는 것과 새로 구현할 것을 구분한다. plotkit-ts는 설치하지 않으며 모델 호출은 케찹이가 맡는다.

## 분류 기준

| 분류 | 기준 | 들어갈 곳 | 수정 요청이 오면 |
| --- | --- | --- | --- |
| 계산 | 결과 데이터의 수치나 행 구성이 바뀜 | `chartRequest` → 고정 QuickJS 프로그램 | 재계산, 근거·결과 해시 새로 생성 (4단계 이후 `chartRequest` patch) |
| 표시 | 수치는 그대로, 그리는 방법만 바뀜 | `view` | `view` patch, 결과 해시로 수치 불변 확인 |
| 앱 | 모델이 명세로 정하지 않음 | 파일 첨부, profile, 열 해석기(resolver), 출력 형식 | 해당 없음 |
| 미지원 | 케찹이에 맞지 않거나 보류 | — | 사용자에게 미지원 안내 (`asks`의 `unsupported`) |

상태: **있음**(같은 의미의 키가 있음, 별칭만 추가) · **일부**(일부 값만 지원) · **신규** · **위치 변경**(케찹이에 있지만 층이 다름) · **해당 없음**.

## 1. 공통·최상위

| plotkit 키 | 분류 | 케찹이 현재 | 상태 | 메모 |
| --- | --- | --- | --- | --- |
| `file` | 앱 | 첨부 파일 `file1..` | 있음 | 모델은 파일 이름만 쓰고 resolver가 `fileId`로 바꾼다 |
| `sheets` | 앱 | `sheetPlan.sheet` | 일부 | 이름·번호 해석은 resolver. 여러 시트는 `combine` 참고 |
| `read.header_row`, `read.data_start_row` | 앱 | `sheetPlan.headerRow`, `firstDataRow` | 있음 | 지금은 모델이 쓴다 → profile 기반 resolver로 이동 (3단계 핵심) |
| `read.sep`, `decimal`, `encoding` | 앱 | — | 해당 없음 | 케찹이는 xlsx만 받음. csv/txt 확장은 별도 결정 |
| `title` (text) | 표시 | `view.title`, `chartRequest.title` | 있음 | |
| `title.size`, `title.color` | 표시 | — | 신규 | |
| `legend` (위치, show, size) | 표시 | 하단 중앙 고정 | 신규 | 위치 11종 + `outside right/bottom`, `best` |
| `text_color` | 표시 | 고정 `#18181b` | 신규 | |
| `tick_direction` | 표시 | 고정 바깥 | 신규 | `inout`은 근사 |
| `grid` | 표시 | `view.grid` (none/solid/dashed) | 있음 | `true`→`solid`, `false`→`none` 별칭 |
| `size`, `dpi` | 표시 | 960×460px 고정 | 신규 | PNG/PDF/PPTX 크기에 반영 |
| `font`, `font_size` | 표시 | 고정 | 신규 | |
| `colors` (list) | 표시 | `view.colors` (hex 목록) | 일부 | 이름·한글 색, `{범주: 색}`, `"mono"`는 신규 |
| `asks` | 프로토콜 | — | 신규 | `unsupported` 항목을 결과 메시지에 표시 (`not_done`) |
| `data_code` | 계산 | 분석 계획의 `code` (전체 계획 경로) | 일부 | `chartRequest` 안의 짧은 변환식은 신규 검토. 같은 QuickJS 격리를 쓴다 |
| `output.format` | 앱 | `formats` (pdf/html/xlsx/png/pptx) | 일부 | svg/jpg/tif는 없음 |
| `output.dir`, `output.name` | 앱 | BusinessFlow 결과 이름 | 해당 없음 | |
| `notes` | — | — | 해당 없음 | 모델 메모, 그리지 않음 |
| `code` (matplotlib Python) | 미지원 | — | — | Python 없음 |
| `engine` | 미지원 | — | — | ECharts 하나 |
| `echarts` (자유 patch) | 미지원(보류) | — | — | 허용 목록 관리 부담, 다른 키 설정을 덮어씀. 4단계 측정 뒤 재검토 |

## 2. 곡선 (측정 데이터: x, y1 왼쪽, y2 오른쪽)

케찹이의 `chartRequest`(x + series 최대 4개, 왼/오른 축)가 이 경로에 해당한다.

| plotkit 키 | 분류 | 케찹이 현재 | 상태 | 메모 |
| --- | --- | --- | --- | --- |
| `preset: "tga"` | 앱+표시 | — | 신규 | 열 추정(온도/무게/DTG), 기본 라벨, 잔류량·피크 기본 주석 묶음. resolver 기본값으로 구현 |
| `x.col`, `y1.col`, `y2.col` | 계산 | `chartRequest.x`, `series[].key` + `input.columns` | 위치 변경 | 지금은 모델이 열 번호·단위까지 씀 → 열 문자/이름만 쓰고 resolver가 채움 |
| `y2: false` | 계산 | series를 왼쪽에만 둠 | 있음 | |
| `y1.flip`, `y2.flip` (flip/peaks_up/peaks_down) | 계산 | `series[].transform` (identity/loss100/lossInitial) | 신규 | 값 부호를 바꾸므로 계산. `negate`, `peaksUp` transform 추가 |
| `x/y.label` | 표시 | `view.axes.*.label` | 있음 | |
| `x/y.min`, `max` | 표시 | `view.axes.*.min/max` | 있음 | |
| `x/y.step` | 표시 | `view.axes.*.tickStep` | 있음 | 별칭 다수 (`interval`, `틱 간격`, `간격` …) |
| `x/y.log` | 표시 | `scale: "log"` | 있음 | |
| `x/y.minor` | 표시 | — | 신규 | |
| `x/y.invert` | 표시 | — | 신규 | ECharts `inverse` |
| `x/y.label_size`, `label_color` | 표시 | — | 신규 | |
| `x/y.tick_size`, `tick_color` | 표시 | — | 신규 | |
| `y.color` | 표시 | `view.colors[i]` | 있음 | 시리즈별 키로 받아 팔레트 위치로 매핑 |
| `y.width`, `y.linestyle` | 표시 | 1.5px 실선 고정 | 신규 | `"--"`, `점선` 같은 표기도 별칭 처리 |
| `y.style` (line/scatter/line+marker) | 표시 | `chartRequest.chartType` | 위치 변경 | 수치 불변이므로 표시로 옮긴다. 지금은 바꾸면 전체 재계획 |
| `y.legend` | 표시 | 열 이름 + "(왼쪽 축)" 자동 | 신규 | |
| `y.show` | 표시 | — | 신규 | |
| `combine` (여러 시트를 한 그림에) | 계산 | `chartRequest.input` 1개 | 신규 | 시트별 시리즈. 근거(sourceRows)는 시트별로 유지 |
| `names` | 표시 | — | 신규 | combine 범례 이름 |
| `offset` | 표시 | — | 신규 | 그릴 때만 이동, 라벨은 실제 값 |
| `panels: "split"` | 표시 | — | 신규 | 위아래 두 grid, x축 공유 |

### 곡선 주석 `annotate.<name>`

| plotkit 키 | 분류 | 케찹이 현재 | 상태 | 메모 |
| --- | --- | --- | --- | --- |
| `type: "peak"` | 표시 | `annotations` kind `max`/`min` (최대 1점) | 일부 | 렌더러가 계산하고 결과 해시는 불변 |
| `count`, `x_min`, `x_max`, `min_rel` | 표시 | — | 신규 | 평활화 + 돌출도 피크 탐색 (plotkit `peaks.ts`, MIT, 이식) |
| `type: "value_at_x"`, `x` | 표시 | kind `valueAt` | 있음 | |
| `method: "interp"` | 표시 | 가장 가까운 점만 | 신규 | |
| `type: "vline"`/`"hline"`, `x`/`y` | 표시 | `view.referenceLines` | 있음 | |
| `type: "band"`, `x_min`, `x_max`, `alpha` | 표시 | — | 신규 | `MarkAreaComponent` 등록 필요 |
| `type: "text"`, `where` | 표시 | — | 신규 | |
| `on` | 표시 | `annotations[].series` | 있음 | `y1`/`y2` → series index |
| `text` (템플릿 `{}`, `{y:.2f}`) | 표시 | `label` (고정 문구 + 자동 "X=…, Y=…") | 일부 | 소수 자릿수 템플릿 신규 |
| `color`, `size`, `marker`, `linestyle` | 표시 | — | 신규 | |
| 주석 값 `false` (기본 주석 끄기) | 표시 | 배열에서 제외 | 있음 | |
| 라벨 겹침 회피 배치 | 표시 | ECharts 기본 | 신규 | plotkit `placeLabels` 이식 |

## 3. 차트 (표 데이터: bar/hbar/line/scatter/histogram/heatmap/pie)

케찹이에서는 분석 계획(`analysisPlan.code`)이 표를 만들고 `chartSpec`이 그 표를 가리킨다. 집계를 모델이 JS로 쓰는 부분을 키로 대체하는 것이 이 절의 핵심이다.

| plotkit 키 | 분류 | 케찹이 현재 | 상태 | 메모 |
| --- | --- | --- | --- | --- |
| `chart` | 계산 | `chartSpec.type` | 있음 | `hbar`→`bar` + `horizontal` |
| `orient: "h"` | 계산 | `chartSpec.horizontal` | 있음 | 수치는 불변이지만 케찹이는 차트 모양을 계산 층에 둠. 표시로 옮길지는 4단계에서 결정 |
| `x`, `y` (열) | 계산 | `chartSpec.x`/`y` (표 열 번호) | 위치 변경 | 원본 열 이름 → resolver |
| `y` 목록 (여러 측정값) | 계산 | `chartSpec.series` (최대 4) | 있음 | |
| `y.agg` (mean/sum/count/median/min/max/std/first/last/nunique) | 계산 | 모델이 JS로 작성 | 신규 | 고정 프로그램으로 컴파일. 그룹별 sourceRows 유지 |
| `y: "count"` | 계산 | 모델 JS | 신규 | |
| `filter` (`==` `!=` `>` `>=` `<` `<=` `in` `not in` `between` `contains`) | 계산 | 모델 JS | 신규 | 제외된 행은 이유와 함께 "제외 행"에 기록 |
| `by` (범주별 시리즈 분리) | 계산 | — | 신규 | |
| `stack` | 계산 | `chartSpec.stack` | 있음 | `chartRequest`는 area만 허용 → bar까지 확장 |
| `percent` | 미지원 | — | — | plotkit도 미구현 |
| `x.period` (day/week/month/quarter/year) | 계산 | 모델 JS | 신규 | |
| `x.bins`, `bins` (N / width / edges) | 계산 | `chartSpec.bins` (개수만) | 일부 | width·edges 신규 |
| `density` | 계산 | — | 신규 | histogram |
| `sort`, `top` | 계산 | 모델 JS | 신규 | 행 순서·개수가 결과에 들어가므로 계산. pie의 "기타" 묶기 포함 |
| `x.order`, `y.order` | 계산 | 모델 JS | 신규 | 표의 행 순서 |
| `smooth` (이동평균) | 계산 | — | 신규 | **이름 충돌**: 케찹이 `smooth`는 곡선 보간(표시). 내부 키는 `movingAverage`로 둔다 |
| `error` (std/sem/minmax) | 계산 | — | 신규 | 그룹별 통계 열 추가 |
| `z` (heatmap 값), `z.agg` | 계산 | `chartSpec.value` | 일부 | agg 신규 |
| `corr` | 계산 | — | 신규 | 상관 행렬 |
| `values` (true) | 표시 | `view.labels` | 있음 | |
| `values` 형식 (`"{:.1f}"`, pie `percent/value/both`) | 표시 | — | 신규 | |
| `values: "n"` | 계산 | — | 신규 | 그룹 행 수 열이 필요 |
| `ref` (`y`/`x` 숫자) | 표시 | `view.referenceLines` | 있음 | |
| `ref` (`"mean"`, `"median"`) | 표시 | mean 주석 | 일부 | median 신규. 필터 후 전체 행 기준으로 같은 의미 |
| `trend` | 표시 | `chartSpec.trendline` (계산 층) | 위치 변경 | 수치 불변이므로 표시로. `{"label": true}`(기울기, R²) 신규 |
| `highlight` | 표시 | — | 신규 | |
| `colors` (`{범주: 색}`, `"mono"`) | 표시 | `view.colors` 목록 | 일부 | |
| `cmap` | 표시 | heatmap에서 `view.colors` 2색 이상 | 일부 | 이름 있는 컬러맵 신규 |
| `point_size`, `alpha` | 표시 | 크기 자동 | 신규 | |
| `x/y.rotate` | 표시 | — | 신규 | |
| `x/y.format` | 표시 | `axes.*.decimals` | 일부 | `"{:.1f}"`→`decimals: 1`, 그 밖의 형식은 신규 |
| `x.date_format` | 표시 | — | 신규 | |
| `x/y.flip` (차트) | 표시 | — | 신규 | 축 뒤집기 (곡선의 `flip`과 의미가 다름) |
| `x/y.min/max/step/log/label/label_size/tick_size` | 표시 | 2절과 같음 | 2절과 같음 | |

## 4. 케찹이에만 있는 것 (유지)

plotkit 키로 바꾸는 과정에서 빠뜨리면 안 되는 항목이다.

- 차트 종류: `boxplot`, `area`(누적 포함), `pie`의 `donut`, 수평 막대 이외 `horizontal` 조합.
- 표시: `samplePoints`(표시 샘플링), `tickValues`(눈금 직접 나열), `decimals`, `description`, 주석 `scope`(selectedData/visibleData), `mean` 주석.
- 계산: `transform` `loss100`/`lossInitial`(Weight Loss), 단위 검사, 측정 순서와 끊긴 구간 유지, 2만 점 한도.
- 근거·재현: 행별 `sourceRows`, 제외 행과 이유, 원본 SHA-256, 결과 해시 재실행 검증, 결과 파일 버전 관리.
- 출력: HTML(CSP), PDF, XLSX 네이티브 차트와 근거 열, PNG, PPTX.

## 5. 집계

표의 행 87개 기준 (축 키처럼 묶어 적은 행은 한 행으로 셌다).

| 분류 | 있음 | 일부 | 위치 변경 | 신규 | 해당 없음·미지원 |
| --- | --- | --- | --- | --- | --- |
| 계산 | 5 | 3 | 2 | 14 | — |
| 표시 | 13 | 7 | 2 | 28 | — |
| 앱 (`preset` 포함) | 2 | 2 | — | 1 | 2 |
| 프로토콜 (`asks`) | — | — | — | 1 | — |
| 미지원·불필요 | — | — | — | — | 5 |

읽는 법:
- **계산 신규 14개 중 대부분은 지금 모델이 JS로 쓰는 집계·필터·정렬이다.** 이것을 키로 바꾸면 모델 출력 토큰이 줄고, 결과는 고정 프로그램이 만들므로 근거·해시가 그대로 유지된다.
- **표시 신규 28개는 대부분 스타일 키다.** `view` 스키마와 `chart.ts`의 ECharts 매핑만 추가하면 되고 수정 경로는 지금 구조 그대로다. 구현량이 큰 것은 피크 탐색, 라벨 배치, `panels`, `band` 네 가지다.
- **위치 변경 4개**(`y.style`, `orient`, `trend`, 열 지정)는 수정 속도와 직결된다. 지금은 계산 층에 있어서 바꾸면 전체 재계획으로 넘어간다.

## 6. 단계별 작업과의 연결

- **3단계 (명세 축소, 별칭과 hint):** 1절 `read.*`·`file`·`sheets`와 2절 `x/y.col`의 resolver, 모든 표의 별칭 열, 알 수 없는 키·값에 대한 "이 키를 말한 건가요?" 응답, `asks`.
- **4단계 (키 확장):** 2·3절의 신규 항목. 계산 신규는 `chartRequest` 확장 + `chartRequest` patch 수정 경로, 표시 신규는 `view` 확장.
- **측정:** 각 단계 전후로 같은 요청 세트(tga 24개, CNT dev, 케찹이 요청)를 같은 모델로 실행한다.
