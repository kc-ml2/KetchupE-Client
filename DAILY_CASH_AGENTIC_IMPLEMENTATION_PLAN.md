# Daily Cash: Agentic Interaction 구현 계획

- 기준: 2026-11-28, `dev`. §3의 Line 번호는 구현 전(`7bb502d`) 기준.
- 상태: 1차 구현 완료 (§13). 질문 ID·step·trace, 대화 턴(답변·자연어 입력·재실행·중단), 예외 분류가 들어갔고 자료 탐색은 아직이다. 실제 model로 발화 32개를 확인했다 (§14). 실제 앱 화면에서는 검증하지 않았다.
- 범위: Daily Cash만. Excel 작업(`excel_work`)은 이 계획에서 다루지 않음.
- 참고: [architecture](docs/KETCHUPE_V3_ARCHITECTURE.md), [business rules](docs/BUSINESS_TOOLS.md), [기존 flow chart](workflow_summary/daily_cash_workflow.md).

## 1. 목표와 원칙

**목표: 해결 가능한 예외는 복구하고, 해결할 수 없는 예외에서는 근거와 진행 상태를 보존한다.**

**방식: 자료 탐색과 모호한 입력 해석에는 LLM을 쓰고, 금액 계산과 업무 규칙은 deterministic code로 유지한다.**

사용자 관점에서 가능해야 하는 것:

- [ ] **R1.** workflow 실행을 요청하면 자료 탐색부터 시작한다.
- [ ] **R2.** 작업 도중 다른 질문을 해도 기존 작업을 이어갈 수 있다.
- [ ] **R3.** 요청받은 정보를 자연어로 답하거나 수정할 수 있다.
- [ ] **R4.** 오류 원인과 해결 방법을 알고, 재시도하거나 정보를 보완할 수 있다.
- [ ] **R5.** 반영된 입력과 변경 사항을 확인하고 최종 실행을 승인할 수 있다.
- [ ] **R6.** 새 workflow를 추가해도 Harness·BusinessFlow의 조건문이 늘지 않는다.

## 2. 설계

### 구조

```text
사용자 메시지 / 버튼
      ▼
에이전트 턴 (main process)      reply / set_inputs / retry / cancel / switch   (+ find_files 예정)
      │  보는 것: { step, code, 질문문, 대기 field, 입력 요약, 마지막 오류 }
      ▼
execute (dailyCash.ts)          정해진 순서로 실행, step 경계마다 시간 기록, 멈춘 step·code 반환
      ▼
steps:  evidence → ledger → rates → review → produce      (worker, 금융 로직 변경 없음)
```

- **agent는 사용자와 workflow 사이의 한 겹이다.** step 하나하나가 model을 가진 agent가 아니다. 이 한 겹이 "지금 어느 step에서 왜 멈췄는지"를 알고 있다가, 사용자가 말을 걸면 model을 써서 응답한다.
- **step 사이 이동은 코드가 한다.** 다음 step은 항상 정해져 있어서 model이 판단할 것이 없다.
- **모든 결과에 `step`과 `code`가 붙는다.** 에이전트의 상태 파악, tracing, 테스트의 기대값이 같은 값을 쓴다.

### LLM과 code의 역할

| 일 | 담당 | 이유 |
| --- | --- | --- |
| 금액 계산, 대사, 환율 변환, 수식 생성 | code | 결과가 항상 같아야 하고 테스트로 보장해야 함 |
| 업무 규칙 (날짜, 예금 원금, 이월, 승인 hash) | code | 규칙 위반을 model이 통과시키면 안 됨 |
| step 실행 순서 | code | 선택지가 하나뿐 |
| 입력값 검증 | code | model이 만든 patch도 같은 검증을 통과해야 함 |
| 사용자 발화 해석 (질문·답·수정·중단·전환) | LLM | 자유 문장이라 규칙으로 구분하기 어려움 |
| 자연어를 입력값으로 옮기기 | LLM이 patch 제안 → code가 검증 | 금융 사실의 확정은 code와 사용자 |
| 현재 상태·질문 이유·오류 원인 설명 | LLM | 주어진 근거 안에서만. 근거가 없으면 지어내지 않음 |
| 자료 탐색 중 모호한 후보 고르기 | LLM이 제안 → 사용자 확인 | 파일명·폴더 구조가 일정하지 않을 수 있음 |
| 최종 승인 | 사용자 | 버튼 + review hash만 |

### model을 부르는 때

model 호출은 step 수가 아니라 **사용자가 말을 건 횟수**에 비례한다.

- **부르지 않음:** step이 멈추지 않고 끝났을 때, 버튼·입력 카드로 답했을 때, 정해진 재시도(환율 1회 재조회), 취소처럼 명확한 표현.
- **부름:** 사용자가 자유 문장을 쳤을 때, 자료 후보가 모호할 때.
- 카드와 버튼만으로 끝나는 정상 실행은 model 호출 0회.

### 코드로 막는 것 (프롬프트에 의존하지 않음)

- `set_inputs`는 수정이 허용된 field만, 스키마를 통과한 값만 받는다.
- `review`는 patch 대상에서 제외한다. "좋아" 같은 메시지로 최종 승인되지 않는다.
- 일보 파일 갱신은 지금처럼 review hash가 일치할 때 `BusinessFlow`만 수행한다.
- 파일 쓰기가 시작된 뒤에는 작업 변경을 거부한다 (기존 Harness 동작 유지).
- 메시지 1건당 model 결정 1회, 계산기 실행 최대 1회. 계산기가 새 질문을 돌려주면 그 질문문을 그대로 보여준다.
- 취소·전환 뒤 늦게 도착한 model/worker 결과는 적용하지 않는다.

