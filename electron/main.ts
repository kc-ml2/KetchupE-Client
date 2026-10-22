// Loads optional model aliases and service settings; LiteLLM/MARU credentials come from login.
// Vite's own env loading only
// exposes VITE_-prefixed vars to the renderer bundle, it never touches process.env for the main process.
import "dotenv/config";
import {
  app,
  ipcMain,
  type IpcMainInvokeEvent,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  dialog,
  type MessageBoxOptions,
} from "electron";
import { randomUUID } from "node:crypto";
import { AuthSession } from "./auth/session.ts";
import { CredentialBroker } from "./auth/broker.ts";
import { CredentialStore, accountDirectory } from "./auth/storage.ts";
import { SessionScope } from "./ipc/sessionScope.ts";
import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import electronUpdater from "electron-updater";
const { autoUpdater } = electronUpdater;
import { registerAgentHandlers } from "./ipc/agentHandlers.ts";
import { registerCollectionHandlers } from "./ipc/collectionHandlers.ts";
import { registerWorkSourceHandlers } from "./ipc/workSourceHandlers.ts";
import { startAgentRuntime, type AgentRuntime } from "./agent/runtime.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isDev = process.env.NODE_ENV === "development";
const PRODUCT_NAME = "케찹이";
const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;

app.setName(PRODUCT_NAME);

let mainWindow: BrowserWindow | null = null;
let agentRuntime: AgentRuntime | null = null;
let stoppingRuntime: Promise<void> | undefined;
let scope: SessionScope | null = null;
let auth: AuthSession | null = null;
let tray: Tray | null = null;
let appIconPath: string | undefined;
let isQuitting = false;
let hasShownUpdateDialog = false;
let updateCheckInterval: ReturnType<typeof setInterval> | undefined;
let isCheckingForUpdate = false;
let isDownloadingUpdate = false;
let hasDownloadedUpdate = false;

const getIconFileNames = () =>
  process.platform === "win32" ? ["icon.ico", "icon.png"] : ["icon.png"];

const resolveIconPath = (): string | undefined => {
  const iconRoots = [
    process.resourcesPath,
    path.join(app.getAppPath(), "electron", "assets"),
    path.join(process.cwd(), "electron", "assets"),
    path.join(__dirname, "assets"),
  ];

  for (const root of iconRoots) {
    for (const fileName of getIconFileNames()) {
      const candidate = path.join(root, fileName);
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  return undefined;
};

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    return;
  }

  const preloadPath = path.join(
    app.getAppPath(),
    "dist-electron",
    "preload.js",
  );

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    icon: appIconPath,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  if (isDev) {
    mainWindow.loadURL("http://localhost:5173");
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }

  // 앱이 웹 URL(/chatbot 등)로 이동하려 할 때 Electron이 그 경로를
  // 로컬 파일(file:///C:/chatbot)로 해석해 JS/CSS 로드를 깨뜨리는 것을 방지.
  // 프로덕션에서는 index.html + HashRouter(#/chatbot)만 허용한다.
  const indexFileUrl = pathToFileURL(
    path.join(__dirname, "../dist/index.html"),
  );

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (isDev) return;
    try {
      const target = new URL(url);
      const isSameDoc =
        target.protocol === "file:" &&
        target.pathname === indexFileUrl.pathname;
      if (!isSameDoc) {
        event.preventDefault();
        console.warn("[navigation] blocked unexpected navigation to", url);
      }
    } catch (error) {
      event.preventDefault();
      console.warn("[navigation] blocked invalid url:", url, error);
    }
  });

  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function createTray() {
  const trayIcon = appIconPath
    ? nativeImage
        .createFromPath(appIconPath)
        .resize({ width: 18, height: 18, quality: "best" })
    : nativeImage.createEmpty();

  if (process.platform === "darwin") {
    trayIcon.setTemplateImage(true);
  }

  tray = new Tray(trayIcon);
  tray.setToolTip(PRODUCT_NAME);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "열기",
      click: () => {
        if (mainWindow) {
          mainWindow.show();
        } else {
          createWindow();
        }
      },
    },
    {
      label: "종료",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  if (process.platform !== "darwin") {
    tray.on("click", () => {
      if (mainWindow) {
        if (mainWindow.isVisible()) {
          mainWindow.hide();
        } else {
          mainWindow.show();
        }
      } else {
        createWindow();
      }
    });
  }
}

function setupAutoUpdater() {
  if (isDev) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => {
    console.log("[autoUpdater] checking for updates...");
  });

  autoUpdater.on("update-available", (info) => {
    isDownloadingUpdate = true;
    console.log("[autoUpdater] update available:", info.version);
  });

  autoUpdater.on("update-not-available", () => {
    isDownloadingUpdate = false;
    console.log("[autoUpdater] no updates found.");
  });

  autoUpdater.on("error", (error) => {
    isDownloadingUpdate = false;
    console.error("[autoUpdater] failed:", error);
  });

  autoUpdater.on("update-downloaded", async (info) => {
    isDownloadingUpdate = false;
    hasDownloadedUpdate = true;
    console.log("[autoUpdater] update downloaded:", info.version);
    if (hasShownUpdateDialog) return;
    hasShownUpdateDialog = true;

    const targetWindow =
      mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    const dialogOptions: MessageBoxOptions = {
      type: "info",
      buttons: ["지금 재시작", "나중에"],
      defaultId: 0,
      cancelId: 1,
      title: "업데이트 준비 완료",
      message: "새 버전이 다운로드되었습니다.",
      detail: "지금 재시작하면 최신 버전으로 업데이트됩니다.",
    };
    const { response } = targetWindow
      ? await dialog.showMessageBox(targetWindow, dialogOptions)
      : await dialog.showMessageBox(dialogOptions);

    hasShownUpdateDialog = false;

    if (response === 0) {
      isQuitting = true;
      autoUpdater.quitAndInstall();
    }
  });

  checkForUpdates("startup");
  startPeriodicUpdateChecks();
}

