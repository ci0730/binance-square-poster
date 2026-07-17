const { app, BrowserWindow, dialog, shell, Menu, ipcMain } = require("electron");
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { initAutoUpdater } = require("./updater.cjs");

const PORT = process.env.PORT || 3456;
const APP_URL = `http://127.0.0.1:${PORT}`;

let mainWindow = null;
let serverProcess = null;
let creatingMainWindow = false;

function getLegacyInstallDataDir() {
  if (!app.isPackaged) return null;
  return path.join(path.dirname(process.execPath), "data");
}

function getInstallDataDir() {
  if (!app.isPackaged) return null;
  // 安装到 Program Files 时，安装目录不可写，数据改存用户 AppData
  return app.getPath("userData");
}

function migrateInstallDataIfNeeded(targetDir) {
  const legacyDir = getLegacyInstallDataDir();
  if (!legacyDir || legacyDir === targetDir || !fs.existsSync(legacyDir)) return;

  const marker = path.join(targetDir, ".migrated-from-install-dir");
  // 首次仍尽量把安装目录整份拷过去；之后由服务端 config-migrate 做智能合并
  if (fs.existsSync(marker)) return;

  try {
    fs.mkdirSync(targetDir, { recursive: true });
    for (const name of fs.readdirSync(legacyDir)) {
      if (name.startsWith(".")) continue;
      const src = path.join(legacyDir, name);
      const dest = path.join(targetDir, name);
      if (!fs.existsSync(dest)) fs.cpSync(src, dest, { recursive: true });
    }
    fs.writeFileSync(marker, `migratedAt=${new Date().toISOString()}\nfrom=${legacyDir}\n`);
  } catch {
    // 旧目录可能同样不可写，忽略迁移错误
  }
}

function getBootstrapDir() {
  if (app.isPackaged) return app.getPath("userData");
  return path.join(app.getPath("home"), ".config", "binance-square-app");
}

function readCustomDataDirPointer() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(getBootstrapDir(), "data-dir.json"), "utf8"));
    const customDir = String(raw?.customDir || "").trim();
    return customDir ? path.resolve(customDir) : null;
  } catch {
    return null;
  }
}

function getDefaultDataDir() {
  if (app.isPackaged) return app.getPath("userData");
  return path.join(app.getPath("home"), ".config", "binance-square");
}

function resolveStartupDataDir() {
  const custom = readCustomDataDirPointer();
  if (custom) return custom;
  if (app.isPackaged) return app.getPath("userData");
  return "";
}

function buildRuntimeEnv() {
  const legacyInstallDir = getLegacyInstallDataDir();
  const legacyHomeDir = path.join(app.getPath("home"), ".config", "binance-square");
  const legacyDirs = [legacyInstallDir, legacyHomeDir].filter(Boolean);
  const env = {
    ...process.env,
    PORT: String(PORT),
    ELECTRON_RUN_AS_NODE: "1",
    BINANCE_SQUARE_DESKTOP: "1",
    BINANCE_SQUARE_BOOTSTRAP_DIR: getBootstrapDir(),
    BINANCE_SQUARE_DEFAULT_DATA_DIR: getDefaultDataDir(),
    BINANCE_SQUARE_LEGACY_DATA_DIRS: legacyDirs.join(path.delimiter),
  };
  if (legacyInstallDir) env.BINANCE_SQUARE_INSTALL_DATA_DIR = legacyInstallDir;
  const dataDir = resolveStartupDataDir();
  if (dataDir) {
    migrateInstallDataIfNeeded(dataDir);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(path.join(dataDir, "uploads"), { recursive: true });
    env.BINANCE_SQUARE_DATA_DIR = dataDir;
  }
  // 优先使用安装包内置的 Chromium，对方无需再装 Node / Playwright
  const bundledBrowsers = path.join(process.resourcesPath, "ms-playwright");
  if (app.isPackaged && fs.existsSync(bundledBrowsers)) {
    env.PLAYWRIGHT_BROWSERS_PATH = bundledBrowsers;
  } else if (dataDir) {
    env.PLAYWRIGHT_BROWSERS_PATH = path.join(dataDir, "ms-playwright");
  }
  return env;
}

function getAppRoot() {
  if (!app.isPackaged) return path.join(__dirname, "..");
  let root = app.getAppPath();
  if (root.includes("app.asar")) {
    const unpacked = root.replace(/app\.asar(?!\.)/, "app.asar.unpacked");
    if (fs.existsSync(path.join(unpacked, "server.js"))) return unpacked;
  }
  return root;
}

function waitForServer(timeoutMs = 45000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const probe = () => {
      const req = http.get(`${APP_URL}/api/config`, (res) => {
        res.resume();
        if (res.statusCode === 200) resolve();
        else schedule();
      });
      req.on("error", schedule);
      req.setTimeout(2000, () => {
        req.destroy();
        schedule();
      });
    };
    const schedule = () => {
      if (Date.now() - started > timeoutMs) {
        reject(new Error("本地服务启动超时，请检查端口是否被占用"));
        return;
      }
      setTimeout(probe, 400);
    };
    probe();
  });
}