### 19개 분기를 대화 가능하게 바꾸는 방식

분기를 없애거나 model로 대체하지 않는다. 분기마다 "멈춘 이유"를 기계가 읽을 수 있게 만들고, 그 위에 대화하는 한 겹을 올린다.

1. **분기에 이름표를 붙인다.** `ask(code, 질문문, fields)`. 조건·문장·순서는 그대로다.

   ```ts
   // 전
   if (!sameWon(actualClosing, holdingClosing)) return ask(`실적 내역과 원화 계좌잔고가…`, [actualField()]);
   // 후
   if (!sameWon(actualClosing, holdingClosing)) return ask("CLOSING_MISMATCH", `실적 내역과 원화 계좌잔고가…`, [actualField()]);
   ```

2. **step 경계를 표시한다.** `execute` 안에서 `enter("ledger")`처럼 경계만 표시하고, 모든 결과에 멈춘 `step`과 step별 소요시간(`trace`)을 붙인다. 답변이 오면 지금처럼 처음부터 다시 돈다.
3. **에이전트 턴을 올린다.** 사용자가 자유 문장을 쳤을 때만 실행된다. 버튼과 입력 카드는 지금처럼 계산기로 바로 간다.

   | 결정 | 하는 일 |
   | --- | --- |
   | `reply` | 답하고 종료. 같은 action·카드 유지, 계산기 호출 없음 |
   | `set_inputs` | field 종류별로 검증 → 기존 답변에 merge → 계산기 실행 → 새 질문 또는 다음 단계 |
   | `retry` | 같은 입력으로 계산기 재실행 |
   | `cancel` | 기존 중단 |
   | `switch` | 기존 **작업 변경** 사용을 안내 (자동 전환은 아직 없음) |

4. **`BusinessFlow` 연결을 고친다.** 답변 전용 경로(새 action을 만들지 않음), 이전 답변 수정 허용, 부분 답변의 required 완화, 예외 종류별 안내와 원문 보존.

분기 종류별로 에이전트가 하는 일:

| 분기 종류 | 개수 | 에이전트가 하는 일 |
| --- | --- | --- |
| 사용자만 아는 사실·값 | 8 | 말을 patch로 옮긴다. 값을 지어내지 않는다. 반영 내용은 코드가 되읽는다 |
| 모호해서 묻는 것 | 3 | 첫 버전은 위와 같다. 이후 후보 제안을 붙일 수 있다 |
| 형식 오류 | 6 | patch가 종류별 검증을 통과해야 하므로 대부분 도달하지 않는다 |
| 환율 조회 실패 | 1 | 사용자가 "다시 조회해줘"라고 하면 재조회 확인을 patch로 넣는다 |
| 최종 확인 | 1 | 설명만 한다. 승인은 버튼 |

예시 (`CLOSING_MISMATCH`에서 멈춘 상태):

1. "왜 안 맞아?" → `reply`: 질문문의 전일 잔액·실적 반영액·계좌잔고·차이를 근거로 설명. 카드는 그대로.
2. "3번 거래 아직 안 나갔어" → `set_inputs({actualEdits: {changes: [{index: 3, amount: "0"}]}})` → 기존 수정에 merge → 계산기 실행 → `REVIEW`에서 멈춤.
3. 코드가 "다음 내용을 반영해 다시 확인합니다. 실적: 금액 수정 1건…"을 남기고 최종 확인을 보여준다. 승인은 사용자가 버튼으로 한다.

### 하지 않는 것

- **step마다 model이 다음 행동을 결정하는 구조:** 정상 실행에 호출만 늘고, model이 순서를 건너뛸 여지가 생긴다.
- **step 결과를 저장해 중간부터 재개:** step 사이에 통합문서 객체처럼 저장할 수 없는 값이 오간다. 답변이 올 때마다 처음부터 다시 도는 방식을 유지하고, FX만 지금처럼 `checkpoint.rates`로 재사용한다. 재실행이 실측으로 느릴 때 다시 검토한다.
- **review 전용 재검증 경로:** review는 이미 거래표 field를 함께 반환하고 hash가 audit 전체를 덮는다. 거래를 고치면 기존 승인은 자동으로 무효가 된다.
- **별도 draft 저장소·새 DB table:** `business_jobs`의 `input.values`가 곧 draft다.

## 3. 현재 코드 (변경 전)

- **파일 구성:** 계산·파싱·출력 부품은 `dailyCash/` 아래 여러 파일(`cashStatus`, `weekly`, `hana`, `report`, `image`, `nativeExcel`, `libreOffice`)에 있다. **순서와 19개 질문은 전부 [dailyCash.ts](electron/business/dailyCash.ts)의 `execute` 함수 하나**에 있다.
- **진입:** `AgentPage → IPC → runtime → Harness.start`. [BusinessFlow.start](electron/business/flow.ts)가 입력 카드를 만든다. 파일은 `previousReport` 1개, `weeklyPlans` 1개 이상, `cashStatus` 1개이며 `uploadOnly`라 picker로만 받는다.
- **실행:** `BusinessFlow.executeSubmission`이 version·action ID·schema·lock·fingerprint를 확인하고 [business.worker](electron/workers/business.worker.ts)에서 `execute({values, files, checkpoint, signal})`를 호출한다.
- **결과:**
  - `needs_input`: 질문문과 fields를 돌려주고 종료. 답변이 오면 누적 입력으로 **처음부터 다시 실행**.
  - `failed`: L222의 catch 하나가 모든 `throw`를 message만 담아 반환. `BusinessFlow.retry()`가 입력 카드로 되돌린다.
  - `completed`: BusinessFlow가 checks·XLSX·PNG를 추가 검증한 뒤 일보 파일 갱신 → artifact 저장 → DB 등록.
