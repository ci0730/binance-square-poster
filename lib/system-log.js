import fs from "fs";
import path from "path";
import { getConfigDir } from "./app-paths.js";

const MAX_LOGS = 500;
const SAVE_DEBOUNCE_MS = 400;

/** @type {Array<{id:number,time:number,type:string,source:string,message:string}>} */
let logs = [];
let seq = 1;
let loaded = false;
let saveTimer = null;

function logFilePath() {
  return path.join(getConfigDir(), "system-logs.json");
}

function normalizeEntry(raw, fallbackId) {
  if (!raw || typeof raw !== "object") return null;
  const id = Math.max(1, parseInt(raw.id, 10) || fallbackId || 1);
  const time = Math.max(0, Number(raw.time) || Date.now());
  const type = ["ok", "err", "error", "warn", "info"].includes(raw.type)
    ? raw.type === "error"
      ? "err"
      : raw.type
    : "info";
  const source = String(raw.source || "system").trim() || "system";
  const message = String(raw.message || "").trim() || "（空日志）";
  return { id, time, type, source, message };
}

function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  try {
    const file = logFilePath();
    if (!fs.existsSync(file)) return;
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const list = Array.isArray(raw?.logs) ? raw.logs : Array.isArray(raw) ? raw : [];
    const normalized = list
      .map((item, index) => normalizeEntry(item, index + 1))
      .filter(Boolean)
      .sort((a, b) => a.id - b.id)
      .slice(-MAX_LOGS);
    logs = normalized;
    seq = logs.reduce((max, item) => Math.max(max, item.id), 0) + 1;
  } catch {
    logs = [];
    seq = 1;
  }
}

function persistNow() {
  ensureLoaded();
  try {
    const file = logFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    const payload = {
      version: 1,
      updatedAt: Date.now(),
      nextId: seq,
      logs,
    };
    fs.writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    // 落盘失败不阻断主流程
  }
}

function persistSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persistNow();
  }, SAVE_DEBOUNCE_MS);
}

export function appendSystemLog(message, { type = "info", source = "system" } = {}) {
  ensureLoaded();
  const entry = {
    id: seq++,
    time: Date.now(),
    type: type === "error" ? "err" : type,
    source: String(source || "system").trim() || "system",
    message: String(message || "").trim() || "（空日志）",
  };
  logs.push(entry);
  if (logs.length > MAX_LOGS) logs = logs.slice(-MAX_LOGS);
  persistSoon();
  return entry;
}

export function listSystemLogs({ sinceId = 0, limit = 100 } = {}) {
  ensureLoaded();
  const id = Number(sinceId) || 0;
  const max = Math.min(Math.max(parseInt(limit, 10) || 100, 1), MAX_LOGS);
  return logs.filter((item) => item.id > id).slice(-max);
}

export function getSystemLogFileInfo() {
  ensureLoaded();
  const file = logFilePath();
  let bytes = 0;
  try {
    if (fs.existsSync(file)) bytes = fs.statSync(file).size || 0;
  } catch {
    bytes = 0;
  }
  return {
    file,
    bytes,
    count: logs.length,
  };
}

export function clearSystemLogs() {
  ensureLoaded();
  logs = [];
  seq = 1;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    const file = logFilePath();
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {
    persistNow();
  }
  return true;
}
