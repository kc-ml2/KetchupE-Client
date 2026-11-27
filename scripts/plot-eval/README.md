# plot-eval: 그래프 요청 기준선 측정

[키 매핑](../../docs/PLOT_SPEC_KEY_MAPPING.md) 2단계용 하네스. 동료의 plotkit 연구 요청 세트를 **케찹이 자체 엑셀 작업 경로**(`createExcelTool`, 앱과 같은 LiteLLM 호출)로 실행하고, 실제로 그려진 결과를 채점한다. plotkit-ts는 쓰지 않는다.

| 기준 | 측정값 |
| --- | --- |
| ① 그래프 범위 | 요청별 통과율(채점 항목 전부 통과), 검사 항목 통과율, 입력 미지원 수 |
| ② 처음 그릴 때 | 첫 턴 시간, 모델 호출 수, 입력/출력 토큰 |
| ③ 수정 | 2턴 이후 통과율(요청한 변경 + 이전 설정 유지), 시간, 토큰 |

## 요청 세트

- **tga** (24): `tga_plot` main의 `tests/AGENT_TEST_PROMPTS.md` + `tests/expected_requests.json`. csv/txt 입력 2건은 입력 미지원으로 기록한다.
- **cnt** (dev 34, 그중 세션 4): `lib/plotkit` 브랜치의 `experiments/eval/cnt/dev`. 값 기반 정답이라 엔진과 무관하다. csv 입력 8건은 입력 미지원. sealed 세트는 쓰지 않는다.
- **ketchupe** (1세션 5턴): `scripts/excel-revision-smoke.ts`의 수정 시나리오.

CNT 데이터를 꺼내 두기 (저장소에 커밋하지 않음):

```sh
mkdir -p /tmp/cnt && git -C ../tga_plot archive origin/lib/plotkit experiments/eval/cnt/dev experiments/eval/cnt/data | tar -x -C /tmp/cnt
```

## 실행

```sh
npx vite build                                   # dist-electron/excel.worker.js 갱신
npm exec esbuild scripts/plot-eval/run.ts -- --bundle --platform=node --packages=external --format=cjs --outfile=outputs/plot-eval/run.cjs
# 실측: .env에 LITELLM_API_KEY (선택: LITELLM_BASE_URL, LITELLM_MODEL_ALIAS, 기본 loki)
node_modules/electron/dist/Electron.app/Contents/MacOS/Electron outputs/plot-eval/run.cjs \
  --tga ../tga_plot --cnt /tmp/cnt --out outputs/plot-eval/baseline
npx vite-node scripts/plot-eval/summary.ts outputs/plot-eval/baseline/results.jsonl
```

옵션: `--only 02,D015`, `--sets tga,cnt,ketchupe`, `--fixture`(모델 없이 고정 TGA 계획으로 하네스 점검), `--replay responses.json`(케이스별 응답 재생; 채점기 점검과 재채점용).

## 채점 방식과 한계

- 채점은 마지막 analysis 결과와 `view`로 `chartOption()`을 다시 만들어, **그려진 옵션과 결과 표**를 본다. 내부 키가 바뀌어도(3·4단계) 같은 채점기를 쓴다.
- 케찹이 기본값이 요청값과 우연히 같으면 통과로 센다(제목 크기 18, 격자, 바깥 틱, 범례 표시). 그려진 결과로는 맞기 때문이다.
- 주석 `present`는 plotkit `score.py`처럼 **어느 한 그림에라도** 표시되면 있음으로 본다(시트별 그림에서 750 °C 시트에는 800 °C 잔류량이 없는 것이 맞다). 피크는 `max`와 `peak` 표시를 모두 센다. 5단계 전 실행(baseline2~step4)은 모든 그림에 있어야 통과였다.
- 결과 기록에는 모델 응답(앞 4,000자)과 최종 `view`가 들어 있어 실패 원인을 바로 볼 수 있다.
- 색은 RGB 거리 80 이내면 같은 색으로 본다(케찹이는 hex만 받으므로 모델이 고른 hex를 허용).
- 범례 위치·`dpi`·글꼴처럼 케찹이에 설정이 없는 항목은 실패로 센다. 그게 ① 측정의 목적이다.
- `preset` 검사와 `annotate.residue.text` 명세 검사는 채점에서 뺀다. 앞의 것은 케찹이에 대응 개념이 없고, 뒤의 것은 같은 요청의 `text_regex` 검사로 대신한다.
- 모델이 되묻으면 "요청한 내용대로, 나머지는 기본값으로"라고 한 번 자동 답하고, 그 턴의 시간과 토큰에 포함한다. plotkit 방식은 되묻지 않으므로 되묻기 횟수도 따로 센다.
- tga 세트는 plotkit 저자가 자기 프로토콜에 맞춰 만든 요청이라 plotkit 쪽에 유리하다. 단계 사이 비교(케찹이 이전 대 이후)에는 영향이 없다.
- CNT 컬러·범례 위치 같은 일부 ask는 `채점 미구현`(null)으로 남기고 통과율에서 뺀다.