- **일보 파일 갱신의 의미:** 전일 일보 통합문서에 새 날짜 시트를 **추가**하고(`archive.appendSheet`), 그 통합문서로 디스크의 파일을 교체한다(`updateSource: "previousReport"` → `sources.replace`). 기존 시트는 바꾸지 않는다. 교체 전 사본은 남기지 않는다.
- **채팅:** [flow.ts](electron/business/flow.ts) L84–87. 취소 표현 외의 모든 메시지에 "입력 화면에서 작성해 주세요"만 답한다. R2–R4가 막히는 지점.
- **잠금:** [flow.ts](electron/business/flow.ts) L155. 첫 제출 뒤에는 현재 대기 중이 아닌 답변을 바꾸면 거절한다.
- **관측:** Daily Cash는 trace를 내지 않는다. `dailyCash.ts`에 `onTrace`/`onProgress` 호출이 없고, worker 경계 타입([workerClient.ts](electron/business/workerClient.ts) L3)에서 `onProgress`가 빠져 있다.

## 4. Step과 질문 ID

### Step

| step | 현재 위치 | 하는 일 |
| --- | --- | --- |
| `evidence` | L70–114 | 날짜·자료 선택, 원천자료 검증, 이전 잔고 확보 |
| `ledger` | L115–169 | 거래 수정, 계좌 연결, 대사 |
| `rates` | L170–184 | 환율 조회·검증·수동 입력 |
| `review` | L185–201 | audit, hash, 승인 확인 |
| `produce` | L202–221 | 시트·수식 생성, 재계산, PNG, 재검증 |

- `ledger`를 더 쪼개지 않는다. 계좌 연결이 거래 적요에 의존하고, 대사가 둘 다에 의존한다.
- **step은 `execute` 안의 경계 표시로 구현했다.** 파일·함수로 옮기지 않았다. step ID와 step별 시간은 이것으로 얻고, 금융 로직을 옮기는 위험은 지지 않는다. 물리적으로 나누려면 step 사이에 공유하는 값(전일 시트, 계좌 목록, 연결, 이전 잔고, 실적 등)을 담는 context 타입이 먼저 필요하다.

### 질문 ID (19곳)

ID 이름은 초안이며 착수 첫날 확정한다. "누가 푸는가"는 코드를 읽고 분류한 것이고, 빈도는 아직 측정하지 않았다.

| step | Line | ID 초안 | 멈추는 이유 | 누가 푸는가 |
| --- | --- | --- | --- | --- |
| evidence | L80 | `CARRY_GAP` | 전일 일보가 직전 영업일 것이 아님 | 사용자 (사실 확인) |
| evidence | L97 | `NO_PLAN_DATE` | 주간계획에 해당 날짜 없음 | 사용자 (사실 확인) |
| evidence | L102 | `PRIOR_OVERRIDE_INVALID` | 저장된 전일 금액 보정값을 읽을 수 없음 | 형식 오류 |
| evidence | L109 | `PRIOR_AMOUNT_INVALID` | 전일 금액이 숫자가 아님 | 형식 오류 |
| evidence | L114 | `PRIOR_AMOUNT_MISSING` | 수식 계산 결과가 저장되지 않은 셀 | 사용자 (값 입력) |
| ledger | L124 | `EDITS_INVALID` | 거래 입력을 읽을 수 없음 | 형식 오류 |
| ledger | L128 | `BINDINGS_INVALID` | 계좌 연결 입력을 읽을 수 없음 | 형식 오류 |
| ledger | L134 | `ACCOUNT_BINDING` | 계좌가 전일 일보의 어느 행인지 모름 | 사용자 + model 제안 가능 |
| ledger | L136 | `ACTUALS_CONFIRM` | 실제 집행 여부는 자금현황표에 없음 (매 실행 필수) | 사용자 (사실 확인) |
| ledger | L138 | `DEPOSIT_MISMATCH` | 정기예금 원금과 집행 내역 불일치 | 사용자 (값 수정) |
| ledger | L146 | `CASH_CHANGES_INVALID` | 계좌별 입출금 입력이 잘못됨 | 형식 오류 |
| ledger | L161 | `CASH_RECONCILE` | 계좌별 기초 + 입금 − 출금이 잔고와 다름 | 사용자 (값 입력) |
| ledger | L166 | `CLOSING_MISMATCH` | 실적 합계와 원화 계좌잔고가 다름 | 사용자 + model 제안 가능 |
| ledger | L168 | `MOVEMENT_ACCOUNT` | 거래가 어느 계좌에서 나갔는지 불명확 | 사용자 + model 제안 가능 |
| rates | L173 | `FX_MANUAL_INVALID` | 수동 입력 환율이 잘못됨 | 형식 오류 |
| rates | L179 | `FX_FETCH_FAILED` | 환율 조회 실패 | 자동 1회 재조회로 대체 가능 |
| rates | L180 | `FX_MANUAL_REQUIRED` | 재조회도 실패 | 사용자 (값 입력) |
| rates | L184 | `FX_DATE_DIFFERS` | 은행이 다른 날짜의 고시를 반환 | 사용자 (사실 확인) |
| review | L190 | `REVIEW` | 최종 확인 | 사용자 (버튼 승인만) |

