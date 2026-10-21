# Electron 데스크톱 앱 가이드

## 📦 개요

이 프로젝트는 웹 브라우저와 Electron 데스크톱 앱 두 가지 방식으로 실행할 수 있습니다.

### 웹 vs Electron 차이점

| 기능               | 웹 브라우저                           | Electron 데스크톱            |
| ------------------ | ------------------------------------- | ---------------------------- |
| 폴더 동기화        | ❌ `webkitdirectory` (비표준, 제한적) | ✅ 네이티브 파일 시스템 접근 |
| 파일 처리          | 메모리에 전체 로드                    | 스트리밍 방식                |
| 동기화된 폴더 저장 | ❌ 불가능                             | ✅ localStorage에 저장       |
| 대용량 폴더        | ❌ 성능 저하                          | ✅ 빠른 처리                 |
| 설치               | 불필요                                | 필요                         |

## 🚀 시작하기

### 1. 의존성 설치 (이미 완료됨)

```bash
npm install
```

다음 패키지들이 이미 설치되어 있습니다:

- `electron` - Electron 런타임
- `electron-builder` - 앱 빌드 및 패키징
- `vite-plugin-electron` - Vite와 Electron 통합

### 2. 개발 모드 실행

```bash
npm run dev:electron
```

이 명령어는:

1. Vite 개발 서버 시작 (http://localhost:5173)
2. Electron 메인 프로세스 빌드
3. Electron 앱 실행
4. 개발자 도구 자동 열기

### 3. 프로덕션 빌드

```bash
npm run build:electron
```

빌드된 앱은 `release/` 폴더에 생성됩니다:

- **Windows**: `.exe` (NSIS 설치 파일), `latest.yml` (자동 업데이트 메타데이터)
- **macOS**: `.dmg`, `.zip` (로컬 개발 테스트용)

> 배포용 산출물은 **Windows `.exe`만** GitHub Release에 올라갑니다 (GitHub Actions).
> 로컬에서 `npm run build:electron`을 실행하면 호스트 OS 타겟으로 빌드됩니다
> (macOS에서는 `.dmg`, Windows에서는 `.exe`).

## 📁 프로젝트 구조

```
KetchupE/
├── electron/
│   ├── main.ts          # Electron 메인 프로세스
│   ├── preload.js       # Preload 스크립트 (IPC 브릿지)
│   └── ipc/             # 폴더 스캔·파일 열기
├── src/
│   ├── electron.d.ts    # Electron API 타입 정의
│   └── Features/TeamDetail/ # 폴더 업로드 UI와 로직
├── dist-electron/       # 빌드된 Electron 코드
├── dist/                # 빌드된 React 앱
└── release/             # 패키징된 앱
```

## 🔧 주요 기능

### 1. 네이티브 폴더 선택

- macOS/Windows 네이티브 폴더 선택 다이얼로그 사용
- 절대 경로로 파일 시스템 직접 접근

### 2. 동기화된 폴더 관리

- 동기화한 폴더 목록 자동 저장
- "재동기화" 버튼으로 빠른 재동기화
- localStorage에 다음 정보 저장:
  - 폴더 절대 경로
  - 폴더 이름
  - 마지막 동기화 시간
  - 파일 개수
  - 선택한 그룹 ID

### 3. 파일 처리

- Node.js `fs` 모듈로 직접 파일 읽기
- 대용량 파일도 메모리 효율적으로 처리
- `.DS_Store`, `node_modules` 등 자동 필터링

## 🐛 디버깅

### 콘솔 로그 확인

**Renderer Process (React)** - 개발자 도구 Console:

```javascript
📁 선택된 폴더 절대 경로: /Users/username/Documents/test
📂 폴더 이름: test
📄 스캔된 파일 수: 25
📖 파일 읽기: /Users/username/Documents/test/file.txt
✅ 파일 읽기 성공: file.txt (1234 bytes)
💾 폴더 동기화 정보 저장: {...}
```

**Main Process (Node.js)** - 터미널:

```
📁 [Main Process] 선택된 폴더: /Users/username/Documents/test
📂 [Main Process] 폴더 스캔 시작: /Users/username/Documents/test
✅ [Main Process] 스캔 완료: 25 개 파일
📖 [Main Process] 파일 읽기 성공: /path/to/file.txt (1234 bytes)
```

### 개발자 도구 열기

- macOS: `Cmd + Option + I`
- Windows/Linux: `Ctrl + Shift + I`
- 메뉴: `View` → `Toggle Developer Tools`

### 앱 재시작

코드 변경 후:

- **Renderer Process (React)**: `Cmd+R` / `Ctrl+R` 새로고침
- **Main Process / Preload**: 앱 완전 종료 후 재시작

## 📱 배포

### 자동 배포 (권장): GitHub Actions + Release (Windows `.exe` 전용)

GitHub Actions에서 생성되는 `.exe`는 로컬 `.env`를 읽지 않습니다.
API 서버 주소는 GitHub 저장소의 **Settings → Secrets and variables → Actions**
에서 Repository variable `VITE_API_URL`로 설정합니다.
이미 secret으로 관리 중인 환경에서는 Repository secret `VITE_API_URL`도 사용할 수 있습니다.

1. `package.json`의 `version`을 올립니다 (예: `2.0.8` → `2.0.9`).
2. 태그를 생성해서 푸시합니다.
   ```bash
   git tag v2.0.9
   git push origin v2.0.9
   ```
3. `.github/workflows/build-windows-exe.yml`이 트리거되어
   - Windows 러너에서 `npx electron-builder --win --publish always` 실행
   - `.exe` 설치 파일과 `latest.yml`을 해당 태그의 GitHub Release에 업로드
4. 기존 설치 사용자는 앱 실행 시점과 실행 중 30분 주기 체크에서
   `electron-updater`가 `latest.yml`을 감지해 자동으로 업데이트를 받습니다.

> 태그 버전(`vX.Y.Z`)은 `package.json`의 `version`과 일치해야 electron-updater가 정상 동작합니다.
> GitHub Actions 산출물은 **Windows `.exe`만** 생성합니다. `.dmg`(macOS)는 생성/업로드되지 않습니다.

### 로컬 빌드

```bash
# macOS에서 실행 → .dmg, .zip
# Windows에서 실행 → .exe
npm run build:electron

# macOS/Linux에서 Windows x64용으로 교차 빌드
# (Windows용 sharp/canvas 바이너리를 먼저 설치)
npm run build:electron:win
```

코드 서명은 선택 사항이며, CI에서 GitHub Secrets `WINDOWS_CERT_BASE64`,
`WINDOWS_CERT_PASSWORD`를 설정하면 자동으로 적용됩니다.

## 🔐 보안

Electron 보안 모범 사례 적용:

- ✅ `contextIsolation: true` - Renderer와 Main 프로세스 격리
- ✅ `nodeIntegration: false` - Renderer에서 Node.js 직접 접근 차단
- ✅ IPC를 통한 안전한 통신
- ✅ Preload 스크립트로 제한된 API만 노출

## 🆚 웹 vs Electron 모드 확인

앱에서 자동으로 감지하여 적절한 UI 표시:

- **일렉트론**: "🚀 일렉트론 모드"
- **웹**: "🌐 웹 브라우저 모드"

코드에서 확인:

```typescript
if (window.electronAPI) {
  // Electron 모드
  const folderPath = await window.electronAPI.openDirectory();
} else {
  // 웹 브라우저 모드
  fileInputRef.current?.click();
}
```

## 📝 스크립트 요약

| 명령어                   | 설명                       |
| ------------------------ | -------------------------- |
| `npm run dev`            | 웹 개발 서버만 실행        |
| `npm run dev:electron`   | Electron 개발 모드 실행    |
| `npm run build`          | 웹용 프로덕션 빌드         |
| `npm run build:electron` | Electron 앱 빌드 및 패키징 |
| `npm run build:electron:win` | Windows x64 앱 교차 빌드 |

## ❓ 문제 해결

### Preload 스크립트 에러

```
Unable to load preload script: Cannot use import statement outside a module
```

→ `electron/preload.js`가 CommonJS 형식인지 확인

### 경로 오류

```
Unable to load preload script: /wrong/path/preload.js
```

→ `electron/main.ts`에서 `app.getAppPath()` 사용 확인

### 파일 읽기 실패

→ 파일 경로가 절대 경로인지 확인
→ 파일 권한 확인 (특히 macOS)

## 📚 참고 자료

- [Electron 공식 문서](https://www.electronjs.org/docs)
- [Electron Security](https://www.electronjs.org/docs/latest/tutorial/security)
- [electron-builder](https://www.electron.build/)
- [vite-plugin-electron](https://github.com/electron-vite/vite-plugin-electron)
