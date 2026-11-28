# Daily Cash: Agentic Interaction

- 기준: 2026-11-29, `dev`, 앱 3.0.28. Daily Cash tool version은 1.4.2 그대로다 (계산 결과가 같고, 올리면 대기 중인 작업이 무효가 된다).
- 상태: 구현 완료. 실제 model로 확인했다 (§9). 실제 앱 화면, 실제 업무 파일, 설치된 Excel 출력, 실제 Langfuse 화면은 확인하지 않았다.
- 범위: Daily Cash만. Excel 작업(`excel_work`)은 다루지 않는다.
- 참고: [architecture](docs/KETCHUPE_V3_ARCHITECTURE.md), [business rules](docs/BUSINESS_TOOLS.md), [기존 flow chart](workflow_summary/daily_cash_workflow.md).

## 1. 목표와 원칙

**목표: 해결 가능한 예외는 복구하고, 해결할 수 없는 예외에서는 근거와 진행 상태를 보존한다.**

**방식: 자료 탐색과 모호한 입력 해석에는 LLM을 쓰고, 금액 계산과 업무 규칙은 deterministic code로 유지한다.**

**model은 계산기가 정한 것을 바꾸지 않는다.** 합계가 맞고 기존 엑셀 서식이 유지되는 것이 우선이다. 긴 설명과 꾸밈은 업무 혼선만 만든다.

| 요구 | 내용 | 상태 |
| --- | --- | --- |
| R1 | workflow 실행을 요청하면 자료 탐색부터 시작한다 | 구현 (§6) |
| R2 | 작업 도중 다른 질문을 해도 기존 작업을 이어간다 | 구현 (§4) |
| R3 | 요청받은 정보를 자연어로 답하거나 수정한다 | 구현 (§4) |
| R4 | 오류 원인과 해결 방법을 알고 재시도하거나 보완한다 | 일부 (§5: 확실한 실패만 분류) |
| R5 | 반영된 입력과 변경 사항을 확인하고 최종 승인한다 | 구현 (§4) |
| R6 | 새 workflow를 추가해도 Harness·BusinessFlow의 조건문이 늘지 않는다 | 구현 (§2) |

## 2. 설계

```text
사용자 메시지 / 버튼
      ▼
대화 턴 (main process, flow.ts + agentTurn.ts)     reply / set_inputs / retry / cancel / switch
      │  보는 것: { step, code, 질문문, 대기 field, 입력 요약, 마지막 오류 }
      ▼
execute (dailyCash.ts)                             정해진 순서로 실행, 멈춘 step·code와 step별 시간 반환
      ▼
steps:  evidence → ledger → rates → review → produce      (worker, 금융 로직 변경 없음)
```

- **agent는 사용자와 workflow 사이의 한 겹이다.** step마다 model이 있는 것이 아니다. 이 한 겹이 "지금 어느 step에서 왜 멈췄는지"를 알고 있다가 사용자가 말을 걸면 model을 써서 응답한다.
- **step 사이 이동은 코드가 한다.** 다음 step은 항상 정해져 있어서 model이 판단할 것이 없다.
- **모든 결과에 `step`과 `code`가 붙는다.** 대화 턴의 상태 파악, 관측, 테스트의 기대값이 같은 값을 쓴다.

### LLM과 code의 역할

| 일 | 담당 |
| --- | --- |
| 금액 계산, 대사, 환율 변환, 수식·서식 생성 | code |
| 업무 규칙 (날짜, 예금 원금, 이월, 승인 hash), step 순서, 입력 검증 | code |
| 사용자 발화 해석 (질문·답·수정·중단·전환) | LLM |
| 자연어를 입력값으로 옮기기 | LLM이 patch 제안 → code가 검증 |
| 멈춘 이유·오류 원인 설명 | LLM. 주어진 근거 안에서만 |
| 여러 파일 후보 중 고르기 | LLM이 이름만 보고 제안 → 사용자 확인 |
| 최종 승인 | 사용자. 버튼 + review hash만 |

### model을 부르는 때