- **model이 스스로 값을 정해도 되는 곳은 없다.** 모든 지점에서 model의 공통 역할은 사용자의 말을 입력으로 옮기는 것과 이유를 설명하는 것이다.
- **"model 제안 가능" 3곳**(계좌 위치, 차액의 원인 거래, 거래별 계좌)은 첫 버전의 범위가 아니다. baseline에서 자주·오래 멈추는 것이 확인되면 그 지점에 후보 제안을 붙인다.
- **"형식 오류" 6곳**은 자연어 입력을 스키마 검증된 patch로 받으면 대부분 도달하지 않는다.
- L124는 형식 오류 외에 거래 수정 검증에서 난 다른 오류도 같은 질문으로 돌려보낸다. 구현에서 `EDITS_INVALID`(읽을 수 없음)와 `EDITS_REJECTED`(검증 거절)로 나눴다. 그래서 code는 20개다.

## 5. 예외 처리: 복구와 보존

### 예외 4종

질문이 아니라 실패로 끝나는 경우(`throw`: `dailyCash.ts` 25곳, `dailyCash/` 하위 53곳)를 사용자가 할 수 있는 일로 나눈다. 전부를 한 번에 분류하지 않고 사용자가 실제로 만나는 것부터 한다.

| 종류 | 의미 | 예 | 처리 |
| --- | --- | --- | --- |
| 입력 수정 | 값을 고치면 해결 | 잘못된 계좌 연결 | **복구.** 원인 설명, 고칠 field 안내, `set_inputs` |
| 재시도 | 같은 입력으로 다시 하면 될 수 있음 | 네트워크 | **복구.** 1회 `retry`, 다시 실패하면 안내 |
| 환경 조치 | 사용자 PC 설정 문제 | Excel/LibreOffice 실행 실패 | **보존.** 조치 방법 안내. 조치 후 사용자가 재시도 |
| 새 작업 필요 | 원천 파일·작업일이 틀림 | 미래 작업일, 잘못된 주 파일 | **보존.** 이유 안내, 새 작업 제안 |

분류되지 않은 실패는 "새 작업 필요"가 아니라 **보존**으로 처리한다: 확인된 메시지와 보존된 상태만 안내하고 자동으로 재실행하지 않는다.

### 해결할 수 없을 때 보존하는 것

- **입력:** 지금까지 확정한 값과 작성 중이던 값. 지금도 실행 전에 저장되므로([flow.ts](electron/business/flow.ts) L186–188) 유지만 하면 된다.
- **멈춘 위치:** `step`과 `code`.
- **근거:** 계산기가 돌려준 메시지 원문. model의 요약으로 대체하지 않는다. 지금은 [flow.ts](electron/business/flow.ts) L350의 `retry()`가 code가 있으면 원문을 "내부 오류"로 덮어쓰므로 고쳐야 한다.
- **trace:** 어느 step까지 통과했고 각 step이 얼마나 걸렸는지.
- **파일 갱신 여부:** 일보 파일 교체가 시작된 뒤의 실패는 "부분 완료"로 구분해 표시한다. 자동으로 다시 실행하지 않는다.

model 호출이 실패하거나 상한에 닿았을 때도 같은 원칙이다: 입력 카드와 작성 중인 값을 유지하고 form으로 계속할 수 있게 한다.

## 6. 자료 탐색 (R1)

**결정 (2026-11-28): `uploadOnly`를 해제하고 연결 폴더에서 찾은 파일을 입력 카드에 미리 채운다.** 전제는 첫 폴더 연결이 쉽고 직관적이어야 한다는 것이다. 한 번 연결하면 이후 실행과 다른 workflow에서 다시 쓴다.

### 탐색 순서

1. **code가 후보를 모은다.** tool이 file field마다 선언한 조건(역할, 파일명·날짜 패턴)으로 연결 폴더를 조회한다. 부품은 있다: `WorkSources.list()`, `WorkSources.files()`, 입력 카드의 연결 파일 목록([BusinessToolCard.tsx](src/Features/Agent/components/BusinessToolCard.tsx) L85–90, 지금은 `uploadOnly`라 건너뜀).
2. **역할마다 조건에 맞는 파일이 정확히 하나면** model 없이 입력 카드에 채운다.
3. **후보가 여러 개이거나 이름이 조건과 다르면** LLM이 파일명·폴더·날짜를 보고 후보와 이유를 제안한다. 파일 내용은 model에 보내지 않는다.
4. **대화 중 요청**("다른 폴더에 있어", "지난주 파일로")은 에이전트가 `find_files`로 다시 찾는다.
5. **어느 경우든 사용자가 확인해야 실행된다.** 시트 날짜·KC 파일명 날짜·중복 검증은 기존 계산기가 그대로 한다.

### 첫 폴더 연결 UX

