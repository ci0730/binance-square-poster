const MAX_LOGS = 300;

/** @type {Array<{id:number,time:number,type:string,source:string,message:string}>} */
let logs = [];
let seq = 1;

export function appendSystemLog(message, { type = "info", source = "system" } = {}) {
  const entry = {
    id: seq++,
    time: Date.now(),
    type,
    source,
    message: String(message || "").trim() || "（空日志）",
  };
  logs.push(entry);
  if (logs.length > MAX_LOGS) logs = logs.slice(-MAX_LOGS);
  return entry;
}

export function listSystemLogs({ sinceId = 0, limit = 100 } = {}) {
  const id = Number(sinceId) || 0;
  const max = Math.min(Math.max(parseInt(limit, 10) || 100, 1), MAX_LOGS);
  return logs.filter((item) => item.id > id).slice(-max);
}

export function clearSystemLogs() {
  logs = [];
  return true;
}