model 호출은 step 수가 아니라 **사용자가 말을 건 횟수**에 비례한다. 카드와 버튼만으로 끝나는 정상 실행은 0회다 (파일 후보가 여럿일 때의 탐색 1회 제외).

- **부름:** 입력 대기 중의 자유 문장, 파일 후보가 여럿일 때, 완료 결과가 있는 대화에 같은 업무로 새 메시지가 왔을 때.
- **부르지 않음:** step이 멈추지 않고 끝났을 때, 카드·버튼으로 답했을 때, "취소" 같은 명확한 표현.

### 코드로 막는 것 (프롬프트에 의존하지 않음)

- patch는 대화로 바꿀 수 있는 field만, field 종류별 검증을 통과한 값만 받는다.
- 원천 파일과 작업일(확정된 기본 입력), 최종 승인(`manualOnly`)은 대화로 바꿀 수 없다.
- 일보 파일 갱신은 review hash가 일치할 때 BusinessFlow만 수행한다.
- 메시지 1건당 model 결정 1회, 계산기 실행 최대 1회.
- 취소·전환 뒤 늦게 도착한 model/worker 결과는 적용하지 않는다.

### 하지 않는 것

- **step마다 model이 다음 행동을 결정하는 구조.** 정상 실행에 호출만 늘고 model이 순서를 건너뛸 여지가 생긴다.
- **step 결과를 저장해 중간부터 재개.** 답변이 올 때마다 처음부터 다시 돈다. FX만 `checkpoint.rates`로 재사용한다.
- **별도 draft 저장소·새 DB table.** `business_jobs`의 `input.values`가 곧 draft다.

### 새 workflow를 추가할 때 (R6)

Harness와 BusinessFlow에는 tool ID 분기가 없다. tool이 선언하는 것만 읽는다.

| tool이 선언 | 따라오는 것 |
| --- | --- |
| field 종류 (`movements`, `accountRows`, `cashRows`, `confirm`, `select`, `text`…), `manualOnly` | 자연어 답변·수정, 대화로 바꿀 수 없는 항목 |
| 결과의 `code`·`step`·`trace`·`recovery` | 상태 설명, 예외 안내, 관측 |
| `suggestFiles` | 시작 시 자료 탐색, 폴더 연결 카드 |
| `telemetry: "trajectory"` | Langfuse 전송 |

## 3. Step과 멈춤 code

step은 `execute` 안의 경계 표시(`enter("ledger")`)다. 파일·함수로 옮기지 않았다. step ID와 step별 시간은 이것으로 얻고, 금융 로직을 옮기는 위험은 지지 않는다.

| step | 하는 일 |
| --- | --- |
| `evidence` | 날짜·자료 선택, 원천자료 검증, 이전 잔고 확보 |
| `ledger` | 거래 수정, 계좌 연결, 대사 |
| `rates` | 환율 조회·검증·수동 입력 |
| `review` | audit, hash, 승인 확인 |
| `produce` | 시트·수식 생성, 재계산, PNG, 재검증 |

계산기가 멈춰 되묻는 지점 20개. 조건·문장·순서는 전과 같고 `ask(code, 질문문, fields)`로 이름만 붙였다.