- **연결된 폴더가 없을 때:** 입력 카드에 **"업무 폴더 연결"** 버튼 하나와 "이번만 파일 첨부" 대안을 보여준다. 설정 화면으로 보내지 않고 작업 흐름 안에서 끝낸다.
- **연결 직후 결과를 바로 보여준다.** 역할별로 "전일 일보: 찾음 / 주간계획: 후보 2개 / 자금현황표: 못 찾음"처럼 표시해서, 폴더가 맞는지 사용자가 그 자리에서 알 수 있게 한다.
- **못 찾은 역할만 따로 요청한다.** 찾은 것은 유지하고 나머지만 첨부하거나 다른 폴더를 추가로 연결한다.
- **폴더가 너무 클 때:** 기존 제한(XLSX 500개, 깊이 10)에 걸리면 오류 대신 "더 좁은 폴더를 골라 주세요"와 다시 고르기 버튼을 보여준다.
- **두 번째 실행부터:** 카드가 채워진 채로 시작한다. 각 파일 옆에서 다른 파일로 바꿀 수 있다.
- **재사용:** 폴더 연결은 workflow에 속하지 않는다(`work_sources` 공유). 새 workflow는 탐색 조건만 선언하면 같은 폴더와 같은 UI를 쓴다.

### 주의할 점

- **위험:** 다른 일보 파일을 골라 그대로 승인하면 엉뚱한 파일에 시트가 추가되고, 교체 전 사본이 없어 앱에서 되돌릴 수 없다. 미리 채우기로 이 실수가 쉬워지므로 교체 전 사본 보관을 함께 검토한다 (§10).
- **파일을 찾는 기준이 역할마다 다르다.** 자금현황표는 파일명 날짜로 찾을 수 있지만 주간계획의 날짜는 셀에 있다. 주간계획은 파일명만으로 확정되지 않을 수 있다.
- **경로가 DB에 남는다.** 지금까지 Daily Cash 파일 경로는 저장되지 않았다. 연결 폴더는 `work_sources`에 경로가 저장된다.
- **재시작 후 이어하기가 가능해진다.** 연결 폴더의 파일은 재시작 뒤에도 다시 읽을 수 있다. 그 사이 파일이 바뀌었으면 fingerprint 검사에서 걸린다.
- **잠금:** 첫 제출로 원천 파일이 잠긴 뒤에는 교체하지 않고 새 작업을 안내한다.
- **범위:** 로컬 연결 폴더만. MARU(원격 저장소)는 결과를 되돌려 쓰는 경로가 확인되지 않아 포함하지 않는다.

## 7. 관측

- **step trace:** runner가 `{step, 소요시간, 결과}` 목록을 `ToolResult`에 실어 돌려준다. worker protocol을 바꾸지 않고 main에서 기록한다. 취소된 실행의 step trace는 남지 않는다.
- **제출 1건당:** 멈춘 `step`·`code` 또는 오류 종류, 전체 소요시간, 몇 번째 라운드인지.
- **에이전트 턴 1건당:** 호출한 도구 순서, 계산 횟수, model 지연·토큰, patch 적용/거절, 상한 도달 여부.
- **schema:** [businessTraceSchema](electron/business/contracts.ts)는 strict이고 phase가 고정이라 확장이 필요하다.
- **보내는 범위:** 금액·계좌명이 포함될 수 있으므로 로컬 trace에만 남길 항목과 중앙 telemetry로 보낼 항목을 정한다 (§10).
- **baseline:** 대화 기능을 붙이기 전에 run당 질문 횟수, 가장 자주 걸리는 `code`, 실패 분포를 먼저 뽑는다. 자연어 patch와 후보 제안을 어느 지점부터 지원할지 이 값으로 정한다.

## 8. 변경 목록

| 대상 | 변경 | 요구 |
| --- | --- | --- |
| [dailyCash.ts](electron/business/dailyCash.ts) `ask()` 19곳 | `code` 부여. 질문문은 그대로 설명 근거로 사용 | R2, R4, 관측 |
| [dailyCash.ts](electron/business/dailyCash.ts) `execute` | step 경계 표시와 step trace. 동작 변경 없음 | 관측 |
| `throw` 지점 | 예외 4종 분류 (§5) | R4 |
| file field 3개 | 역할별 탐색 조건 선언. `uploadOnly` 해제 | R1 |
| [BusinessToolCard.tsx](src/Features/Agent/components/BusinessToolCard.tsx) | 폴더 연결 버튼, 역할별 탐색 결과 표시, 파일별 교체 (§6) | R1 |
| [contracts.ts](electron/business/contracts.ts) `ToolResult` | `needs_input`에 `code`, 모든 결과에 `step`과 step trace 추가 (모두 선택 필드). `failed.code`는 이미 있음 | 전체 |
| [flow.ts](electron/business/flow.ts) L84 `resume` | 안내문 대신 에이전트 턴 호출 | R2, R3 |
| [flow.ts](electron/business/flow.ts) L155·L307 잠금 | 원천 파일·작업일만 잠그고 후속 답변은 수정 허용 | R3 |
| [flow.ts](electron/business/flow.ts) L350 `retry` | 예외 종류별 안내, 원문 보존 | R4 |
| [flow.ts](electron/business/flow.ts) `ask()` | 답변만 추가하고 action ID를 유지하는 경로 추가. 지금은 매번 새 ID를 만들어 카드가 초기화됨 | R2 |
| [flow.ts](electron/business/flow.ts) `start` | 자료 탐색 후 입력 카드에 채우거나 후보 제안 | R1 |
| 신규 `electron/business/agentTurn.ts` | 루프, 도구 정의, field 타입별 patch 적용 | R1–R4 |
| [runtime.ts](electron/agent/runtime.ts) | model client를 main process의 에이전트 턴에 주입. worker에는 넣지 않음 | R1–R4 |
| [useAgentRun.ts](src/Features/Agent/hooks/useAgentRun.ts) | 턴 진행 중·답변 후에도 입력 카드와 작성 중인 값 유지 (지금은 `status` 이벤트가 action을 비움) | R2 |

