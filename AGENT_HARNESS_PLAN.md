# 자유도 높은 에이전트 하네스 조사와 케찹이 적용 구현계획

- 작성일: 2026-11-22 (Asia/Seoul)
- 기준 코드: `dev` 브랜치 작업 트리 (클라이언트 3.0.x, `electron/agent/harness.ts` 기준 "harness-1")
- 범위: 조사 → 현재 하네스 진단 → 목표 구조 → 단계별 구현계획. 이 문서는 계획이며 소스는 수정하지 않았다.
- 관련 문서: [KETCHUPE_V3_ARCHITECTURE.md](docs/KETCHUPE_V3_ARCHITECTURE.md), [BUSINESS_TOOLS.md](docs/BUSINESS_TOOLS.md), [EXCEL_REVISION_HITL_AND_EXPORT_PLAN.md](docs/EXCEL_REVISION_HITL_AND_EXPORT_PLAN.md)

---

## 0. 요약

**결론:** 최근 자유도 높은 에이전트(Claude Code / Claude Agent SDK, OpenAI Codex, Manus, LangChain Deep Agents)는 공통적으로 **"하나의 모델-도구 루프 + 도구 단위 권한 게이트 + 지속 가능한 실행 상태 + 사람과의 상호작용도 도구 호출로 표현"** 하는 구조다. 업무 절차는 고정된 workflow 그래프보다 **결정론적 도구와 업무 지식 패키지(skill)** 로 제공하고, 위험한 행동만 하네스가 강제로 멈춘다.

케찹이는 지금 반대 방향으로 짜여 있다. Harness가 요청을 **하나의 workflow로 라우팅**하고(`router.ts`), 실행기마다 자기만의 루프·질문 방식·재개 규칙을 갖는다(ChatWorkflow 정책 루프, Excel 플래너 루프, daily_cash 카드 흐름). 사람과의 상호작용은 전부 `BusinessFlow.ask()`가 띄우는 `BusinessField[]` 카드이고, 대기 중 들어온 입력은 무조건 "답변"으로 처리된다.

**권장 방향:** 기존 실행기를 버리지 않고, 그 위에 **에이전트 루프 1개**를 얹는다. daily_cash·엑셀 분석·RAG·문서 초안은 루프가 부르는 **도구**가 되고, 질문·승인·변경 제안은 **상호작용 도구**(`ask_user`, `propose_change`, `request_approval`)가 된다. 금액의 정확성은 "모델은 금액을 만들지 않는다, 결정론 도구 결과이거나 사용자가 diff로 확인한 값만 계산에 들어간다"는 **값 출처(provenance) 규칙**으로 지킨다. 지금 daily_cash가 채팅 답변을 계산 입력으로 막는 이유(금액 정확성)는 이 규칙으로 대체되므로, 자유도를 높여도 안전 수준은 낮아지지 않는다.

단계는 6개다. 사용자 체감이 가장 큰 순서로 **(1) 대기 중 입력 해석기 → (2) 자연어 금액 수정 diff-확인 → (3) 실행기의 도구화와 권한 정책 → (4) 에이전트 루프 → (5) skill·작업 메모리 → (6) 평가·관측**이다. 1~2단계는 현재 Harness 구조를 유지한 채 넣을 수 있다.

---

## 1. 조사: 최근 자유도 높은 에이전트 하네스의 구조

여기서 "하네스(harness)"는 모델 바깥에서 루프를 돌리고, 도구를 실행하고, 권한을 판단하고, 상태와 컨텍스트를 관리하는 코드 전체를 말한다.

### 1.1 루프는 단순하게: 하나의 모델-도구 반복

- **OpenAI Codex**는 모델이 사용자 메시지를 반환하거나 도구 호출을 요청하고, 하네스가 도구를 실행해 결과를 붙인 뒤 다시 모델을 부르는 것을 도구 호출이 멈출 때까지 반복한다. 사용자 입력에서 assistant 메시지까지를 한 "turn"으로 보고, 한 turn 안에 여러 번의 모델·도구 호출이 들어간다. turn은 항상 assistant 메시지로 끝난다. 도구에는 shell, **계획 갱신 도구**, 웹 검색, MCP 도구가 있다. [Codex agent loop]
- **Anthropic**은 하네스를 설계할 때 "모델에 기대고 하네스는 줄이라"고 권한다. bash·텍스트 편집기처럼 모델이 잘 다루는 범용 도구를 기반으로 하고, 모델이 좋아질 때마다 "이제 하네스가 그만해도 되는 일"을 찾아 걷어낸다. 예: 도구 결과를 모델이 코드 실행으로 직접 걸러내게 하자 BrowseComp 정확도가 45.3%에서 61.6%로 올랐다. [Harness 3 patterns]
- 장기 앱 개발 실험에서도 "하네스의 모든 구성요소는 모델이 혼자 못 한다는 가정이며, 모델이 좋아지면 그 가정은 낡는다"고 정리한다. 컨텍스트 리셋은 Opus 4.5에서, 스프린트 분할은 Opus 4.6에서 제거됐고, 계획자(planner)는 생성기가 범위를 줄여버리는 문제 때문에 남았다. 구성요소는 한 번에 하나씩 빼서 어느 것이 실제로 하중을 받는지 확인하라고 한다. [Harness design for long-running apps]

**케찹이에 주는 시사점:** 실행기마다 다른 루프(정책 루프, 엑셀 플래너 루프, 카드 흐름)를 두는 것보다, 하나의 루프에 도구를 꽂는 편이 사용자와의 상호작용 규칙을 통일하기 쉽다.

### 1.2 경계는 도구 단위로: 권한 평가 계층

