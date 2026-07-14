const { app } = require("electron");
const { autoUpdater } = require("electron-updater");
const fs = require("fs");
const path = require("path");

const CHECK_DELAY_MS = 4000;
const DEFAULT_RELEASE_NOTES = "修复部分BUG";

let mainWindowGetter = () => null;
let pendingUpdateInfo = null;

function stripHtml(text) {
  return String(text || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function formatReleaseNotes(raw) {
  const text =
    typeof raw === "string"
      ? stripHtml(raw)
      : Array.isArray(raw)
        ? raw.map((item) => stripHtml(item?.note || item)).filter(Boolean).join("\n")
        : "";
  return text || DEFAULT_RELEASE_NOTES;
}

function sanitizeInfo(info = {}) {
  return {
    version: info.version || "",
    releaseDate: info.releaseDate || "",
    releaseName: info.releaseName || "",
    releaseNotes: DEFAULT_RELEASE_NOTES,
  };
}

function sendStatus(payload) {
  const win = mainWindowGetter();
  if (win && !win.isDestroyed()) {
    win.webContents.send("app-update-status", payload);
  }
}

function readOptionalUpdateToken() {
  const candidates = [
    path.join(process.resourcesPath || "", "update-token.txt"),
    path.join(app.getPath("userData"), "update-token.txt"),
  ];
  for (const file of candidates) {
    try {
      const token = String(fs.readFileSync(file, "utf8") || "").trim();
      if (token) return token;
    } catch {
      // ignore
    }
  }
  return String(process.env.UPDATE_GH_TOKEN || process.env.GH_TOKEN || "").trim();
}

function configureAutoUpdater() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowDowngrade = false;

  const token = readOptionalUpdateToken();
  if (token) {
    autoUpdater.requestHeaders = { Authorization: `token ${token}` };
  }

  autoUpdater.on("checking-for-update", () => {
    sendStatus({ phase: "checking" });
  });

  autoUpdater.on("update-available", (info) => {
    pendingUpdateInfo = sanitizeInfo(info);
    sendStatus({ phase: "available", info: pendingUpdateInfo });
  });

  autoUpdater.on("update-not-available", (info) => {
    pendingUpdateInfo = null;
    sendStatus({ phase: "not-available", info: sanitizeInfo(info) });
  });

  autoUpdater.on("error", (err) => {
    sendStatus({
      phase: "error",
      message: err?.message || String(err || "检查更新失败"),
    });
  });

  autoUpdater.on("download-progress", (progress) => {
    sendStatus({
      phase: "progress",
      percent: progress.percent,
      transferred: progress.transferred,
      total: progress.total,
      bytesPerSecond: progress.bytesPerSecond,
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    pendingUpdateInfo = sanitizeInfo(info);
    sendStatus({ phase: "downloaded", info: pendingUpdateInfo });
  });
}

function scheduleStartupCheck() {
  if (!app.isPackaged) return;
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      sendStatus({
        phase: "error",
        message: err?.message || String(err || "检查更新失败"),
      });
    });
  }, CHECK_DELAY_MS);
}

function registerUpdateIpc(ipcMain) {
  ipcMain.handle("update-get-version", () => ({
    version: app.getVersion(),
    isPackaged: app.isPackaged,
  }));

  ipcMain.handle("update-check", async () => {
    if (!app.isPackaged) {
      return { ok: false, reason: "dev" };
    }
    const result = await autoUpdater.checkForUpdates();
    return {
      ok: true,
      updateInfo: result?.updateInfo ? sanitizeInfo(result.updateInfo) : null,
    };
  });

  ipcMain.handle("update-download", async () => {
    if (!app.isPackaged) return { ok: false, reason: "dev" };
    await autoUpdater.downloadUpdate();
    return { ok: true };
  });

  ipcMain.handle("update-install", () => {
    if (!app.isPackaged) return { ok: false, reason: "dev" };
    autoUpdater.quitAndInstall(false, true);
    return { ok: true };
  });
}

function initAutoUpdater(getMainWindow) {
  mainWindowGetter = getMainWindow;
  registerUpdateIpc(require("electron").ipcMain);
  if (!app.isPackaged) return;
  configureAutoUpdater();
  scheduleStartupCheck();
}

module.exports = {
  initAutoUpdater,
  sanitizeInfo,
};
