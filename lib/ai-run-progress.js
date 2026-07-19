/** AI 托管单次运行进度（供前端轮询，避免长时间只显示「生成中」） */

const ACCOUNT_STATUSES = new Set([
  "queued",
  "running",
  "success",
  "failed",
  "skipped",
  "cancelled",
]);

let state = {
  stage: "idle",
  message: "",
  updatedAt: 0,
  startedAt: 0,
  accounts: [],
};
let clearToken = 0;

function summarizeAccounts(accounts = []) {
  const summary = {
    total: accounts.length,
    queued: 0,
    running: 0,
    success: 0,
    failed: 0,
    skipped: 0,
    cancelled: 0,
  };
  for (const item of accounts) {
    const key = ACCOUNT_STATUSES.has(item.status) ? item.status : "queued";
    summary[key] += 1;
  }
  return summary;
}

export function setAiRunProgress(stage, message = "") {
  // 新进度使待清理任务失效，避免上一轮的延时 clear 抹掉本轮状态
  clearToken += 1;
  state = {
    ...state,
    stage: String(stage || "idle"),
    message: String(message || ""),
    updatedAt: Date.now(),
  };
}

/** 开一轮托管时重置账号看板 */
export function beginAiRunAccounts(targets = []) {
  clearToken += 1;
  const now = Date.now();
  state = {
    ...state,
    startedAt: now,
    updatedAt: now,
    accounts: (Array.isArray(targets) ? targets : [])
      .map((item) => {
        const accountId = String(item?.accountId || item?.id || "").trim();
        if (!accountId) return null;
        return {
          accountId,
          name: String(item?.name || item?.accountName || accountId).trim() || accountId,
          status: "queued",
          error: "",
          detail: "",
          updatedAt: now,
        };
      })
      .filter(Boolean),
  };
}

export function setAiAccountProgress(accountId, patch = {}) {
  const id = String(accountId || "").trim();
  if (!id) return;
  const now = Date.now();
  const list = Array.isArray(state.accounts) ? [...state.accounts] : [];
  const index = list.findIndex((item) => item.accountId === id);
  const prev = index >= 0 ? list[index] : null;
  const nextStatus = ACCOUNT_STATUSES.has(patch.status) ? patch.status : prev?.status || "running";
  const next = {
    accountId: id,
    name: String(patch.name || prev?.name || id).trim() || id,
    status: nextStatus,
    error: patch.error != null ? String(patch.error || "").slice(0, 240) : prev?.error || "",
    detail: patch.detail != null ? String(patch.detail || "").slice(0, 120) : prev?.detail || "",
    updatedAt: now,
  };
  if (index >= 0) list[index] = next;
  else list.push(next);
  clearToken += 1;
  state = {
    ...state,
    accounts: list,
    updatedAt: now,
  };
}

export function getAiRunProgress() {
  const accounts = Array.isArray(state.accounts) ? state.accounts.map((item) => ({ ...item })) : [];
  return {
    stage: state.stage,
    message: state.message,
    updatedAt: state.updatedAt,
    startedAt: state.startedAt || 0,
    accounts,
    summary: summarizeAccounts(accounts),
  };
}

export function clearAiRunProgress() {
  state = {
    stage: "idle",
    message: "",
    updatedAt: 0,
    startedAt: 0,
    accounts: [],
  };
}

export function scheduleClearAiRunProgress(delayMs = 8000) {
  const token = ++clearToken;
  setTimeout(() => {
    if (token !== clearToken) return;
    clearAiRunProgress();
  }, delayMs);
}
