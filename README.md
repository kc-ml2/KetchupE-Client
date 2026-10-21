# KetchupE v3.0

로컬 문서 검색, 근거 기반 답변, 문서 초안 작성과 Excel 업무를 하나의 대화에서 실행하는 Electron 데스크톱 앱입니다. **워크플로가 업무의 진행·입력 대기·재개·종료를 관리하고, 도구가 검색·조회·계산 같은 실제 작업을 수행합니다.**

이 문서는 현재 코드 기준의 입구입니다(2026-10-16). v3.0은 아키텍처 명칭이며 `package.json`의 배포 버전과는 별개입니다.

## 할 수 있는 일

| 워크플로 ID / 저장 kind | 기능 | 실행기 |
| --- | --- | --- |
| `chat` / `agent` | 로컬 문서·연결된 MCP를 조회하고 근거를 붙여 답변 | `Harness` |
| `doc` / `canvas` | 참고 문서 검색 → 초안 → 검토·수정 → 확정 | `CanvasFlow` |
| `work_sources` / 동일 | 로컬 XLSX 자료 연결, 열 매핑과 추출 검증 | `WorkSourcesFlow` |
| `daily_cash` / 동일 | 원천 확인·대사 후 일일자금일보 XLSX와 PNG 생성 | `BusinessFlow` + `dailyCashTool` |
| `bank_daily` / 동일 | 계좌별 거래내역으로 입출금표 생성; 테스트용 | `BusinessFlow` + `bankDailyTool` |

자연어 요청은 등록된 기능의 설명·예시·필수 입력을 보고 라우팅합니다. `$doc`, `$daily_cash`, `$work_sources`로 명시 선택할 수도 있습니다. 업무 탭에는 주요 기능의 바로가기를 둡니다. **계약서 작성은 “어떤 계약서 작성을 도와드릴까요?”라는 질문부터 시작하며, 사용자의 요청을 받은 뒤 실행합니다.**