- **Claude Agent SDK**는 도구 호출마다 `Hooks → deny 규칙 → ask 규칙 → 권한 모드 → allow 규칙 → canUseTool 콜백` 순서로 판단한다. 모드는 `default`, `dontAsk`, `acceptEdits`, `bypassPermissions`, `plan`, `auto`가 있고, 세션 중에 바꿀 수 있다(처음엔 엄격하게, 신뢰가 쌓이면 완화). `AskUserQuestion` 같은 사용자 상호작용 도구는 allow 규칙이 있어도 항상 콜백으로 넘어간다. [Claude Agent SDK permissions]
- Anthropic은 **보안 게이트·사용자 표시·감사가 필요한 행동은 범용 명령이 아니라 전용 typed tool로 승격**하라고 권한다. 특히 되돌리기 어려운 행동을 우선 대상으로 하고, 편집 도구에는 최신 여부(staleness) 검사를 넣는다. [Harness 3 patterns]
- **OpenAI Agents SDK**는 도구마다 `needs_approval`을 `True` 또는 인자별 판단 함수로 지정한다. 승인이 필요하면 실행이 `interruptions`로 멈추고, `state.approve()/reject()` 후 재개한다. 실행 상태(`RunState`)는 JSON으로 직렬화해 나중에 재개할 수 있고, `always_approve` 같은 "이번 실행 동안 기억되는 승인"도 있다. 재개 시 상태는 신뢰된 저장소에서만 읽고 승인자의 권한을 확인하라고 명시한다. [OpenAI Agents SDK HITL]
- **LangChain v1 HITL 미들웨어**는 도구별 `interruptOn` 정책과 네 가지 결정을 둔다: `approve`(그대로 실행), `edit`(인자를 고쳐 실행), `reject`(실행하지 않고 피드백 반환), `respond`(실행하지 않고 사람의 답을 도구 결과로 반환, "사용자에게 묻기"용). 부작용 있는 도구를 거부할 때 `respond`를 쓰면 모델이 성공으로 오해하므로 쓰지 말라고 한다. 멈춤 상태는 체크포인터로 저장한다. [LangChain HITL]

**시사점:** 케찹이의 "원본 파일 갱신 시작 후 전환 금지(`workflow.effect_started`)" 같은 규칙은 이미 좋은 경계다. 이를 workflow 단위가 아니라 **도구 단위 효과 등급**으로 일반화하면, 자유도를 높여도 위험한 지점은 계속 하네스가 강제할 수 있다.

### 1.3 사람과의 상호작용도 도구 호출이다

- **12-Factor Agents**(HumanLayer)는 "사람에게 연락하는 것도 도구 호출로 표현하라(contact humans with tool calls)", "제어 흐름은 앱이 소유하라", "작고 초점이 분명한 에이전트를 만들라"를 원칙으로 든다. 질문·승인 요청이 구조화된 도구 호출이 되면, 멈춤·재개·기록을 일반 도구와 같은 방식으로 다룰 수 있다. [12-Factor Agents]
- **MCP Elicitation**(2025-11-25 사양)은 서버가 클라이언트를 통해 사용자에게 구조화된 입력을 요청하는 표준이다. 폼 스키마는 의도적으로 **평평한 원시 타입(문자열·숫자·불리언·enum)** 으로 제한하고, 응답은 `accept / decline / cancel` 세 가지로 구분한다. 비밀번호·토큰 같은 민감정보는 폼으로 받지 말고 URL 모드로 처리해야 한다. 클라이언트는 사용자가 제출 전에 응답을 검토·수정할 수 있게 해야 한다. [MCP elicitation]
- **AG-UI**는 에이전트 백엔드와 UI 사이를 약 16종의 표준 이벤트로 연결하는 프로토콜이다. 사람 개입, 양방향 상태 동기화, 프론트엔드 도구, 생성형 UI를 핵심 기능으로 둔다. [AG-UI]

**시사점:** 케찹이의 `BusinessField[]` 카드는 elicitation 폼과 거의 같은 개념이다. 차이는 (a) 질문을 **실행기 코드만** 만들 수 있고 모델·루프는 만들 수 없다는 점, (b) 응답이 `accept/decline/cancel` 구분 없이 "제출"뿐이라는 점, (c) 대기 중 자유 입력의 의미를 해석하지 않는다는 점이다.

### 1.4 상태는 지속되고, 컨텍스트는 설계된다