### R6을 위한 규칙

1. Harness와 BusinessFlow에 tool ID 분기와 새 모드 flag를 넣지 않는다.
2. patch는 field 타입으로 dispatch한다 (`movements`, `accountRows`, `cashRows`, `confirm`, `select`, `text`). 새 workflow는 field만 선언하면 자연어 수정이 따라온다.
3. workflow 고유의 것은 tool이 선언한다: step, 질문 ID, 예외 분류, 파일 탐색 조건. flow와 에이전트 턴은 그 선언을 읽기만 한다.

## 9. 담당과 순서

두 사람: **구현 담당**(코드 구조 숙지)과 **관측 담당**(코드 신규, observability와 harness 설계 논의 중심).

| 단계 | 관측 담당 | 구현 담당 | 끝나면 |
| --- | --- | --- | --- |
| 0 (같이, 하루) | [daily-cash-demo.ts](scripts/daily-cash-demo.ts)를 끝까지 돌리며 §4의 ID와 §5의 분류 확정 | 같음 | 공용 어휘 확정 |
| 1 | `ask()`에 `code` 부여, 기존 테스트에 code 단언 추가, 제출 trace, baseline | 에이전트 턴 뼈대와 `reply`, 카드 유지 | R2 동작 |
| 2 | runner와 step 이동 (`rates` → `review` → `produce` → `evidence` → `ledger`), step trace | `set_inputs`, 잠금 완화, `retry` | R3 동작, step별 관측 |
| 3 | 자료 탐색, 에이전트 턴 trace | 예외 4종 연결, `cancel`/`handoff` | R1, R4 동작 |
| 4 (같이) | 발화 → 기대 도구 호출 평가 세트, 전체 regression, 실제 금융 사례 검토 | 같음 | R5·R6 확인 |

- **파일이 겹치지 않는다.** 관측 담당은 `dailyCash.ts`와 `steps/`, 구현 담당은 `flow.ts`와 `agentTurn.ts`.
- **구현 담당은 1단계의 `code`만 있으면 시작할 수 있다.** step 이동(2단계)을 기다리지 않는다.
- **step 이동은 한 번에 하나씩, 매번 기존 테스트가 그대로 통과해야 한다.** 금융 로직을 옮기는 일이라 구현 담당이 리뷰한다. 1단계의 code 단언이 안전망이다.
- **둘 사이 계약:** `step`·`code` 값 목록(§4), 예외 분류(§5), trace 형식. 그 외는 각자 결정한다.

## 10. 결정이 필요한 것

| 항목 | 권장 | 이유 |
| --- | --- | --- |
| ~~`uploadOnly` 해제~~ | **결정됨 (2026-11-28): 해제, 미리 채움** | §6. [BUSINESS_TOOLS.md](docs/BUSINESS_TOOLS.md) L55의 설명도 구현 시 함께 고친다 |
| 일보 파일 교체 전 사본 보관 | 교체 직전 원본을 같은 폴더에 사본으로 남김 | 미리 채운 파일을 그대로 승인하는 실수가 쉬워지는데, 지금은 되돌릴 방법이 없음 |
| 경로 저장 | 금융 자료 폴더 경로가 로컬 DB에 남는 것을 허용 | 연결 폴더 방식의 전제. 처음 `uploadOnly`를 건 이유와 충돌하는지 확인 |
| 이전 답변 수정 허용 범위 | 원천 파일·작업일만 잠금 | 앞선 답을 바꿨을 때 뒤의 답(`cashChanges`, 계좌 연결)이 틀린 채 남지 않는지 테스트로 먼저 확인. 이 계획의 가장 큰 금융 위험 |
| 확인형 입력을 말로 받을지 | 사실 확인(휴무일, 계획 없음, 고시일)은 허용하고 반영 내용을 되읽음. 최종 승인은 버튼만 | 승인의 명시성 유지 |
| `FX_FETCH_FAILED`를 자동 재조회로 바꿀지 | 묻지 않고 1회 재조회 | 사용자가 판단할 것이 없음 |
| 전환 처리 위치 | 에이전트 턴은 BusinessFlow, 전환은 기존 `WorkflowHandoff`로 Harness에 위임 | Harness에 업무 지식을 넣지 않기 위해 |
| telemetry 범위 | `step`·`code`·횟수·시간만 중앙 전송, 금액·계좌·발화 원문은 로컬 | 금융 정보 |
| 턴당 상한 | 도구 4회, 계산 2회로 시작 | baseline과 평가 세트로 조정 |

## 11. 완료 기준