| step | code | 멈추는 이유 | 누가 푸는가 |
| --- | --- | --- | --- |
| evidence | `CARRY_GAP` | 전일 일보가 직전 영업일 것이 아님 | 사용자 (사실 확인) |
| evidence | `NO_PLAN_DATE` | 주간계획에 해당 날짜 없음 | 사용자 (사실 확인) |
| evidence | `PRIOR_OVERRIDE_INVALID` | 저장된 전일 금액 보정값을 읽을 수 없음 | 형식 오류 |
| evidence | `PRIOR_AMOUNT_INVALID` | 전일 금액이 숫자가 아님 | 형식 오류 |
| evidence | `PRIOR_AMOUNT_MISSING` | 수식 계산 결과가 저장되지 않은 셀 | 사용자 (값 입력) |
| ledger | `EDITS_INVALID` | 거래 입력을 읽을 수 없음 | 형식 오류 |
| ledger | `EDITS_REJECTED` | 거래 수정이 검증에서 거절됨 | 사용자 (값 수정) |
| ledger | `BINDINGS_INVALID` | 계좌 연결 입력을 읽을 수 없음 | 형식 오류 |
| ledger | `ACCOUNT_BINDING` | 계좌가 전일 일보의 어느 행인지 모름 | 사용자 (후보 제안 가능) |
| ledger | `ACTUALS_CONFIRM` | 실제 집행 여부는 자금현황표에 없음 (매 실행 필수) | 사용자 (사실 확인) |
| ledger | `DEPOSIT_MISMATCH` | 정기예금 원금과 집행 내역 불일치 | 사용자 (값 수정) |
| ledger | `CASH_CHANGES_INVALID` | 계좌별 입출금 입력이 잘못됨 | 형식 오류 |
| ledger | `CASH_RECONCILE` | 계좌별 기초 + 입금 − 출금이 잔고와 다름 | 사용자 (값 입력) |
| ledger | `CLOSING_MISMATCH` | 실적 합계와 원화 계좌잔고가 다름 | 사용자 (후보 제안 가능) |
| ledger | `MOVEMENT_ACCOUNT` | 거래가 어느 계좌에서 나갔는지 불명확 | 사용자 (후보 제안 가능) |
| rates | `FX_MANUAL_INVALID` | 수동 입력 환율이 잘못됨 | 형식 오류 |
| rates | `FX_FETCH_FAILED` | 환율 조회 실패 | 사용자 (재조회 확인) |
| rates | `FX_MANUAL_REQUIRED` | 재조회도 실패 | 사용자 (값 입력) |
| rates | `FX_DATE_DIFFERS` | 은행이 다른 날짜의 고시를 반환 | 사용자 (사실 확인) |
| review | `REVIEW` | 최종 확인 | 사용자 (버튼 승인만) |

- **model이 스스로 값을 정해도 되는 곳은 없다.** model의 역할은 사용자의 말을 입력으로 옮기는 것과 이유를 설명하는 것이다.
- "형식 오류"는 대화 입력이 종류별 검증을 먼저 통과해야 하므로 대부분 도달하지 않는다.
- "후보 제안 가능" 3곳은 아직 제안을 붙이지 않았다. 관측(§8)에서 자주·오래 멈추는 것이 확인되면 붙인다.

## 4. 대화 턴

입력 대기 중에 자유 문장이 오면 model이 메시지 한 건을 다음 중 하나로 해석한다. 카드와 버튼은 전처럼 계산기로 바로 간다.

| 결정 | 하는 일 |
| --- | --- |
| `reply` | 답하고 끝. 같은 action과 카드(작성 중인 값 포함) 유지, 계산기 호출 없음 |
| `set_inputs` | field 종류별 검증 → 기존 답변에 merge → 계산기 실행 → 새 질문 또는 다음 단계 |
| `retry` | 같은 입력으로 계산기 재실행 |
| `cancel` | 작업 중단 |
| `switch` | **작업 변경** 사용을 안내 (자동 전환은 없음) |

예시 (`CLOSING_MISMATCH`에서 멈춘 상태):

1. "왜 안 맞아?" → `reply`: 질문문의 전일 잔액·실적 반영액·계좌잔고·차이를 근거로 설명. 카드는 그대로.
2. "3번 거래 아직 안 나갔어" → `set_inputs` → 3번만 0원으로 merge → 계산기 실행 → `REVIEW`에서 멈춤.
3. 코드가 "다음 내용을 반영해 다시 확인합니다. - 3번 …: 1000 → 0"을 남기고 최종 확인을 보여준다. 승인은 버튼으로 한다.

### 답변과 patch 규칙

- 답변은 물은 것만 세 문장 이내. 숫자와 항목 이름은 근거에 적힌 그대로 옮긴다.
- 사용자가 말하지 않은 거래·계좌·금액은 patch에 넣지 않는다. 계획 금액을 그대로 다시 적은 항목은 코드가 버려서, 손대지 않은 거래가 "담당자 수정"으로 바뀌지 않는다.
- 부분 답변을 받는다. 남은 것만 다시 묻는다.
- model 호출이 실패하거나 patch가 거절되면 입력 카드와 작성 중인 값을 유지하고 이유를 말한다.