- **Manus**의 교훈: 프롬프트 앞부분을 안정적으로 유지해 KV 캐시 적중률을 높이고 컨텍스트는 추가만 한다. 상태에 따라 도구를 **넣고 빼지 말고 가린다(mask, don't remove)**. 파일 시스템을 무제한 외부 기억으로 쓰고, 압축은 경로·URL을 남겨 되돌릴 수 있게 한다. `todo.md`를 계속 다시 써서 목표를 최근 컨텍스트에 둔다. **실패와 오류를 숨기지 않고 컨텍스트에 남긴다.** 반복적인 행동 기록이 모델을 같은 패턴에 가두지 않도록 변화를 준다. [Manus context engineering]
- **Anthropic 컨텍스트 엔지니어링**: 필요한 시점에 도구로 불러오는 just-in-time 조회, 한도에 가까우면 요약해 새 창에서 이어가는 compaction(가장 가벼운 형태는 오래된 도구 결과 지우기), 컨텍스트 밖에 쓰는 구조화된 노트(to-do, NOTES.md), 깨끗한 컨텍스트에서 일하고 1,000~2,000토큰 요약만 돌려주는 서브에이전트, 겹치지 않는 최소 도구 세트. [Effective context engineering]
- **Codex**는 매 요청에 전체 기록을 보내되 앞부분이 정확히 이전 프롬프트의 접두사가 되게 해 캐시를 살린다. 도구·모델·샌드박스·승인 모드·작업 폴더가 바뀌면 캐시가 깨지므로, 설정 변경은 앞 메시지를 고치지 않고 새 developer 메시지로 덧붙인다. [Codex agent loop]
- **장기 실행 하네스**: 첫 세션(initializer)이 기능 목록을 JSON으로 만들고(모델이 Markdown보다 덜 함부로 고친다), 이후 세션은 진행 파일·git 기록을 읽고 기능을 하나씩 끝내며 "깨끗한 상태"를 남긴다. 사람처럼 실제로 써 보는 검증이 단위 테스트보다 버그를 훨씬 많이 잡았다. [Effective harnesses for long-running agents]

### 1.5 지식과 확장: skill, 서브에이전트, 그리고 신중함

- **Agent Skills**는 점진적 공개(progressive disclosure)를 쓴다. 1단계로 이름·설명만 시스템 프롬프트에 두고, 관련 있을 때 `SKILL.md` 본문을 읽고, 더 필요하면 연결 파일이나 스크립트를 쓴다. 스크립트는 결정론적이라 반복 가능하다. 신뢰할 수 있는 출처의 skill만 설치하고, 외부 네트워크 접속이나 데이터 유출을 지시하는 내용을 감사하라고 한다. 2025-12-18에 공개 표준이 됐다. [Agent Skills]
- **LangChain Deep Agents**는 이 패턴을 묶어 제공한다: `write_todos` 계획 도구, 가상 파일 시스템, 격리된 서브에이전트를 띄우는 `task` 도구, 자동 요약, 도구별 사람 승인(`interrupt_on`), `SKILL.md` skill, 시작 시 항상 읽는 `AGENTS.md` 메모리. [Deep Agents harness]
- **Cognition**은 다중 에이전트를 경계한다. 에이전트끼리는 메시지 일부가 아니라 전체 실행 기록을 공유해야 하고, "행동은 암묵적 결정을 담고 있어서" 서로 다른 가정으로 움직이는 에이전트는 충돌하는 결과를 낸다. [Don't build multi-agents]

### 1.6 공통 구조 정리

| 구성요소 | 업계 공통 패턴 | 대표 출처 |
| --- | --- | --- |
| 루프 | 단일 모델-도구 반복, turn은 assistant 메시지로 끝남, 계획 도구 내장 | Codex, Agent SDK |
| 도구 | 범용 + 겹치지 않는 최소 세트, 위험 행동은 전용 typed tool | Anthropic 3 patterns, context engineering |
| 권한 | 도구 단위 정책, 인자별 승인 판단, 모드 전환, 승인/수정/거부/응답 | Agent SDK, OpenAI SDK, LangChain |
| 사람 상호작용 | 질문·승인을 도구 호출로, 평평한 폼 스키마, accept/decline/cancel | 12-Factor, MCP elicitation |
| 상태 | 직렬화 가능한 실행 상태, 체크포인터, 멈춘 지점에서 재개 | OpenAI RunState, LangGraph |
| 컨텍스트 | 안정된 접두사, 추가만, 도구는 가리기, 파일 참조, compaction, 오류 보존 | Manus, Codex, Anthropic |
| 진행 기록 | todo/진행 파일/기능 목록 JSON | Manus, long-running harness |
| 검증 | 별도 평가자, "완료"의 사전 합의, 실제 사용처럼 검증 | long-running apps |
| 지식 | skill의 점진적 공개, 결정론 스크립트 | Agent Skills |
| 분업 | 서브에이전트는 컨텍스트 격리용으로 제한적으로 | Context engineering, Cognition |
| UI | 이벤트 기반 스트림, 상태 동기화, 생성형 UI | AG-UI |

---

## 2. 현재 케찹이 하네스 진단

### 2.1 구조

```text
React ─ IPC ─ Harness.start(text)
                ├─ (대기 중 run 있음) → Harness.resume(runId, text) → 소유 workflow.resume
                ├─ explicit $workflow / mode → 바로 선택
                └─ Clef /v1/systemone choice 라우팅 → workflow 하나 선택
                       ├─ chat / rag  → ChatWorkflow 정책 루프 (SEARCH/ASK/VERIFY/ANSWER/STOP/HANDOFF)
                       ├─ doc         → CanvasFlow
                       ├─ work_sources→ WorkSourcesFlow
                       ├─ daily_cash  → BusinessFlow + dailyCashTool (결정론, ask 카드 연쇄)
                       └─ excel_work  → BusinessFlow + excelTool (inspect/execute/inspect_result/finish/ask 플래너 루프)
```

| 요소 | 현재 구현 | 위치 |
| --- | --- | --- |
| 요청 소유 | Harness가 `routing` run을 만들고 실행기가 같은 run을 채택. 한 thread에 열린 run은 1개 | `electron/agent/harness.ts`, `runLifecycle.ts` |
| 라우팅 | Clef choice 모델이 등록 workflow 중 하나를 선택. 실패 시 모델·workflow 전환 없음 | `electron/agent/router.ts` |
| workflow 전환 | 실행기가 `WorkflowHandoff`를 던지거나 사용자가 **작업 변경**. 요청당 최대 2회, 재방문 금지, 원본 갱신 시작 후 금지 | `harness.ts` (`MAX_HANDOFFS = 2`, `checkHandoff`) |
| 일반 루프 | ChatWorkflow 정책 루프. 기본 `maxSteps 6`, `maxModelCalls 8`, `maxSearchCalls 3`, 실행 180초 | `chatWorkflow.ts`, `policy.ts` |
| 엑셀 루프 | 플래너가 JSON 한 개로 다음 행동을 고름. turns 24, inspections 12, executions 4, repairs 2, 제출 15분 | `electron/excel/tool.ts`, `limits.ts` |
| 도구 | `ToolRegistry`는 **애플리케이션이 승인한 읽기 전용 도구만** 등록. MCP는 allowlist로만 | `toolRegistry.ts`, `mcp.ts` |
| 사람 상호작용 | `BusinessFlow.ask()`가 `BusinessAction{question, fields: BusinessField[]}`를 저장하고 `ask_user` 이벤트를 보냄. ChatWorkflow `ASK`는 텍스트 질문 | `electron/business/flow.ts`, `chatWorkflow.ts` |
| 대기 중 입력 | `resume(text)`는 취소 정규식 외에는 **항상 답변으로 처리**. 편집형(엑셀)은 대기 텍스트 필드나 `revision`에 붙이고, daily_cash는 "확인되지 않은 대화 내용을 계산 입력으로 사용하지 않습니다"로 다시 묻는다 | `flow.ts` `resume()` |
| 상태 | SQLite `runs`, `messages`, `trace`, `run_actions`, `business_jobs`(checkpoint 1MB 한도) | `store.ts`, `trace.ts`, `flow.ts` |
| UI 이벤트 | `workflow_changed, status, text_delta, ask_user, citation, completed, failed, canvas` 8종 | `src/app-types/Agent.types.ts` |
| 검증 | daily_cash `checks` 전부 통과해야 완료, 출력 파일 형식·크기 검증, 원천 파일 fingerprint, 결과 해시 재현 검사 | `flow.ts`, `excel/tool.ts` |

진행 중인 변경: 다른 작업에서 엑셀 작업 입력을 대화형으로 바꾸는 중이다(`BusinessAction.conversational`, 채팅 첨부 파일, `startRun/resumeRun` IPC 파일 전달, `BusinessFlow.resume`, 질문 말풍선과 칩). 아래 계획은 그 변경을 전제로 한다.

### 2.2 이미 잘 되어 있는 것 (유지할 자산)

- **결정론 계산과 검증 분리:** daily_cash는 모델 없이 계산하고 `checks`가 모두 통과해야 완료된다. 엑셀도 QuickJS 격리 실행, 결과 해시, 원천 fingerprint를 검사한다. 업계 권장("위험 행동은 전용 도구, 검증은 별도")과 맞다.
- **요청 단일 소유와 순서 보장:** Harness가 run ID와 이벤트 seq를 단일하게 관리하고, 대기 상태는 재시작 후에도 살아남는다. OpenAI `RunState`·LangGraph 체크포인터와 같은 역할을 이미 한다.
- **trace와 telemetry:** 모든 단계가 SQLite trace로 남고 로컬 전용 구간은 중앙 전송에서 빠진다. 에이전트 루프의 이벤트 로그로 그대로 쓸 수 있다.
- **효과 경계:** `workflow.effect_started` 이후 전환을 막는다. 도구 단위 효과 등급으로 일반화할 출발점이다.
- **읽기 전용 도구 레지스트리:** 스키마 검증, 시간 제한, 실패 도구 제외 재계획이 있다. 쓰기 도구 등급만 추가하면 된다.

### 2.3 자유도를 막는 지점 (조사 결과와의 차이)

| # | 차이 | 현재 증상 | 업계 패턴 |
| --- | --- | --- | --- |
| G1 | 대기 중 입력 해석 없음 | 대기 중 "이 계좌는 왜 빠졌어?" 같은 질문도 답변으로 들어감. daily_cash는 같은 카드를 다시 띄움 | 상호작용을 도구 호출로 두고 사용자 메시지는 루프가 해석 (12-Factor, LangChain `respond`) |
| G2 | 질문은 실행기 코드만 만든다 | 모델이 "이 두 후보 중 무엇인가요?"를 물으려면 실행기마다 별도 경로 필요 (엑셀 `ask`, Chat `ASK`, daily_cash `ask()` 3종) | 하나의 `ask_user` 도구, 평평한 폼 스키마 (MCP elicitation) |
| G3 | 응답이 "제출"뿐 | 거부·보류·수정을 구분하지 못해 오류 재시도와 사용자 거부가 같은 카드로 돌아옴 | approve / edit / reject / respond, accept / decline / cancel |
| G4 | 금액 표는 폼으로만 수정 | "대출이자 120만 원은 내일로 옮겨줘"를 말로 할 수 없음 | 제안 → diff → 승인 후 적용 (typed tool + 승인 게이트) |
| G5 | workflow 하나 = 요청 하나 | "자금일보 만들고, 그 결과로 주간 추이 그래프도 그려줘"는 두 요청으로 나눠야 함. 전환은 최대 2회, 재방문 금지 | 단일 루프가 여러 도구를 순서대로 호출, 계획 도구로 진행 관리 |
| G6 | 계획·진행 기록 없음 | 엑셀 플래너의 `steps`는 내부 표시용. 사용자가 볼 수 있는 작업 목록 없음 | todo 도구, 진행 파일 |
| G7 | 업무 지식이 프롬프트·코드에 하드코딩 | `excel/tool.ts`의 SYSTEM 프롬프트가 매우 길고, daily_cash 규칙은 코드에만 있음 | skill 점진적 공개 |
| G8 | 권한이 workflow 단위 | 도구에 효과 등급·승인 정책이 없음. 쓰기 도구는 아예 등록 불가 | 도구별 `needs_approval`, 효과 등급, 모드 |
| G9 | UI 이벤트가 결과 중심 | 도구 호출·계획 갱신·diff 제안을 표시할 이벤트가 없음 | AG-UI식 세분화된 이벤트 |

---

## 3. 목표 구조

### 3.1 설계 원칙

1. **루프는 하나, 업무는 도구.** 새 `AgentLoop`가 대화를 소유한다. daily_cash, 엑셀 분석, 문서 검색, 문서 초안은 루프가 부르는 도구가 된다. 기존 실행기는 그대로 두고 도구 어댑터로 감싼다.
2. **모델은 금액을 만들지 않는다.** 계산에 들어가는 모든 숫자에 출처를 붙인다: `source_file`(원천 파일에서 결정론적으로 읽음), `tool_computed`(결정론 도구 결과), `user_confirmed`(사용자가 카드나 diff에서 확인). 모델이 낸 숫자는 `model_proposed` 상태로만 존재하고, 사용자 확인 전에는 계산 입력이 될 수 없다. daily_cash의 "채팅 답변 금지" 규칙은 이 규칙으로 대체된다.
3. **사람과의 상호작용은 도구 호출.** `ask_user`(질문), `propose_change`(변경 제안 + diff), `request_approval`(위험 행동 승인)의 세 도구로 통일하고, 기존 카드 UI는 이 도구의 렌더러가 된다.
4. **권한은 도구 단위 효과 등급으로.** 하네스가 등급별로 자동 실행·승인 요구·금지를 강제한다. 모델 판단에 맡기지 않는다.
5. **상태는 추가만 하는 기록.** 기존 trace를 루프 이벤트 로그로 확장하고, 계획(todo)과 작업 메모를 별도 구조로 저장한다. 재시작 후 대기 상태에서 재개된다.
6. **컨텍스트는 안정적으로.** 시스템 프롬프트와 도구 목록은 세션 동안 고정하고 상태별로 가린다. 큰 데이터는 참조(파일 ID, 시트·범위, artifact ID)만 두고 필요할 때 도구로 읽는다. 오류는 숨기지 않고 남긴다.
7. **하나씩 넣고, 하나씩 뺀다.** 각 단계는 기능 플래그로 켜고 벤치마크로 효과를 확인한다. 모델이 좋아지면 걷어낼 부분(예: 정형 엑셀 플래너 계약)을 문서에 적어 둔다.

### 3.2 구성요소

```text
                         ┌────────────────────────────── Renderer ───────────────────────────────┐
                         │ 대화 · 계획 패널 · 질문/승인/diff 카드 · 결과 미리보기                    │
                         └────────────────────▲──────────────────────────────┬────────────────────┘
                                 AgentStreamEvent(확장)                 user message / interaction response
                         ┌────────────────────┴──────────────────────────────▼────────────────────┐
Harness (요청 소유, 유지) │ start / resume / cancel / switch   ·   InputInterpreter (대기 중 입력 해석) │
                         └────────────────────┬───────────────────────────────────────────────────┘
                                              │ (agent 모드) 또는 기존 workflow 직접 실행
                         ┌────────────────────▼──────────────────────────────────────┐
                         │ AgentLoop: 모델 ↔ 도구 반복, 계획 도구, 예산, compaction     │
                         └───┬──────────────┬──────────────┬──────────────┬──────────┘
                             │              │              │              │
                     PermissionGate   ToolRegistry(확장)  InteractionTools  SkillLoader
                     (효과 등급·모드)   read/compute/       ask_user /       업무 지식 패키지
                                       artifact/source     propose_change /  (점진적 공개)
                                                           request_approval
                             │
         ┌──────────┬────────┴─────┬──────────────┬──────────────┬─────────────┐
     search_docs  inspect_workbook  run_excel_    run_daily_cash  draft_document  export_report …
     (Tomato/MARU) (workbook worker) analysis       (BusinessFlow   (CanvasFlow)
                                    (QuickJS)       dailyCashTool)
```

### 3.3 대기 중 입력 해석기 (InputInterpreter)

run이 `waiting_user`일 때 들어온 사용자 메시지를 다섯 가지로 나눈다.

| 분류 | 예 | 처리 |
| --- | --- | --- |
| `answer` | "원화 기준으로 해줘", "3번 후보" | 대기 중 질문의 답으로 소유 실행기 `resume`에 전달 (현재 동작) |
| `question` | "이 계좌는 왜 빠졌어?", "전일 잔액은 어디서 가져온 거야?" | run 상태를 바꾸지 않고, 현재 checkpoint·근거를 컨텍스트로 **곁답변**을 스트리밍한 뒤 같은 카드를 유지 |
| `edit` | "대출이자 120만 원은 내일 계획으로 옮겨줘" | `propose_change` 경로(3.4)로 diff 생성 후 승인 대기 |
| `new_task` | "그건 됐고 지난달 출장비 규정 찾아줘" | 현재 작업 유지 여부를 묻는 선택지(이어서/보류/중단 후 새 작업) 제시. 확정 시 기존 **작업 변경** 경로 재사용 |
| `cancel` | "그만", "취소" | 기존 취소 정규식 우선, 모호하면 확인 |

구현 요점:

- 1차는 결정론: 카드 제출(`submitBusinessInput`), 칩 클릭, 취소 정규식은 해석기를 거치지 않는다.
- 2차는 작은 분류 호출: 입력은 대기 중 질문, 필드 목록(키·라벨·타입), 최근 메시지 몇 개, 사용자 문장만 넣는다(엑셀 `revise` 해석기와 같은 크기). 출력은 `{kind, targetKey?, confidence}` 스키마로 검증한다. 기존 Clef `/v1/systemone` choice 형식을 그대로 쓸 수 있다.
- 확신이 낮으면 직접 결정하지 않고 "질문으로 볼까요, 답변으로 넣을까요?" 칩을 띄운다(오분류 비용이 비대칭이므로).
- daily_cash에서 `answer`로 분류돼도 **금액 필드**에는 바로 넣지 않는다. 금액은 3.4의 diff 확인을 거친다. 확인·선택형 필드(`confirm`, `select`)는 값이 선택지와 정확히 일치할 때만 채운다.

### 3.4 자연어 금액 수정: 제안 → diff → 승인 → 적용

daily_cash의 `movements`, `cashRows`, `accountRows` 표를 말로 고친다.

1. 모델은 **패치만** 만든다. 형식 예: `{op: "move" | "set" | "add" | "remove", table: "planEdits", rowKey: "...", field: "amount", value: "1200000", toDate?: "..."}`. 기존 행을 가리킬 때는 반드시 표에 있는 `rowKey`를 쓴다. 금액 문자열은 사용자 문장에 나온 숫자만 쓸 수 있다는 규칙을 검증기로 강제한다(문장에 없는 숫자가 패치에 있으면 거부).
2. 결정론 검증기가 패치를 적용한 **가상 결과**를 만들고, 기존 daily_cash 검사(실적 합계와 계좌잔고 일치, 정기예금 원금 규칙 등)를 미리 돌려 경고를 붙인다.
3. UI는 diff 카드로 "전/후" 행과 영향(합계 변화, 깨지는 검사)을 보여준다. 응답은 **적용 / 고쳐서 적용 / 거절** 세 가지(LangChain `approve/edit/reject`에 대응).
4. 적용되면 값의 출처는 `user_confirmed`가 되고, 기존 `submit()` 경로로 BusinessInput에 반영돼 재실행된다. diff와 사용자 결정은 trace에 남긴다.

이 경로는 엑셀 결과 수정에도 그대로 쓸 수 있다(차트 view 패치는 이미 엑셀 `revise` 해석기가 유사하게 처리한다).

### 3.5 도구 효과 등급과 권한 정책

`ToolRegistry`의 도구 정의에 효과 등급과 승인 정책을 추가한다.

| 등급 | 예 | 기본 정책 |
| --- | --- | --- |
| `read` | 문서 검색, 시트 열람, MARU 조회 | 자동 실행 |
| `compute` | QuickJS 분석, daily_cash 미리 계산 | 자동 실행 (격리·시간 제한 유지) |
| `artifact` | PDF/XLSX/PPTX 결과 생성 | 자동 실행. 사용자의 파일 생성 요청이 곧 승인 (엑셀 프롬프트의 현재 규칙과 동일) |
| `source_write` | 원본 XLSX 갱신(`updateSource`) | 항상 `request_approval`, 이후 전환 금지(`workflow.effect_started` 유지) |
| `external` | 메일 발송, 원격 쓰기 (향후) | 기본 금지. 별도 허용 목록과 매번 승인 |

- 판단 순서는 Claude Agent SDK를 참고한다: **금지 규칙 → 등급 기본 정책 → 인자별 판단(`needsApproval(args)`) → 사용자 결정**. 금지는 어떤 모드에서도 뒤집히지 않는다.
- "이 작업 동안은 결과 파일 덮어쓰기를 다시 묻지 마" 같은 실행 범위 승인은 run 상태에 저장한다(OpenAI `always_approve`에 대응). thread를 넘어가지 않는다.
- MCP 도구는 지금처럼 앱이 검토한 allowlist만 등록한다. MCP 주석(annotation)으로 등급을 올리지 않는다.

### 3.6 에이전트 루프 (AgentLoop)

- **위치:** `electron/agent/loop/`. Harness에 `agent` workflow로 등록해 기존 라우팅·전환·취소·telemetry를 그대로 쓴다. 처음엔 `$agent` 명시 모드와 설정 플래그로만 켠다.
- **turn 구조:** Codex처럼 사용자 입력 → (모델 → 도구)* → assistant 메시지. 상호작용 도구를 부르면 run은 `waiting_user`가 되고 루프 상태를 저장한 뒤 빠져나온다. 재개 시 저장된 상태에서 이어간다.
- **도구 카탈로그(초기):** `search_docs`, `read_source`(시트·범위·문서 청크), `run_excel_analysis`, `run_daily_cash`, `draft_document`, `export_report`, `update_plan`, `ask_user`, `propose_change`, `request_approval`, `finish`. 처음 세트는 10개 안팎으로 유지한다(겹치는 도구 금지).
- **업무 도구의 계약:** `run_daily_cash`는 기존 `dailyCashTool.execute`를 부르고, `needs_input`이 나오면 그 필드를 `ask_user` 카드로 변환해 사용자에게 보여준다. 루프가 필드 값을 임의로 채울 수 없다(3.1의 원칙 2). `run_excel_analysis`는 기존 엑셀 플래너를 하위 루프로 부르거나, 단계 4b에서 플래너의 inspect/execute를 루프의 도구로 펼친다.
- **계획:** `update_plan` 도구가 `[{step, status}]`를 저장하고 `plan_updated` 이벤트로 UI 계획 패널에 표시한다. 매 turn 시작 시 현재 계획을 컨텍스트 끝에 다시 넣는다(Manus의 todo 재기술).
- **예산:** turn당 모델 호출·도구 호출·실행 시간 상한, 요청당 총 비용 상한. 기존 `policy.ts`의 예산 개념을 재사용한다. 상한에 닿으면 남은 계획을 보여주고 계속할지 묻는다.
- **컨텍스트:** 시스템 프롬프트 → 도구 정의 → skill 목록(이름·설명) → 대화 기록 → 현재 계획 순으로 쌓아 앞부분을 안정시킨다. 큰 도구 결과는 artifact/관찰 ID로 대체하고 요약만 남긴다. 한도에 가까우면 오래된 도구 결과부터 지우고, 그래도 넘으면 요약 compaction을 한다. 실패한 도구 호출과 오류 메시지는 남긴다.
- **모델 설정:** 루프는 `llm.config.yaml`의 `generation.default`를 쓰고, 해석기·분류는 `decision.default`를 쓴다. 실패 시 모델을 자동으로 바꾸지 않는 현재 규칙을 유지한다.

### 3.7 skill과 작업 메모리

- **앱 내장 skill:** `skills/<id>/SKILL.md` 형식으로 업무 지식을 옮긴다. 예: `daily-cash`(일일자금일보 작성 규칙, 이월·환율·정기예금 원칙), `excel-report`(보고서 구성·차트 규칙, 현재 `excel/tool.ts` SYSTEM 프롬프트의 업무 규칙 부분), `company-docs`(공문·기안 양식). 시스템 프롬프트에는 이름·설명만 두고 필요할 때 본문을 읽는다.
- **사용자 skill (후순위):** 사용자가 반복 업무 절차를 텍스트로 저장한다. 실행 코드는 받지 않는다(현재 "user-supplied code/SKILL execution 미구현" 정책 유지). 저장된 절차는 계획의 초안으로만 쓰인다.
- **작업 메모리:** 기존 확인된 memory 기능을 그대로 쓰고, 루프용으로 run별 작업 메모(현재 가정·확인된 기준·남은 질문)를 추가한다. 엑셀 `clarifications`(최대 12개 질문·답 기록)를 이 구조로 일반화한다.

### 3.8 UI 이벤트 확장

기존 8종에 다음을 추가한다(AG-UI 참고, 기존 이벤트는 유지).

| 이벤트 | 용도 |
| --- | --- |
| `tool_started` / `tool_completed` | 어떤 도구를 왜 부르는지와 결과 요약 표시 (현재 `status` 문자열을 구조화) |
| `plan_updated` | 계획 패널 갱신 |
| `interaction_requested` | `ask_user` / `propose_change` / `request_approval`를 하나의 형식으로. 기존 `ask_user` 이벤트는 호환용으로 계속 보냄 |
| `side_answer` | 대기 중 곁답변 스트림 (run 상태 변경 없음) |

---

## 4. 단계별 구현계획

규모는 테스트 포함 1인 기준 대략값이다. S는 1~2일, M은 3~5일, L은 1~2주.

### 단계 1. 대기 중 입력 해석기 (M) — 현재 구조 유지

- **바꾸는 곳**
  - 신규 `electron/agent/interpreter.ts`: 분류 스키마, 프롬프트, Clef 호출, 낮은 확신 처리.
  - `electron/agent/harness.ts` `resume()`: 소유 실행기 `resume` 전에 해석기를 호출. `question`이면 곁답변 실행 후 대기 유지, `new_task`면 선택 카드, `cancel`이면 기존 취소.
  - `electron/business/flow.ts` `resume()`: daily_cash의 "대화 내용을 계산 입력으로 사용하지 않습니다" 분기를 해석 결과에 따라 나눈다(`question`은 곁답변, 금액 관련 `answer/edit`는 단계 2 전까지 현재 문구 유지).
  - `src/app-types/Agent.types.ts`: `side_answer` 이벤트, 해석 결과 칩 타입.
  - 렌더러: 곁답변 말풍선, "질문/답변" 선택 칩. 엑셀 대화형 입력 변경과 같은 컴포넌트를 공유한다.
- **완료 기준:** 대기 중 질문에 카드가 사라지지 않고 답이 온다. 답변은 현재와 같이 반영된다. 오분류 평가 세트(대기 상황 × 문장 200개 이상)에서 `answer`를 `question`으로, `question`을 `answer`로 바꾸는 오류율을 측정해 기준을 정한다.
- **테스트:** `harness.test.ts`(대기 유지·전환·취소), `flow.test.ts`(daily_cash 금액 필드 보호), 해석기 단위 테스트(모델 응답 고정).

### 단계 2. 자연어 금액 수정 diff-확인 (M~L)

- **바꾸는 곳**
  - 신규 `electron/business/dailyCash/edits.ts`: 패치 스키마, "문장에 없는 숫자 금지" 검증, 가상 적용, 기존 검사 미리 실행.
  - `electron/business/flow.ts`: `propose_change` 대기 상태(`run_actions`에 `type: "change_proposal"`), 적용/고쳐서 적용/거절 처리, 적용 시 기존 `submit()` 재사용.
  - `src/app-types/BusinessTool.types.ts`: `ChangeProposal`, `ProposalDecision`.
  - 렌더러: diff 카드(전/후, 합계 영향, 경고). `MovementsEditor`·`CashChangesEditor`의 행 표시 재사용.
  - 값 출처 기록: `business_jobs.payload`에 필드별 `provenance` 추가(DB 스키마 변경 없이 JSON 안에 저장).
- **완료 기준:** "A 거래 금액을 1,200,000원으로", "B 거래를 내일 계획으로 이동", "C 입금 추가" 같은 문장이 diff로 제시되고, 승인 전에는 계산에 반영되지 않는다. 문장에 없는 숫자를 만든 패치는 100% 거부된다.
- **테스트:** 패치 검증 단위 테스트, 승인·거절·수정 후 적용 흐름 테스트, 기존 `dailyCash.test.ts` 회귀.

### 단계 3. 실행기의 도구화와 권한 정책 (M)

- **바꾸는 곳**
  - `electron/agent/toolRegistry.ts`: `effect: "read" | "compute" | "artifact" | "source_write" | "external"`, `needsApproval?(args)`, `deny` 규칙 추가. 지금의 "읽기 전용만 등록" 제약을 "`read`·`compute`·`artifact`는 앱 내장만, `source_write`는 앱 내장 + 승인 필수, `external`은 금지"로 바꾼다.
  - 신규 `electron/agent/loop/permission.ts`: 판단 순서(금지 → 등급 → 인자별 → 사용자)와 run 범위 승인 저장.
  - 신규 `electron/agent/loop/adapters.ts`: `search_docs`(ChatWorkflow의 Tomato/MARU 검색), `run_daily_cash`·`run_excel_analysis`(BusinessFlow 도구), `draft_document`(CanvasFlow) 어댑터. `needs_input` → `ask_user` 변환.
- **완료 기준:** 어댑터를 통해 기존 실행기를 부른 결과가 직접 실행과 동일하다(같은 입력 → 같은 artifact 해시). `source_write` 도구는 승인 없이 실행되지 않는다.

### 단계 4. 에이전트 루프 (L)

- **4a. 루프 골격:** `electron/agent/loop/agentLoop.ts`(turn 구조, 도구 호출, 예산, 상태 저장·재개), `loop/context.ts`(컨텍스트 조립, 오래된 결과 지우기, compaction), `update_plan`·`finish` 도구, `plan_updated`·`tool_*` 이벤트. Harness에 `agent` workflow로 등록하고 `$agent` 모드로만 켠다.
- **4b. 엑셀 플래너 펼치기(선택):** `run_excel_analysis` 하위 루프가 충분히 잘 되면 유지한다. 루프 안에서 다른 도구와 엑셀 열람을 섞어야 할 필요가 확인될 때만 `inspect_workbook`·`execute_analysis`를 루프 도구로 펼친다. 이 판단은 벤치마크로 한다(1.1의 "하나씩 빼서 확인").
- **4c. 라우팅 단순화:** `$agent` 품질이 기준을 넘으면 기본 라우팅을 "chat / agent / 전용 고정 workflow 직접 선택" 3갈래로 줄인다. daily_cash는 사용자가 명시적으로 고를 때 고정 workflow로 바로 실행하는 경로를 계속 둔다.
- **완료 기준:** "자금일보 만들고 그 결과로 주간 추이 그래프도 그려줘", "출장비 규정을 찾아서 이번 달 출장비 엑셀과 비교해줘" 같은 복합 요청이 하나의 run에서 계획 → 도구 호출 → 질문 → 결과로 끝난다. 금액 정확성 관련 기존 테스트는 모두 통과한다.

### 단계 5. skill과 작업 메모리 (M)

- `skills/` 디렉터리와 `electron/agent/loop/skills.ts`(목록 로드, 본문 지연 로드). 엑셀 SYSTEM 프롬프트의 업무 규칙과 daily_cash 운영 원칙을 skill로 옮기고, 프롬프트 길이·정확도 변화를 측정한다.
- run별 작업 메모 구조 추가, 엑셀 `clarifications`를 여기에 연결.
- 사용자 텍스트 skill 저장은 별도 결정 후 진행(보안 검토 포함).

### 단계 6. 평가·관측 (S~M, 각 단계와 병행)

- `ketchupE-bench`에 시나리오 추가: 대기 중 질문/답변 혼동, 자연어 금액 수정, 복합 요청, 승인 거절 후 재계획.
- 지표: 작업 완료율, 사용자 질문 횟수, 해석기 오분류율, diff 거절률, 승인 없이 실행된 `source_write` 수(항상 0이어야 함), 모델이 만든 숫자가 계산에 들어간 수(항상 0이어야 함), turn당 지연·토큰.
- trace 이벤트에 `tool.started/completed`, `interaction.requested/resolved`, `plan.updated`, `permission.decided`를 추가하고 기존 content mode(로컬 전용 구간 제외) 규칙을 그대로 적용한다.

### 권장 순서와 의존 관계

```text
단계 1 ──► 단계 2 ──────────────┐
   │                            ▼
   └──► 단계 3 ──► 단계 4a ──► 4b/4c ──► 단계 5
단계 6은 1부터 병행
```

단계 1·2는 지금 진행 중인 엑셀 대화형 입력 작업이 머지된 뒤 바로 시작할 수 있고, Harness 구조를 바꾸지 않는다. 단계 3부터가 하네스 재구성이다.

---

## 5. 바꾸지 않는 것 (불변 조건)

- 계산에 들어가는 금액은 원천 파일, 결정론 도구 결과, 사용자 확인값 중 하나다. 모델 제안값은 확인 전에는 계산에 들어가지 않는다.
- 원본 파일 갱신은 항상 사용자 승인 후에만 일어나며, 시작 후에는 작업 전환·되돌림을 하지 않는다.
- 사용자 텍스트·파일 내용·도구 결과는 데이터이며 지시가 아니다(현재 라우팅·엑셀 프롬프트 원칙 유지).
- 라우팅·생성 실패 시 모델이나 workflow를 자동으로 바꾸지 않는다.
- 계정별 runtime·DB·출력 폴더 격리, 세션 바인딩 IPC, 렌더러의 파일·DB 직접 접근 금지는 그대로다.
- 로컬 전용 구간은 중앙 telemetry로 나가지 않는다.

## 6. 위험과 열린 질문

| 위험 / 질문 | 대응 |
| --- | --- |
| 해석기 오분류로 질문이 답변으로 들어가 계산이 바뀜 | 금액 필드는 diff 확인을 반드시 거치게 해 피해를 차단. 낮은 확신은 사용자에게 선택하게 함 |
| 단일 루프가 고정 workflow보다 느리고 비쌈 | 명시적 고정 workflow 경로 유지, 루프는 복합·모호 요청에만. 캐시 친화적 컨텍스트 순서로 비용 절감 |
| 사내 모델(LiteLLM 경유)의 도구 호출 품질이 Claude·GPT 수준이 아닐 수 있음 | 단계 4 전에 벤치마크로 모델별 도구 호출 정확도 측정. 부족하면 루프 대신 현재 라우팅 + 단계 1·2만 운영 |
| 도구가 늘어 모델 선택이 흐려짐 | 초기 도구 10개 안팎, 겹치는 도구 금지, 상태별로 가리기 |
| skill 내용이 프롬프트 주입 경로가 됨 | 앱 내장 skill만 우선. 사용자 skill은 텍스트 절차만, 실행 코드·외부 접속 지시 금지 |
| 다중 에이전트 도입 여부 | 당분간 하지 않음. 큰 통합문서 탐색처럼 컨텍스트 격리가 확실히 이득인 읽기 전용 작업에만 검토 |
| 루프 상태가 checkpoint 1MB 한도를 넘음 | 큰 관찰은 artifact/파일로 빼고 참조만 저장(엑셀에서 이미 적용한 방식) |

---

## 7. 출처

- [Codex agent loop] OpenAI, "Unrolling the Codex agent loop", 2026-01-23. https://openai.com/index/unrolling-the-codex-agent-loop
- [Harness 3 patterns] Anthropic (Claude Platform), "Agent Harness Design: 3 Patterns for Harnessing Claude's Intelligence", 2026-04-02. https://claude.com/resources/articles/harnessing-claudes-intelligence
- [Harness design for long-running apps] Anthropic Engineering, "Harness design for long-running apps", 2026-03-24. https://anthropic.com/engineering/harness-design-long-running-apps
- [Effective harnesses for long-running agents] Anthropic Engineering, 2025-11-26. https://anthropic.com/engineering/effective-harnesses-for-long-running-agents
- [Effective context engineering] Anthropic Engineering, "Effective context engineering for AI agents", 2025-09-29. https://anthropic.com/engineering/effective-context-engineering-for-ai-agents
- [Agent Skills] Anthropic Engineering, "Equipping agents for the real world with Agent Skills", 2025-10-16 (2025-12-18 공개 표준 갱신). https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills
- [Claude Agent SDK permissions] Claude Code Docs, "Configure permissions". https://code.claude.com/docs/en/agent-sdk/permissions
- [OpenAI Agents SDK HITL] OpenAI Agents SDK (Python) 문서, "Human in the loop". https://openai.github.io/openai-agents-python/human_in_the_loop
- [LangChain HITL] LangChain 문서, "Human-in-the-loop". https://docs.langchain.com/oss/javascript/langchain/human-in-the-loop
- [Deep Agents harness] LangChain 문서, "Deep Agents harness". https://docs.langchain.com/oss/python/deepagents/harness
- [Manus context engineering] Yichao "Peak" Ji, "Context Engineering for AI Agents: Lessons from Building Manus", 2025-07-18. https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus
- [12-Factor Agents] HumanLayer, "12-Factor Agents". https://github.com/humanlayer/12-factor-agents
- [MCP elicitation] Model Context Protocol 사양 2025-11-25, "Elicitation". https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation
- [AG-UI] AG-UI Protocol. https://github.com/ag-ui-protocol/ag-ui
- [Don't build multi-agents] Walden Yan (Cognition), "Don't Build Multi-Agents", 2025-06-12. https://cognition.com/blog/dont-build-multi-agents