function checkForUpdates(reason: "startup" | "scheduled") {
  if (isCheckingForUpdate || isDownloadingUpdate || hasDownloadedUpdate) {
    console.log(`[autoUpdater] skipped ${reason} update check.`);
    return;
  }

  isCheckingForUpdate = true;
  autoUpdater
    .checkForUpdatesAndNotify()
    .catch((error) => {
      console.error(`[autoUpdater] ${reason} check failed:`, error);
    })
    .finally(() => {
      isCheckingForUpdate = false;
    });
}

function startPeriodicUpdateChecks() {
  stopPeriodicUpdateChecks();
  updateCheckInterval = setInterval(() => {
    checkForUpdates("scheduled");
  }, UPDATE_CHECK_INTERVAL_MS);
}

function stopPeriodicUpdateChecks() {
  if (!updateCheckInterval) return;
  clearInterval(updateCheckInterval);
  updateCheckInterval = undefined;
}

// One process per userData: two instances would share login.enc, SQLite and the Tomato index files.
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.exit(0);
app.on("second-instance", () => { if (app.isReady()) createWindow(); });

app.whenReady().then(() => {
  if (!primaryInstance) return;
  appIconPath = resolveIconPath();
  if (process.platform === "darwin" && appIconPath) {
    app.dock?.setIcon(appIconPath);
  }

  setupAuth();
  createWindow();
  createTray();
  void auth?.restore();
  setupAutoUpdater();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else if (mainWindow) {
      mainWindow.show();
    }
  });
});

const broadcast = (channel: string, payload?: unknown) => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
  }
};

function trustedSender(event: IpcMainInvokeEvent): boolean {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== event.sender.mainFrame) return false;
  const url = event.senderFrame?.url ?? "";
  try {
    const parsed = new URL(url);
    return isDev ? parsed.origin === "http://localhost:5173" : parsed.protocol === "file:" && parsed.pathname === new URL(pathToFileURL(path.join(__dirname, "../dist/index.html")).href).pathname;
  } catch { return false; }
}

function stopLocalAgent(): Promise<void> {
  if (stoppingRuntime) return stoppingRuntime;
  const runtime = agentRuntime;
  const previousScope = scope;
  previousScope?.block();
  runtime?.quiesce();
  stoppingRuntime = (async () => {
    await previousScope?.close();
    await runtime?.stop();
    agentRuntime = null;
    scope = null;
    stoppingRuntime = undefined;
  })();
  return stoppingRuntime;
}

function setupAuth() {
  const root = app.getPath("userData");
  auth = new AuthSession(new CredentialBroker(), new CredentialStore(root), {
    activate: async (account) => {
      if (agentRuntime || scope) throw new Error("Previous account is still active");
      const sessionId = randomUUID();
      const currentScope = new SessionScope(sessionId, trustedSender);
      scope = currentScope;
      agentRuntime = startAgentRuntime({
        account,
        privateRoot: root,
        userData: accountDirectory(root, account.email),
        workerPath: path.join(__dirname, "tomato.worker.js"),
        appVersion: app.getVersion(),
        modelSelectable: isDev,
        emitAgentEvent: (event) => {
          if (auth?.getState().sessionId === sessionId) broadcast("agent:event", { sessionId, event });
        },
        emitCollectionsChanged: () => {
          if (auth?.getState().sessionId === sessionId) broadcast("collection:changed", { sessionId });
        },
      });
      registerAgentHandlers(agentRuntime, currentScope.handle, currentScope.assertActive);
      registerCollectionHandlers(agentRuntime, currentScope.handle, currentScope.assertActive);
      registerWorkSourceHandlers(agentRuntime, path.join(__dirname, "workbook.worker.js"), currentScope.handle, currentScope.assertActive);
      return sessionId;
    },
    deactivate: stopLocalAgent,
  }, (state) => {
    if (state.phase === "signing_out") scope?.block();
    broadcast("auth:changed", state);
  });
  const handle = (channel: string, listener: (...args: unknown[]) => unknown) => {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (!trustedSender(event)) throw new Error("허용되지 않은 요청입니다.");
      return listener(...args);
    });
  };
  handle("auth:getState", () => auth!.getState());
  handle("auth:requestCode", (email) => auth!.requestCode(typeof email === "string" ? email : ""));
  handle("auth:verifyCode", (code) => auth!.verifyCode(typeof code === "string" ? code : ""));
  handle("auth:retry", () => auth!.retry());
  handle("auth:logout", () => auth!.logout());
}

app.on("window-all-closed", () => {
  // Keep running in tray
});

let shutdownStarted = false;
app.on("before-quit", (event) => {
  isQuitting = true;
  stopPeriodicUpdateChecks();
  event.preventDefault();
  if (shutdownStarted) return;
  shutdownStarted = true;
  // App exit preserves the encrypted login; explicit logout removes it.
  scope?.block();
  // An open native dialog can block the drain; never let it keep the app from quitting.
  // SQLite and the telemetry outbox are durable across an abrupt exit.
  void Promise.race([auth ? auth.shutdown() : stopLocalAgent(), new Promise((resolve) => setTimeout(resolve, 10_000))])
    .finally(() => app.exit());
});