### 잘못 읽었을 때의 방어선

1. **항목별 되읽기.** 무엇을 얼마에서 얼마로 바꿨는지 코드가 보여준다.
2. **계산기의 대사.** 잘못 넣은 금액은 `DEPOSIT_MISMATCH`·`CLOSING_MISMATCH` 등에서 멈춘다.
3. **최종 확인의 "계획 대비 실적 차이"와 버튼 승인.**

대사가 모든 오독을 잡는다는 보장은 아니다. 잘못 읽은 값이 우연히 잔고와 맞으면 최종 확인까지 간다.

### 완료된 결과에 대한 질문

같은 대화에 완료된 결과가 있는데 같은 업무로 새 메시지가 오면 model이 먼저 구분한다.

- **결과 질문** ("총 원화 합계는 얼마야?"): 완료 요약·검증 항목·감사 기록에 적힌 값만 옮겨 답하고 끝낸다. 입력 카드를 열지 않는다. 기록에 없으면 완성 파일에서 확인하라고 답한다. 통합문서를 다시 읽지 않는다.
- **새 실행 요청, 불분명, model 실패:** 전처럼 입력 카드를 연다.

## 5. 예외 처리

질문이 아니라 실패로 끝나는 경우를 사용자가 할 수 있는 일로 나눈다 (`recovery`).

| 종류 | 의미 | 처리 | 지금 분류된 것 |
| --- | --- | --- | --- |
| `fix_input` | 값을 고치면 해결 | 원인과 고칠 곳 안내, 카드 유지 | 사용자가 넣은 계좌 위치가 거절된 경우, 첫 실행에서 자료가 거절된 경우 |
| `retry` | 같은 입력으로 다시 하면 될 수 있음 | 재시도 안내 | 아직 없음 |
| `environment` | 사용자 PC 문제 | 조치 방법 안내, 조치 후 재시도 | 두 출력 엔진(Excel·LibreOffice)이 모두 실패 |
| `new_run` | 원천 파일·작업일이 틀림 | 이유 안내, 새 작업 제안 | `evidence` step의 실패, "새 작업" 사유 4곳 |

- **분류되지 않은 실패**는 확인된 메시지 원문과 보존된 상태만 안내한다. 자동으로 재실행하지 않는다.
- **보존하는 것:** 확정한 입력과 작성 중이던 값, 멈춘 `step`·`code`, 계산기가 돌려준 메시지 원문, step별 trace.
- **첫 실행에서 자료가 거절되면** 새 작업을 요구하지 않고 카드를 다시 연다. 아직 어떤 답변도 그 자료에 의존하지 않기 때문이다. 답변이 쌓인 뒤의 잠금은 그대로다.

## 6. 자료 탐색과 폴더 연결

`uploadOnly`를 해제했다. 한 번 연결한 폴더는 이후 실행과 다른 workflow에서 다시 쓴다 (`work_sources` 공유).

1. **시작하면 먼저 찾는다.** tool의 `suggestFiles`가 연결 폴더의 파일 이름만 보고 역할별 후보를 낸다.
   - 자금현황표: 파일명이 기준일 `YYMMDD_`로 시작하는 것. 없으면 "자금현황"·"[KC]"가 들어간 것.
   - 주간계획: "주간"·"자금계획". 전일 일보: "일보"·"일일자금".
2. **후보가 하나면 코드가 채운다.** model을 부르지 않는다.
3. **후보가 여럿이면 model이 이름만 보고 고른다.** 근거(주차·기간·날짜)가 이름에 없으면 고르지 않는다. 후보 밖의 파일이나 단일 항목에 여러 개를 고른 응답은 버린다.
4. **실행은 사용자가 "이 자료로 실행"을 눌러야 한다.** 파일 내용 검증은 기존 계산기가 그대로 한다.

### 입력 카드

