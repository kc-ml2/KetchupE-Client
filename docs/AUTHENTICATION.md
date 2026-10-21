# 이메일 로그인과 사용자별 서비스 키

앱은 `https://ketchupe.ml2-alpha.com/server`의 credential broker(OpenAPI 0.1.0)를 사용한다. 회사·그룹 권한은 서버가 결정한다. 클라이언트는 이메일 도메인으로 권한을 추정하지 않는다.

## 인증 흐름

1. `POST /v1/auth/email/request` → **202**, `challenge_id`, `expires_at`.
2. `POST /v1/auth/email/verify` → **202**, `access_token`, `expires_at`. 코드는 앞자리 0을 유지하는 6자리 문자열이다.
3. 임시 토큰으로 `GET /v1/keys/status`. `pending`이면 약 5초 후 다시 확인한다. 자동 대기는 최대 2분이며 이후 사용자 재확인이 필요하다. `action_required` 또는 서비스의 `needs_attention`이면 자동 조회를 멈춘다.
4. 전체 상태가 `ready`일 때 `GET /v1/keys`. LiteLLM·MARU 주소와 키를 함께 검증하고 저장한다.

모든 경로는 `/server` 아래로 호출한다. 응답의 `status_url`로 다른 호스트를 호출하지 않는다. 코드·임시 토큰은 각 응답의 만료 시각을 사용한다. 임시 토큰이 만료되면 이메일 인증을 다시 요청한다. 네트워크·HTTP 오류에는 무한 자동 재시도를 하지 않는다.

`mock`은 명세상 기본값이 `true`다. 명시적인 `mock: false`만 실제 로그인으로 활성화한다. 서비스 주소는 HTTPS의 `https://ketchupe.ml2-alpha.com/gateway`와 `/maru/mcp`만 허용한다. LiteLLM 클라이언트는 `/gateway/v1/` 아래로 모델 요청을 보낸다.

## 비밀 저장과 복원

- 인증코드·임시 토큰은 메인 메모리에서만 사용한다. renderer에는 상태와 이메일, 비밀이 아닌 세션 식별자만 제공한다.
- 활성 계정의 이메일과 두 서비스 자격증명은 `userData/login.enc`에 safeStorage로 암호화하여 원자적으로 교체한다. OS 암호화가 없거나 Linux `basic_text` 백엔드이면 평문 저장으로 대체하지 않는다.
- 앱 종료는 저장된 로그인을 유지한다. 재실행은 저장된 서비스 키를 복원한다. 임시 broker 토큰과 서비스 키의 수명은 별개다.
- 로그아웃은 자격증명을 제거하고 실행·폴링·MCP·워커를 정리한다. 계정별 대화·자료는 삭제하지 않는다. 서버의 키 폐기나 회전은 수행하지 않는다.
- 검증 오류의 `input`이나 HTTP 응답 본문을 로그로 출력하지 않는다. 키가 포함될 수 있는 모델 오류 본문도 출력하지 않는다.

## SQLite와 계정 경계

```text
userData/
  login.enc
  accounts/<SHA-256 account id>/
    agent.sqlite
    tomato/
    mcp-cache/maru/
    business-output/
```

계정 식별자는 인증에 성공한 요청 이메일을 사용하며, 도메인만 소문자로 정규화한다. broker가 정규 사용자 ID를 제공하지 않으므로 로컬 부분의 대소문자·별칭이 다르면 별도 프로필이 생길 수 있다. 해시는 저장소 구분용이며 익명성이나 서버 권한을 증명하지 않는다.

기존 루트의 `agent.sqlite`, Tomato 인덱스, MARU 캐시는 읽거나 이동하지 않는다. 소유자 확인 없는 자동 이전은 하지 않는다. 로그인 전에는 데이터 IPC를 등록하지 않는다. 각 로그인은 새 세션 ID를 가지며, 이전 계정의 IPC 요청·응답·이벤트는 거부된다. 로그아웃은 요청 종료와 인덱스 워커의 실제 종료를 기다린 뒤 DB를 닫는다. native 파일 선택창이 열려 있으면 이를 닫아야 로그아웃 정리가 끝날 수 있다.

앱 데이터 폴더와 이를 포함하는 상위 폴더는 검색·업무 자료로 등록할 수 없다. 앱 계정 분리는 동일 OS 계정으로 직접 파일을 읽을 수 있는 사람에 대한 파일 암호화 경계는 아니다. SQLite와 사용자 문서 자체를 암호화하는 변경은 포함하지 않는다.

## MARU와 로그

기존 `browse_storage`·`find_storage` MCP를 재사용한다. `matches[].text`는 원본 참조와 함께 RAG 인용 근거로 사용한다. 추가 문맥이나 원문 열기가 필요하면 정확한 `storage_id`·`file_path`를 다시 조회하고 다운로드한다. 서버의 파일 경로를 로컬 경로처럼 열지 않는다.

대화별 MARU 참조는 `maru_documents`에 보관한다. 해당 대화의 조회·새 요청·재개 시 원격 접근 권한을 확인하고, 실패 시 저장된 근거로 계속 진행하지 않는다. 원문 인용을 열 때도 권한을 재확인한다. MARU 인덱스는 일반 로컬 컬렉션에서 제외한다. 원문 접근을 확인할 수 없는 네트워크 장애도 접근 허용으로 처리하지 않는다.

이미 표시된 답변, 사람이 복사한 메모리, 내보낸 파일은 자동으로 지우지 않는다. 서비스의 권한 철회가 이미 표시된 화면에 실시간 반영되는 것은 아니다. broker 명세에는 그룹 권한·문서 보존 정책이 없으므로 실제 운영 정책은 서버와 맞춰야 한다.

앱 telemetry는 이메일에서 파생된 계정 식별자를 사용하고 계정별 outbox를 유지한다. 서비스 키를 로그 식별자로 쓰지 않는다. broker에는 계열사 ID가 없으므로 이메일 도메인으로 중앙 tenant를 임의 설정하지 않는다. 정규 사용자 ID·tenant 제공 시 마이그레이션이 필요하다.

## 배포와 확인

CI와 Vite에서 공통 `LITELLM_API_KEY`를 주입하지 않는다. 앱은 `.env`의 LiteLLM·MARU 키를 읽어 로그인 대신 사용하지 않는다. 독립 smoke/probe 스크립트는 기존 환경변수 방식을 유지한다. Trolley와 telemetry 설정은 이 키 발급 API의 대상이 아니다.

로컬 검증: Node 22.5 이상에서 `npm test -- --run`, `npm run typecheck:electron`, `npm run build`.

운영 서버에서 확인할 항목:

- 실제 이메일 코드 발송·오입력·만료·요청 제한의 오류 형식(명세에는 422만 정의됨).
- 기존 사용자 재로그인의 동일 키 반환, 실제 `mock: false` 응답.
- `/gateway/v1/models`, 생성 모델, `/gateway/v1/systemone`의 사용자별 권한·로그.
- MARU bearer 인증, 검색 응답, 다운로드 origin, 서로 다른 그룹과 권한 철회 후 재검증.
- macOS·Windows OS 암호화 저장과 새 설치본 로그인 복원.

키 회전 API와 UI는 이번 범위에서 제외한다. 로그인 실패를 키 자동 회전으로 복구하지 않는다.
