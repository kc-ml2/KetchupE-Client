# CAPER ERP 연결 확인

`erp_cash_status_kc`는 회사/회계단위 1000의 예금 계좌를 조회한다. 이 스크립트는 독립 연결 점검이다. 2026-11-03 일보의 ERP REST 연동 구현·검증은 [연동 보고서](CAPER_ERP_INTEGRATION.md)를 참고한다.

1. 프로젝트 루트의 `.env.caper.local`에 `CAPER_API_KEY=<발급받은 key>`를 저장한다. `Bearer`는 제외한다. 파일은 Git에서 제외된다. 키 만료 안내: 2027-01-27 14:46.
2. `npm run probe:caper -- 20261027 20261027`을 실행한다. 필요한 기간에만 수동 실행한다.
3. REST와 MCP의 성공 여부를 각각 확인한다. 연결 실패는 키 인증 실패와 다르다. 시간 초과로 HTTP 응답이 없으면 인증·도구 실행 여부를 확인할 수 없다.

일보 기준 영업일 D의 조회 기간은 D부터 다음 영업일 전날까지다. 예를 들어 2026-10-30 금요일은 `20261030 20261101`로 조회한다. 스크립트는 지정한 기간 그대로 호출하며 휴일 계산은 하지 않는다.

| 방식 | 호출 |
| --- | --- |
| REST 목록 | `GET https://caper.kct.co.kr/api/agent-tools` |
| REST 조회 | `POST https://caper.kct.co.kr/api/agent-tools/erp_cash_status_kc`, JSON `{"from_dt":"20261027","to_dt":"20261027"}` |
| MCP | `https://caper.kct.co.kr/api/mcp/mcp`, Streamable HTTP. 기존 앱의 `McpConnection`으로 `initialize` → `tools/list` → `tools/call` |

모두 `Authorization: Bearer <key>`로 인증한다. REST POST의 Content-Type은 `application/json`이다. MCP SDK는 `Content-Type: application/json`, `Accept: application/json, text/event-stream`과 SSE 응답을 처리한다. 정보팀 안내의 직접 JSON-RPC 호출은 initialize 생략도 지원한다:

```json
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"erp_cash_status_kc","arguments":{"from_dt":"20261027","to_dt":"20261027"}}}
```

스크립트는 REST 행 수·컬럼명과 MCP 응답 형식·텍스트 길이만 출력한다. 키, 계좌번호, 금액, 응답 원문을 출력하거나 파일로 저장하지 않는다. REST의 `success`, `rowCount`, `truncated: false`를 검증하며 MCP의 `isError`를 확인한다. MCP 텍스트의 수치나 REST와의 데이터 일치 여부는 검증하지 않는다. `npm run probe:caper -- --self-test`는 네트워크 없이 날짜·응답 검증과 값 비출력을 점검한다.

향후 일보 연동은 JSON인 REST가 적합하다. 기존 일보는 **계좌잔고(은행잔액)**를 사용하므로 `AM_FINAL`(장부잔액)로 단순 교체하면 안 된다. `BLNC_AMT`의 외화 단위, 계좌코드, 상품 분류, 가입일·만기일 컬럼의 실제 매핑을 확인해야 한다. 잘린 결과는 합계·집계에 사용하지 않는다.

## 2026-11-02 확인 결과

최초 개발 Mac에서 로컬 키를 읽어 REST 목록 GET과 initialize 없는 MCP `tools/list` POST를 각각 보냈다. 두 요청 모두 약 10초 후 `UND_ERR_CONNECT_TIMEOUT`으로 실패했고 HTTP 응답을 받지 못했다. 별도 curl 요청도 8초 연결 시간 초과였다. 이 시점에는 키 유효성, 도구 목록, 실제 ERP 조회를 확인하지 못했다. 프록시 설정은 변경하지 않았다.

추가한 `probe:caper` 실행도 REST와 기존 앱 MCP 클라이언트 모두 같은 연결 시간 초과로 종료했다. 목록/연결 단계에서 실패했으므로 데이터 조회 POST와 `tools/call`까지 진행하지 않았다.

오프라인 self-test는 통과했다. 전체 Electron 타입 검사는 기존 `electron/business/contracts.ts`의 미사용 `BusinessInput` import 오류(TS6196)로 실패했다.

같은 날 사용자가 LTE로 전환한 뒤 `npm run probe:caper -- 20261027 20261027`을 재실행해 **REST와 MCP 모두 성공**했다.

- REST 목록과 조회 모두 HTTP 200. 조회 결과는 49행, `truncated: false`이며 `success: true`와 행 수 일치 검증을 통과했다.
- 기존 앱 MCP 클라이언트의 initialize, `tools/list`, `erp_cash_status_kc`의 `tools/call`이 성공했다. `isError: false`, text 응답 31,695자였다.
- 응답 컬럼에 `FINPRODUCT_CD`, `BLNC_AMT`, `AM_FINAL`, `AM_FINAL2`, `EXCH_CD`, `JOIN_DT`, `END_DT`가 포함됐다. 실제 값은 출력하거나 저장하지 않았다.

이로써 현재 LTE 연결에서 키 인증과 실제 조회, 기존 MCP 클라이언트 호환성을 확인했다. 이전 연결 실패의 정확한 네트워크 원인, REST/MCP의 수치 일치, 일보 컬럼 매핑과 계산 정확성은 별도 검증 대상이다.