- 파일 항목마다 굵은 이름, 상태 한 단어(자동 선택 / 제안 / 후보에서 선택 / 찾지 못함), 칩 한 줄. 선택된 파일은 체크가 붙은 실선 칩, 후보는 점선 칩이다.
- 위쪽 한 줄에 **다시 찾기**와 **다른 폴더 연결**. 연결된 폴더가 없으면 **업무 폴더 연결** 버튼이 나온다. 설정 화면으로 보내지 않는다.
- 폴더를 연결하면 바로 다시 찾는다. 입력한 작업일과 직접 고른 파일은 유지하고 이전 탐색이 채운 것만 바꾼다.
- 읽지 못한 연결은 "읽지 못한 연결 n개"로 접어 둔다.
- 카드에서 직접 고른 파일은 이번 실행에만 쓰고 연결 자료로 남기지 않는다.

### 주의할 점

- **이름 규칙은 추정이다.** `YYMMDD_`만 기존 코드에서 확인한 규칙이고 주간계획·일보의 단어는 짐작이다. 실제 파일명과 다르면 "찾지 못함"으로 나오며 [dailyCash.ts](electron/business/dailyCash.ts)의 `suggestFiles`에서 고친다.
- **엉뚱한 일보 파일을 승인하면 되돌릴 수 없다.** 일보는 전일 통합문서에 새 날짜 시트를 추가하고 그 통합문서로 디스크의 파일을 교체한다. 교체 전 사본을 남기지 않는다 (§10).
- **폴더 경로가 로컬 DB에 남는다.** 연결 폴더 방식의 전제다.
- **model로 가는 것:** 후보가 여럿일 때 연결 폴더 안의 상대 경로와 파일 이름. 파일 내용은 가지 않는다.
- **범위:** 로컬 연결 폴더만. MARU(원격 저장소)는 포함하지 않는다.

## 7. model로 가는 것

| 호출 | 가는 내용 |
| --- | --- |
| 대화 턴 | 질문문·오류 원문(금액 포함 가능), 대기 field와 현재 입력값, 파일 이름, 사용자 메시지 |
| 자료 탐색 | 후보 파일의 상대 경로·이름, 작업일·기준일 |
| 완료 결과 질문 | 완료 요약, 검증 항목, 감사 기록(환율·금액 포함), 사용자 메시지 |

원천 통합문서의 내용 자체는 어느 호출에도 가지 않는다. 대상은 설정된 LiteLLM gateway다.

## 8. 관측과 Langfuse 전송

### 구조

- **기록은 한 곳.** `BusinessFlow.mark()`가 trajectory를 쓰는 유일한 지점이다. 구조화된 값(ID·field key·횟수·시간)과 `text`(말한 내용)를 나눠서 받는다. 모두 로컬 SQLite(`trace_events`)에 남는다.
- **전송은 선언.** tool이 `telemetry: "trajectory"`를 선언하면 run이 끝날 때 Langfuse로 간다. 지금은 `daily_cash`만 선언했다. 선언하지 않은 tool(엑셀 작업 등)은 전처럼 로컬 전용이다. 전에는 일일자금일보 run이 Langfuse에 아무것도 남지 않았다.
- **읽는 곳도 한 곳.** [telemetry.ts](electron/agent/telemetry.ts)의 `buildBusinessTrace`.

### 문구는 content mode를 따른다

요청문, 채팅 원문, model 답변, 질문 문구, 오류 문구는 기존 telemetry content mode로 처리한다 (`KETCHUPE_TELEMETRY_CONTENT_MODE`).

| mode | 문구 |
| --- | --- |
| `ops` (기본) | HMAC 해시만. 내용은 볼 수 없고 같은 문구인지만 알 수 있다 |
| `redacted_eval` | 이메일·전화·키를 가린 원문 |
| `internal_full` | 원문 그대로 |

**Langfuse에서 원문을 보려면 `internal_full`(또는 `redacted_eval`)로 실행해야 한다.** 이 문구에는 금액·계좌명·환율이 들어 있다 (질문문과 완료 요약에 적혀 있다). `redacted_eval`은 금액을 가리지 않는다.

구조화된 값은 mode와 무관하게 식별자 모양(`[A-Za-z0-9_./:@-]`, 100자 이하)만 통과한다. 파일 이름·경로와 patch 값은 별도 항목으로 보내지 않는다 (문구 안에 적힌 것은 위 mode대로 간다).