입력창 위에서 실행·입력 대기 상태를 확인하고 이어가거나 중단할 수 있습니다. 일일자금일보는 대화 안의 입력 카드에서 원천 파일·기준 정보를 확인하고 필요한 추가 질문에 답합니다. 계산은 코드가 담당하며, 검증을 통과한 결과만 전달합니다. 세부 업무 규칙과 남은 확인 사항은 [일일자금일보 문서](docs/BUSINESS_TOOLS.md#daily-cash)를 보세요. `bank_daily`는 업무 흐름 확인용이며 제품 배포 전 registry에서 제외해야 합니다.

## 구조

```text
React 화면 → typed preload IPC → Electron main / WorkflowDispatcher
                                  ├─ chat → Harness → Tomato / MARU / Trolley / LiteLLM
                                  ├─ doc → CanvasFlow → Tomato / LiteLLM
                                  ├─ work_sources → 자료 연결·매핑 / workbook worker
                                  └─ 업무 Tool → BusinessFlow → business worker

제품 상태·실행 이력 → 로컬 SQLite
운영 관측 → telemetry outbox → 서비스 소유 OTLP gateway → Langfuse
```

- **Tomato**: 폴더를 parse/chunk/index하고 FTS5·vector 검색을 제공합니다. vector 검색은 collection별 in-process HNSW(ANN) 인덱스를 쓰고, 긴 chunk는 512토큰 모델 한도에 맞춰 window로 나눠 임베딩한 뒤 하나의 벡터로 합칩니다. embedding 준비 전에는 keyword 검색을 사용합니다. 로컬 폴더, rclone 동기화 폴더, Notion export를 같은 collection으로 취급합니다.
- **Harness**: policy가 제안한 `SEARCH / ASK / VERIFY / ANSWER / STOP`을 검증하고 예산·근거·실행 이력을 관리합니다. policy가 직접 도구를 실행하지 않습니다.
- **Canvas**: 참고 양식 선택과 문서 편집을 별도 상태로 관리합니다. 문서 버전은 전체 스냅샷으로 저장하고 undo/redo를 지원합니다.
- **BusinessFlow**: 입력 카드, 원천 해시·Tool 버전 고정, 추가 질문과 checkpoint, worker 실행, XLSX 검증·결과 저장을 공통 처리합니다.
- **LiteLLM**: 지정한 모델 서버와 통신합니다. 앱의 상태·DB·업무 계산을 소유하지 않습니다.

`Workspace → Thread → Run → Message / Step` 단위로 관리합니다. 한 대화에는 `running` 또는 `waiting_user` 실행이 최대 하나입니다. 입력 대기 뒤에는 같은 run을 재개하고, 종료 뒤 새 요청은 새 run입니다. 재시작 시 대기 작업은 복원하며 실행 중이던 작업은 취소 처리합니다. 범용 자동 재실행이나 exactly-once 처리를 보장하지 않습니다.

## 개발 실행

Node.js **22.5 이상**이 필요합니다(`node:sqlite` 사용). React 19, TypeScript, Vite 6, Electron 39를 사용합니다. 정확한 의존성 버전은 [package.json](package.json)과 lockfile을 기준으로 합니다.

```bash
npm install
npm run dev                  # Vite + Electron
npm run build                # TypeScript 검사 + 번들
npm run build:electron       # 설치본 패키징
npx vitest run               # 테스트 1회 실행
npm run typecheck:electron
```

Git에서 제외된 로컬 `.env`에 연결 정보를 설정합니다. API key/token은 저장소에 넣지 않습니다. 모델 설정은 환경변수·공식 빌드 값이 우선하고 저장 설정이 fallback이며, 앱에서 저장한 모델 키는 `safeStorage`로 암호화합니다.

```dotenv
LITELLM_BASE_URL=https://your-gateway.example.com/v1/
LITELLM_API_KEY=<발급받은 키>
LITELLM_MODEL_ALIAS=<배포한 생성 모델 alias>
LITELLM_ROUTER_MODEL_ALIAS=clef

# 선택: 토큰에는 Bearer 접두어를 넣지 않습니다.
MARU_API_TOKEN=<사용자 토큰>
MARU_MCP_ENDPOINT=https://maru.ml2-alpha.com/mcp
TROLLEY_API_KEY=<사용자 키>
TROLLEY_MCP_ENDPOINT=https://trolley.ml2-alpha.com/mcp/
```

```bash
npm run smoke:litellm
npm run probe:maru
npm run probe:trolley
```

자연어 업무 선택은 같은 LiteLLM의 `/v1/systemone`에 등록된 `clef` alias를 사용합니다. 다른 이름으로 배포했다면 `LITELLM_ROUTER_MODEL_ALIAS`를 지정하세요. `$업무ID`와 명시 mode는 라우팅 모델을 호출하지 않습니다. 생성·답변 모델은 `LITELLM_MODEL_ALIAS`를 유지합니다. 라우팅 실패 시 다른 모델로 자동 전환하지 않습니다. 설정 변경 후 개발 서버를 재시작하고 배포판은 다시 빌드합니다.

MCP 키 변경 후 앱을 재시작합니다. 현재 MARU는 storage 조회·검색 및 문서 다운로드/인덱싱, Trolley는 capabilities·Operation 목록 조회까지 연결되어 있습니다. Trolley Operation 실행은 연결되어 있지 않습니다. 새 MCP의 연결 절차는 [외부 팀용 가이드](docs/WORKFLOW_INTEGRATION_GUIDE.md)를 따릅니다.

## 코드 찾기

| 변경하려는 것 | 시작점 |
| --- | --- |
| 업무 라우팅·등록 | [router.ts](electron/agent/router.ts), [workflows.ts](electron/agent/workflows.ts), [runtime.ts](electron/agent/runtime.ts) |
| RAG 판단·실행·근거 | [policy.ts](electron/agent/policy.ts), [harness.ts](electron/agent/harness.ts), [tools.ts](electron/agent/tools.ts) |
| MCP 연결·서버별 변환 | [mcp.ts](electron/agent/mcp.ts), [maru.ts](electron/agent/maru.ts), [trolley.ts](electron/agent/trolley.ts) |
| 문서 작성·편집 | [canvas/flow.ts](electron/agent/canvas/flow.ts) |
| Excel 업무 추가 | [business/contracts.ts](electron/business/contracts.ts), [business/registry.ts](electron/business/registry.ts), [business/flow.ts](electron/business/flow.ts) |
| 검색·원천 파일 처리 | [tomato/](electron/tomato/), [work/](electron/work/), [workers/](electron/workers/) |
| 대화·업무 상태·입력 카드 | [AgentPage.tsx](src/Pages/AgentPage.tsx), [Agent components](src/Features/Agent/components/), [Agent hooks](src/Features/Agent/hooks/) |
| DB·IPC·관측 | [db/](electron/db/), [ipc/](electron/ipc/), [telemetry.ts](electron/agent/telemetry.ts) |

## 데이터와 운영 경계

- `agent.sqlite`는 대화·run·memory·trace·업무 입력의 원본입니다. Tomato는 별도 index/artifact를 관리합니다. Renderer는 파일·DB·키에 직접 접근하지 않고 typed IPC를 사용합니다.
- 로컬 저장이 완전한 오프라인을 뜻하지 않습니다. 선택한 근거·대화는 LiteLLM으로, 관측 데이터는 설정된 content mode에 따라 OTLP gateway로 전달됩니다. embedding 모델 최초 다운로드도 네트워크가 필요합니다.
- 업무 원천 XLSX는 로컬에서 읽고 원본을 수정하지 않습니다. 검증한 결과는 `userData/business-output`에 새 파일로 저장합니다. 원천 사본 보관과 대화 삭제 시 결과 파일 자동 정리는 현재 보장하지 않습니다.
- 검색 collection 선택은 ACL이 아닙니다. MARU는 서버 권한을 검사하지만 로컬 history·재개·citation 재사용 전체의 권한 회수는 아직 완성되지 않았습니다.
- 중앙 수집은 [telemetry-gateway.ts](scripts/telemetry-gateway.ts)를 사용합니다. Desktop에는 Langfuse secret을 넣지 않습니다. 기본 `ops` mode는 자유 텍스트·식별자를 HMAC 처리하며, 모든 개인정보 제거를 보장하지 않습니다.
- 임의 MCP 자동 설치, 외부 코드/SKILL 실행, multi-agent, 전역 실행 queue는 없습니다. 설치본 서명·fresh-install 검증과 외부 benchmark의 평가·승격은 별도 범위입니다.

## Documentation

| Purpose | Guide |
| --- | --- |
| Architecture, lifecycle, code map, limitations | [Architecture and code map](docs/KETCHUPE_V3_ARCHITECTURE.md) |
| Add a workflow or connect an external MCP provider | [Integration guide](docs/WORKFLOW_INTEGRATION_GUIDE.md) |
| Excel execution contract and Daily Cash rules | [Business tools and Daily Cash](docs/BUSINESS_TOOLS.md) |

## License

MIT