function fetchJson(url, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          resolve({
            status: res.statusCode,
            data: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"),
          });
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

function isServerRunning() {
  return new Promise((resolve) => {
    const req = http.get(`${APP_URL}/api/config`, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function isDesktopOwnedServer() {
  try {
    const { status, data } = await fetchJson(`${APP_URL}/api/config`);
    return status === 200 && data?.desktopOwned === true;
  } catch {
    return false;
  }
}

function freeListeningPort(port) {
  if (process.platform !== "win32") return;
  try {
    const { execSync } = require("child_process");
    const out = execSync(`netstat -ano -p tcp`, { encoding: "utf8", windowsHide: true });
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      if (!line.includes(`:${port}`) || !/LISTENING/i.test(line)) continue;
      const parts = line.trim().split(/\s+/);
      const pid = Number(parts[parts.length - 1]);
      if (pid > 0) pids.add(pid);
    }
    for (const pid of pids) {
      try {
        execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore", windowsHide: true });
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
}

async function ensureServer() {
  // 若 3456 已被外部 node（例如 Cursor/终端里另起的旧 server.js）占用，
  // 桌面端会误以为服务已就绪，导致界面改了代码却一直连着旧进程。
  if (await isServerRunning()) {
    if (serverProcess || (await isDesktopOwnedServer())) return;
    freeListeningPort(PORT);
    await new Promise((r) => setTimeout(r, 400));
  }

  const root = getAppRoot();
  const serverPath = path.join(root, "server.js");

  const dataDir = resolveStartupDataDir() || getDefaultDataDir();
  let logPath = null;
  let logFd = null;
  if (dataDir) {
    logPath = path.join(dataDir, "server.log");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.appendFileSync(logPath, `\n--- ${new Date().toISOString()} server start ---\n`);
    logFd = fs.openSync(logPath, "a");
  }

  const env = buildRuntimeEnv();
  env.BINANCE_SQUARE_SERVER_BOOT_AT = String(Date.now());

  serverProcess = spawn(process.execPath, [serverPath], {
    cwd: root,
    env,
    stdio: logFd != null ? ["ignore", logFd, logFd] : "inherit",
    windowsHide: true,
  });

  serverProcess.on("error", (err) => {
    dialog.showErrorBox("启动失败", `无法启动后台服务：${err.message}`);
    app.quit();
  });

  serverProcess.on("exit", (code, signal) => {
    serverProcess = null;
    if (!app.isQuitting && code && code !== 0) {
      const logHint = logPath ? `\n\n详细日志：\n${logPath}` : "";
      dialog.showErrorBox(
        "服务已停止",
        `后台服务异常退出（code=${code}, signal=${signal || "none"}）${logHint}`
      );
      app.quit();
    }
  });

  await waitForServer();
}

function stopServer() {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill("SIGTERM");
    serverProcess = null;
  }
}

function createWindow() {
  creatingMainWindow = true;
  try {
    mainWindow = new BrowserWindow({
      width: 1360,
      height: 920,
      minWidth: 1024,
      minHeight: 680,
      title: "币安广场批量发帖",
      autoHideMenuBar: true,
      show: false,
      backgroundColor: "#0b1220",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: path.join(__dirname, "preload.cjs"),
        // 禁止页面自行弹出窗体
        nativeWindowOpen: false,
      },
    });
  } finally {
    creatingMainWindow = false;
  }

  mainWindow.once("ready-to-show", () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
  });

  mainWindow.loadURL(APP_URL);

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // 禁用 F12 / 开发者工具，避免弹出空白白窗
  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const key = String(input.key || "").toLowerCase();
    if (key === "f12" || (input.control && input.shift && (key === "i" || key === "j"))) {
      event.preventDefault();
      return;
    }
    if (input.control && key === "r") {
      mainWindow.reload();
      event.preventDefault();
    } else if (input.control && key === "q") {
      app.quit();
      event.preventDefault();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url).catch(() => {});
    }
    return { action: "deny" };
  });

  mainWindow.webContents.on("devtools-opened", () => {
    try {
      mainWindow.webContents.closeDevTools();
    } catch {
      // ignore
    }
  });
}

function denyUnexpectedWindows() {
  app.on("web-contents-created", (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) {
        shell.openExternal(url).catch(() => {});
      }
      return { action: "deny" };
    });
    contents.on("did-create-window", (child) => {
      try {
        child.destroy();
      } catch {
        // ignore
      }
    });
  });

  // 除主窗外的任何 BrowserWindow 一律销毁（防止白屏弹窗）
  app.on("browser-window-created", (_event, win) => {
    win.webContents.on("devtools-opened", () => {
      try {
        win.webContents.closeDevTools();
      } catch {
        // ignore
      }
    });
    if (creatingMainWindow) return;
    const check = () => {
      if (!mainWindow || win === mainWindow || win.isDestroyed()) return;
      try {
        win.destroy();
      } catch {
        // ignore
      }
    };
    win.once("ready-to-show", check);
    setTimeout(check, 0);
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  denyUnexpectedWindows();

  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.on("ready", async () => {
    // 隐藏「文件 / 视图 / 帮助」菜单栏
    Menu.setApplicationMenu(null);

    ipcMain.handle("pick-directory", async () => {
      const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : BrowserWindow.getFocusedWindow();
      const result = await dialog.showOpenDialog(win || undefined, {
        title: "选择数据保存目录",
        properties: ["openDirectory", "createDirectory"],
      });
      if (result.canceled || !result.filePaths?.length) return null;
      return result.filePaths[0];
    });

    ipcMain.handle("restart-app", () => {
      app.relaunch();
      app.exit(0);
    });

    initAutoUpdater(() => mainWindow);

    try {
      await ensureServer();
      createWindow();
    } catch (err) {
      dialog.showErrorBox("启动失败", err.message);
      app.quit();
    }
  });

  app.on("before-quit", () => {
    app.isQuitting = true;
    stopServer();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