### Langfuse에서 보이는 것

trace 하나 = run 하나. 이름 `business.daily_cash`, session = 대화(thread) HMAC, tag = `daily_cash`·상태·`business`. root의 input은 요청문, output은 마지막 답변이다.

| span | 의미 | metadata | 문구 |
| --- | --- | --- | --- |
| `discover` | 연결 폴더 탐색 | `trigger`(start/card), `connected`, `problems`(개수), `fields`(`key:상태:후보 수`) | — |
| `stop.<code>` | 멈춰서 기다린 구간. 길이 = 사용자가 답하기까지 걸린 시간 | `step`, `code`, `pending`(묻는 field key) | output: 질문·오류 문구 |
| `submit` | 입력 제출 후 파일 확인 | `via`(card/chat), `changed`(바뀐 field key) | — |
| `execute` → `step.<이름>` | 계산기 1회 실행과 단계별 시간 | `outcome`, `step`, `code`, `recovery` | output: 실패 메시지 |
| `turn.chat` | 채팅 한 건 (반영·재실행 포함) | `decision`, 멈춘 `step`·`code`, `changed` | input: 채팅 원문 |
| `wait.after_reply` | 답변 후 다시 기다린 구간 | — | output: model 답변 |
| `turn.result_question` | 완료 결과 질문 판별 | `decision`(reply/start/error) | input: 메시지, output: 답변 |
| `phase.<이름>` | tool이 직접 보고한 단계 | 시도 횟수, 행 수, 토큰, model alias, 오류 코드 | — |

- **trace metadata:** `toolId`, `version`, `status`, `errorCode`, `path`(멈춘 code 순서, 예: `INPUT>CARRY_GAP>ACTUALS_CONFIRM>REVIEW`), `lastStep`, `lastCode`, `stops`, `executions`, `failures`, `turns`, `turnDecisions`, `modelCalls`, `totalTokens`, `waitMs`(사용자 대기), `workMs`(시스템 작업).
- **score (run 종료 시):** `runtime/completed`, `business/stops`, `business/executions`, `business/failures`, `business/turns`, `business/turns_rejected`.
- `turn.chat`의 `decision`: reply, set_inputs, retry, cancel, switch, rejected(patch 거절), no_change, error(model 실패).

### 이 데이터로 답할 수 있는 질문

- 어느 `code`에서 가장 자주, 가장 오래 멈추는가 (`stop.*` 개수와 길이).
- 채팅으로 푼 비율과 거절된 비율 (`submit.via`, `business/turns_rejected`).
- 자료 탐색이 얼마나 맞았는가 (`discover.fields` 상태 분포, 이후 `evidence` step 실패 여부).
- run 하나에 든 사용자 시간과 시스템 시간 (`waitMs`, `workMs`).
- 실패가 어느 step에서 나고 어떤 복구로 분류되는가 (`execute`의 `step`·`recovery`).
- (원문 mode에서) 어떤 발화가 거절되거나 잘못 해석됐는가.

### 한계

- 전송은 run이 끝난 뒤(완료·실패·취소) 한 번이다. 입력 대기 중인 run은 Langfuse에 보이지 않는다.
- 대화 턴·자료 탐색 model 호출의 토큰 수는 기록하지 않는다. 시간과 결정만 있다.
- 채팅으로 입력을 반영했을 때 코드가 만든 되읽기 문구("다음 내용을 반영해…")는 span에 붙지 않는다.
- 라우팅 단계의 trace는 이 trace에 포함하지 않는다.
- 취소된 실행의 step별 시간은 남지 않는다.

## 9. 검증

### 테스트

