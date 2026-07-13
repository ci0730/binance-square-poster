const { app, BrowserWindow, dialog, shell, Menu } = require("electron");
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const fs = require("fs");

const PORT = process.env.PORT || 3456;
const APP_URL = `http://127.0.0.1:${PORT}`;

let mainWindow = null;
let serverProcess = null;

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

function buildRuntimeEnv() {
  const env = {
    ...process.env,
    PORT: String(PORT),
    ELECTRON_RUN_AS_NODE: "1",
  };
  const dataDir = getInstallDataDir();
  if (dataDir) {
    migrateInstallDataIfNeeded(dataDir);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(path.join(dataDir, "uploads"), { recursive: true });
    env.BINANCE_SQUARE_DATA_DIR = dataDir;
    env.PLAYWRIGHT_BROWSERS_PATH = path.join(dataDir, "ms-playwright");
  }
  return env;
}

function getAppRoot() {
  if (!app.isPackaged) return path.join(__dirname, "..");
  let root = app.getAppPath();
  if (root.includes("app.asar")) {
    const unpacked = root.replace(/app\.asar(?!\.)/, "app.asar.unpacked");
    const fs = require("fs");
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

async function ensureServer() {
  if (await isServerRunning()) return;
  const root = getAppRoot();
  const serverPath = path.join(root, "server.js");

  const dataDir = getInstallDataDir();
  let logPath = null;
  let logFd = null;
  if (app.isPackaged && dataDir) {
    logPath = path.join(dataDir, "server.log");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.appendFileSync(logPath, `\n--- ${new Date().toISOString()} server start ---\n`);
    logFd = fs.openSync(logPath, "a");
  }

  serverProcess = spawn(process.execPath, [serverPath], {
    cwd: root,
    env: buildRuntimeEnv(),
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
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 920,
    minWidth: 1024,
    minHeight: 680,
    title: "币安广场批量发帖",
    autoHideMenuBar: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadURL(APP_URL);

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

function buildMenu() {
  const template = [
    {
      label: "文件",
      submenu: [
        {
          label: "刷新页面",
          accelerator: "CmdOrCtrl+R",
          click: () => mainWindow?.reload(),
        },
        { type: "separator" },
        {
          label: "退出",
          accelerator: "CmdOrCtrl+Q",
          click: () => app.quit(),
        },
      ],
    },
    {
      label: "视图",
      submenu: [
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "帮助",
      submenu: [
        {
          label: "打开开发者工具",
          accelerator: "F12",
          click: () => mainWindow?.webContents.openDevTools({ mode: "detach" }),
        },
        {
          label: "关于",
          click: () => {
            const dataDir = getInstallDataDir() || "用户目录 ~/.config/binance-square";
            dialog.showMessageBox(mainWindow, {
              type: "info",
              title: "关于",
              message: "币安广场批量发帖",
              detail: `基于官方 OpenAPI 的本地桌面工具\n\n配置与缓存目录：\n${dataDir}`,
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.on("ready", async () => {
    buildMenu();
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