- **테스트 구성:** model 응답은 기존 `createFixtureClient`로 고정, 계산기는 [fixtureBooks](electron/business/dailyCash/fixtures.ts)로 실제 것을 사용. 가짜 계산기는 만들지 않는다.
- **R1:** 조건에 맞는 파일이 하나씩이면 model 없이 카드에 채워짐. 모호하면 후보와 이유를 제안. 확인 전에는 실행되지 않음. 연결 폴더가 없으면 카드 안에서 연결하고 역할별 결과를 바로 확인할 수 있음.
- **R2:** 질문 뒤 계산기 호출 0회, action ID와 작성 중인 값 유지.
- **R3:** "2번 미집행" → 해당 거래만 0으로 변경되고 다른 수정은 유지. 부분 답변 뒤 남은 것만 다시 질문. 잠긴 field 변경은 거절.
- **R4 복구:** 입력 수정·재시도 종류는 허용된 조치로 다음 step까지 진행.
- **R4 보존:** 환경 조치·새 작업 필요·미분류 실패에서 입력, `step`·`code`, 메시지 원문이 남고 자동 재실행이 없음. model 실패·상한 도달 시에도 입력 카드 유지.
- **R5:** 거래 수정 뒤 새 hash로 재확인. 이전 hash나 일반 메시지로는 완료되지 않음.
- **R6:** fixture용 두 번째 tool을 선언만으로 추가했을 때 Harness·BusinessFlow 수정 없이 대화가 동작.
- **model 호출:** 카드와 버튼만 쓰는 정상 실행에서 0회.
- **lifecycle:** 취소·전환 뒤 늦은 응답 무시, 중복 제출 차단, 파일 쓰기 시작 뒤 전환 거부.
- **금융:** 기존 [Daily Cash](electron/business/dailyCash.test.ts)·[report](electron/business/dailyCash/report.test.ts) 테스트가 step 이동 전후로 그대로 통과. 정상 경로의 질문 수가 늘지 않음.
- **보장하지 않는 것:** fixture와 고정 model 응답만으로는 실제 model의 판단 정확도, 실제 금융 자료의 정답, 설치된 Excel 동작을 보장하지 않는다. 평가 세트(실제 model)와 pilot에서 따로 확인한다.

## 12. 아직 측정하지 않은 것

- 계산기 1회 재실행의 실제 소요시간 (부분 답변마다 전체 재실행하는 설계의 전제).
- 19개 질문 각각의 실제 발생 빈도와 사용자가 머무는 시간.
- 거래표·계좌 연결 patch에 대한 현재 model alias의 정확도.
- 연결 폴더에서 파일명·날짜 패턴만으로 세 역할의 파일을 유일하게 찾을 수 있는 비율.

## 13. 구현 상태 (2026-11-28, `dev`)

### 들어간 것

| 요구 | 구현 | 위치 |
| --- | --- | --- |
| 관측 | 질문 code 20개, step 5개, step별 시간, 실행 1건당 trace 1건, 대화 턴 1건당 trace 1건 (로컬 전용, 금액 없음) | [dailyCash.ts](electron/business/dailyCash.ts), [flow.ts](electron/business/flow.ts) |
| R2 | `reply`: 같은 action과 카드 유지, 계산기 호출 없음 | [flow.ts](electron/business/flow.ts) `say`, [useAgentRun.ts](src/Features/Agent/hooks/useAgentRun.ts) |
| R3 | `set_inputs`: field 종류별 patch merge, 부분 답변, 이전 답변 수정. 원천 파일·작업일은 잠금 유지 | [agentTurn.ts](electron/business/agentTurn.ts) `applyPatch` |
| R4 | 예외 분류(`recovery`)와 종류별 안내, 원문 메시지 보존, 멈춘 step과 마지막 오류를 작업에 저장. `retry` 결정 | [contracts.ts](electron/business/contracts.ts), [flow.ts](electron/business/flow.ts) `retry` |
| R5 | `review`를 `manualOnly`로 표시해 대화로 승인 불가. 수정 시 새 hash는 기존 동작 그대로 | [dailyCash.ts](electron/business/dailyCash.ts) |
| R6 | 대화 턴은 tool ID를 모른다. field 종류와 `manualOnly`, 결과의 `code`·`step`·`recovery`만 읽는다 | [agentTurn.ts](electron/business/agentTurn.ts) |

### 계획과 다르게 한 것

- **step은 파일로 옮기지 않고 경계 표시로 구현했다** (§4). 필요하면 이후에 옮긴다.
- **턴당 결정 1회.** 도구를 여러 번 부르는 루프가 아니다. 입력을 반영한 뒤의 안내는 model이 아니라 코드가 만든다 ("다음 내용을 반영해 다시 확인합니다…").
- **`switch`는 안내만 한다.** 자동 전환은 Harness와의 연결이 필요해 넣지 않았다.
- **예외 분류는 확실한 것만 했다.** `evidence` step의 실패 전체와 "새 작업" 사유 4곳은 `new_run`, 사용자가 넣은 계좌 위치가 거절된 경우는 `fix_input`, 두 출력 엔진이 모두 실패한 경우는 `environment`. 나머지는 미분류(원문만 안내)이고, `retry` 종류를 내는 곳은 아직 없다.
- **Daily Cash의 tool version은 올리지 않았다.** 계산 결과가 같고, 올리면 대기 중인 기존 작업이 모두 무효가 된다.

### 아직 안 한 것