- 전체 702개 통과 (환경 의존 6개 건너뜀), TypeScript 두 프로젝트와 변경 파일 lint 통과.
- model 응답은 고정하고 계산기는 실제 것을 [fixtureBooks](electron/business/dailyCash/fixtures.ts)로 돌린다. 가짜 계산기는 없다.
- 채팅만으로 부분 답변 → 설명 → 수정 → 승인 거절 → 재수정까지 간 뒤 버튼 승인으로 완성한 일보가 기존 form 경로와 같은 셀 값을 낸다 ([flow.test.ts](electron/business/flow.test.ts)).
- 기존 [Daily Cash](electron/business/dailyCash.test.ts)·[report](electron/business/dailyCash/report.test.ts) 테스트는 그대로 통과한다.
- Langfuse payload: `ops`에서는 한글·채팅에 넣은 금액·파일 이름이 없고, `internal_full`에서는 요청문·채팅·답변·질문문이 들어 있다.

### 실제 model (`loki`)

`npm run eval:daily-cash-chat` ([scripts/daily-cash-chat-eval.ts](scripts/daily-cash-chat-eval.ts)). 실제 계산기를 fixture로 돌려 얻은 멈춤 상태에 발화를 보내고, 앱과 같은 `parseDecision`·`applyPatch`를 거친 결과를 기대값과 비교한다. model에는 가상 데이터만 간다.

| 대상 | 결과 |
| --- | --- |
| 대화 발화 32개 | 처음 16/22 → 파서·프롬프트 수정 후 마지막 여러 번 32/32. 지연 중앙값 약 1.4초 |
| 자료 탐색 3개 (주차가 이름에 있음 / 주 경계 / 날짜 단서 없음) | 3/3 두 번 |
| 완료 결과 질문 6개 (임시 스크립트, eval에는 미포함) | 6/6 세 번. 그 전에 기록에 없는 값을 묻는 발화가 한 번 새 실행으로 분류돼 프롬프트를 고쳤다 |

틀린 patch가 최종 확인까지 간 경우는 0건이다.

고친 것: JSON 형식 불안정(괄호 과부족, 여분 키)은 파서가 복구한다. 말하지 않은 값 유도, 길고 꾸민 답변, 거래 번호 오독(9번 중 2번)은 프롬프트 규칙과 코드 방어로 막았다.

### 한계

- 가상 데이터, 직접 쓴 발화, 거래 2건짜리 표. 실제 일보는 거래가 훨씬 많다.
- 프롬프트를 이 발화들에 맞춰 고쳤으므로 통과율은 과대평가돼 있다. 같은 발화도 실행마다 결과가 달랐다.
- 확인하지 않은 것: 실제 앱 화면(카드 유지, 탐색 결과 표시), 실제 업무 파일과 파일명, 설치된 Excel 출력, 실제 Langfuse 화면.

## 10. 남은 일과 결정

### 결정이 필요한 것

| 항목 | 권장 | 이유 |
| --- | --- | --- |
| 일보 파일 교체 전 사본 보관 | 교체 직전 원본을 같은 폴더에 사본으로 남김 | 미리 채운 파일을 그대로 승인하는 실수가 쉬워졌는데 되돌릴 방법이 없다 |
| 운영 content mode | 원문이 필요한 기간만 `internal_full` | 원문에는 금액·계좌명이 들어 있다 |
| 실제 파일 이름 규칙 | 실제 파일명 몇 개로 `suggestFiles` 조정 | 주간계획·일보 규칙이 추정이다 |

### 하지 않은 것

- 대화 중 자료 재탐색 ("다른 폴더에 있어"). 지금은 카드의 **다시 찾기**로만 한다.
- 자동 작업 전환. `switch`는 안내만 한다.
- `FX_FETCH_FAILED` 자동 재조회, 후보 제안 3곳 (§3).
- `retry` 종류 예외 분류, 나머지 `throw` 지점 분류 (§5).
- 대화 턴 model 호출의 토큰 기록, 완료 결과 질문의 eval 편입.
- 실제 금융 자료와 실제 사용자 발화로 만든 평가 세트.
- `v3.0.28` 태그. `main` 머지 후에 붙인다.

### 다음에 볼 것 (관측 데이터가 쌓이면)

- 가장 자주·오래 멈추는 `code` → 후보 제안을 붙일 지점.
- 계산기 1회 재실행 시간 (`execute` span) → 부분 답변마다 전체 재실행하는 설계가 계속 맞는지.
- `discover`의 "찾지 못함" 비율 → 이름 규칙 조정.