- R1 자료 탐색, `uploadOnly` 해제, 폴더 연결 UX (§6).
- 일보 파일 교체 전 사본 보관 (§10).
- `FX_FETCH_FAILED` 자동 재조회, model 후보 제안 3곳.
- 실제 금융 자료와 실제 사용자 발화로 만든 평가 세트. 지금 것(§14)은 가상 데이터와 직접 쓴 발화 32개다.
- 중앙 telemetry 전송. 새 trace는 모두 로컬 전용이다.

### 검증한 것

- 전체 테스트 통과 (Daily Cash 61, BusinessFlow 35, 대화 patch 4, 렌더러 hook 10 포함), 변경 파일 lint·typecheck 통과.
- 실제 계산기와 fixture 통합문서로, 채팅만으로 부분 답변 → 설명 → 수정 → 승인 거절 → 재수정까지 간 뒤 버튼 승인으로 완성한 일보가 기존 form 경로 테스트와 같은 셀 값을 내는 것을 확인했다 ([flow.test.ts](electron/business/flow.test.ts)).
- **검증하지 않은 것:** 실제 앱 화면에서 카드가 유지되는지, 설치된 Excel 출력.

## 14. 실제 model 확인 (2026-11-28)

`npm run eval:daily-cash-chat` ([scripts/daily-cash-chat-eval.ts](scripts/daily-cash-chat-eval.ts)). 실제 계산기를 fixture 통합문서로 돌려 얻은 멈춤 상태(집행 확인, 잔고 불일치, 최종 확인)와 문구를 옮겨 온 두 상태(환율 조회 실패, 새 작업이 필요한 실패)에 발화를 한 번씩 보내고, 앱과 같은 `parseDecision`·`applyPatch`를 거친 결과를 기대값과 비교한다. model에는 가상 데이터만 간다.

### 원칙

**model은 계산기가 정한 것을 바꾸지 않는다.** 합계가 맞고 기존 서식이 유지되는 것이 우선이고, 긴 설명과 꾸밈은 혼선만 만든다.

- 일보 시트 생성·수식·서식·대사는 대화 경로와 무관하다. 대화는 사용자가 카드로 넣던 것과 같은 입력값만 바꾼다.
- 사용자가 말하지 않은 거래·계좌·금액은 patch에 넣지 않는다. 계획 금액을 그대로 다시 적은 항목은 코드가 버려서, 손대지 않은 거래가 "담당자 수정"으로 바뀌지 않는다.
- 답변은 물은 것만 세 문장 이내. 숫자와 항목 이름은 근거에 적힌 그대로 옮긴다. 업무 항목의 뜻은 질문문에 적힌 내용으로만 설명한다.
- 반영한 내용은 코드가 항목별로 되읽는다: "2번 소모품 지급: 1000 → 2000".

### 결과 (model `loki`)

| 시점 | 통과 | 비고 |
| --- | --- | --- |
| 처음 (22개) | 16/22 | 실패 3건은 JSON 형식, 3건은 해석 |
| 파서·프롬프트 수정 후 (30개) | 26~29/30 | 새 발화 8개 추가 |
| 간결한 답변·불필요한 수정 금지 후 | 30, 29, 29 /30 | 답변 길이 중앙값 약 95자, 최대 179자 |
| 번호 지정 규칙 추가 후 (32개) | 32, 32, 32 /32 | 지연 중앙값 약 1.4초, 최대 약 3.7초 |

### 발견해서 고친 것

- **JSON 형식이 불안정하다.** 닫는 괄호가 하나 많거나 모자라고, 요청하지 않은 키를 붙인다. 파서가 복구하고 여분 키는 버린다.
- **말하지 않은 값을 유도했다.** "소모품은 1800원이었어"에 계좌 출금액을 덧붙였다. patch 밖의 키는 버리고 프롬프트에서 금지했다.
- **답변이 길고 꾸밈이 섞였다.** "신규 가입"을 설명하며 근거에 없는 상품을 나열했고, 일반 질문에 프롬프트 문구를 읊었다. 답변 규칙을 고친 뒤로는 가장 긴 답도 180자 이하였다 (고치기 전에는 300자를 넘는 답이 있었다).
- **거래 번호를 잘못 읽었다.** "2번은 안 나갔고 1번은 맞아"에 1번을 0원으로 넣은 적이 9번 중 2번 있었다. 번호별로 따로 적용하라는 규칙을 넣은 뒤 같은 유형 세 발화가 세 번 모두 맞았다.

### 잘못 읽었을 때의 방어선

1. **항목별 되읽기.** 무엇을 얼마에서 얼마로 바꿨는지 바로 보여준다.
2. **계산기의 대사.** fixture에서 1번을 잘못 0원으로 넣으면 `DEPOSIT_MISMATCH`, 2번을 잘못 0원으로 넣으면 `CLOSING_MISMATCH`에서 멈춘다. 평가 스크립트는 틀린 patch가 최종 확인까지 가는지를 매번 센다. 지금까지 0건이다.
3. **최종 확인의 "계획 대비 실적 차이"와 버튼 승인.**

대사가 모든 오독을 잡는다는 보장은 아니다. 잘못 읽은 값이 우연히 잔고와 맞으면 최종 확인까지 간다.

### 한계

- 발화 32개, 거래 2건짜리 가상 표. 실제 일보는 거래가 훨씬 많다.
- 프롬프트를 처음 22개와 번호 지정 1개에 맞춰 고쳤으므로 그 통과율은 과대평가돼 있다.
- 한 번 실행이 표본 하나다. 같은 발화도 실행마다 결과가 달랐다.
