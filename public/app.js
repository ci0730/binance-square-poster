/** @type {Array<DraftPost>} */
let posts = [];
let apiConfigured = false;
let publishing = false;
let currentImages = [];
let currentFilter = "draft";
let activeView = "home";
let autoRefreshTimer = null;
let alerts = [];
/** @type {{defaultAccountId:string|null, accounts:Array<{id:string,name:string,maskedKey:string,hasApiKey:boolean,hasCookie:boolean,isDefault:boolean,username?:string,createdAt?:number,proxyLabel?:string}>}} */
let accountStore = { defaultAccountId: null, accounts: [] };
const ACCOUNT_PAGE_SIZE = 10;
/** @type {{query:string, dateFrom:string, dateTo:string, page:number}} */
let accountListState = { query: "", dateFrom: "", dateTo: "", page: 1 };
let publishedPostsCache = { accountId: null, posts: [] };
let selectedHistoryAccountId = null;
/** 互动页筛选账号；空字符串表示全部账号 */
let selectedMonitorAccountId = "";
/** 互动页搜索关键词 */
let monitorSearchQuery = "";

const NO_HISTORY_DETECTED_MSG = "未检测到该账号的历史帖子，请先发布一条后再试";
const HISTORY_FETCH_CONFIRM_MSG =
  "拉取广场历史帖子需要先成功发布至少 1 条帖子，系统才能识别账号并获取历史记录；否则无法拉取。\n\n若尚未发帖，请先发布一条后再来拉取。\n也可在「账号管理」中配置 Cookie 或填写广场用户名，无需发帖即可拉取。\n\n确定继续拉取吗？";

const PROXY_SYSTEM_NOTIFIED_KEY = "binance-square-proxy-system-notified";
const THEME_STORAGE_KEY = "binance-square-theme";
const STORAGE_KEY = "binance-square-poster-drafts";

const APP_MODAL_IDS = [
  "postModal",
  "importModal",
  "accountModal",
  "tokenModal",
  "publishedPostsModal",
  "proxySetupModal",
  "legalModal",
  "aiProfileModal",
  "updateModal",
];

const SKIPPED_UPDATE_VERSION_KEY = "binance-square-skipped-update-version";
let desktopUpdateState = {
  currentVersion: "",
  availableVersion: "",
};
let manualUpdateCheckPending = false;

function getAppModal(id) {
  return typeof id === "string" ? document.getElementById(id) : id;
}

function closeAppModals(exceptId = null) {
  for (const id of APP_MODAL_IDS) {
    if (exceptId && id === exceptId) continue;
    getAppModal(id)?.close();
  }
}

function openAppModal(id) {
  const el = getAppModal(id);
  if (!el) return null;
  closeAppModals();
  if (!el.open) el.showModal();
  return el;
}

function bindAppModalDismiss() {
  for (const id of APP_MODAL_IDS) {
    const el = getAppModal(id);
    if (!el || el.dataset.dismissBound) continue;
    el.dataset.dismissBound = "1";
    el.addEventListener("click", (e) => {
      if (e.target === el) el.close();
    });
  }
}

const DEFAULT_AVAILABLE_TOKENS = [
  "BTC", "ETH", "BNB", "SOL", "XRP", "DOGE", "ADA", "AVAX", "LINK",
  "DOT", "NEAR", "APT", "TON", "TRX", "SHIB", "MATIC", "LTC", "UNI", "FIL", "BCH",
];

const DEFAULT_SENTIMENT_OPTIONS = [
  { id: "auto", label: "自动（跟随行情）" },
  { id: "bullish", label: "看多" },
  { id: "bearish", label: "看空" },
];

const DEFAULT_CONTENT_STYLE_OPTIONS = [
  { id: "casual", label: "口语化分享", hint: "真人口吻、自然聊天感，适合日常互动" },
  { id: "market", label: "行情短评", hint: "数据简洁、带关键价位，适合冲高流量" },
  { id: "news", label: "热点快讯", hint: "快讯体、核心看点，蹭官方与热点流量" },
  { id: "tutorial", label: "教学干货", hint: "分步骤教学，高留存、高转化" },
];

const LEGAL_CONTENT = {
  disclaimer: {
    title: "免责声明",
    html: `
      <p>本软件「币安广场批量发帖工具」仅供学习、研究与合法内容发布使用。使用本软件即表示您已阅读并同意以下条款。</p>
      <h3>1. 非官方产品</h3>
      <p>本软件为第三方工具，与币安（Binance）官方无隶属、合作或授权关系。币安、Binance Square 及相关标识归其权利人所有。</p>
      <h3>2. 使用风险自负</h3>
      <p>您应自行确保发布内容符合币安广场社区规范及当地法律法规。因账号封禁、内容下架、API 限流、网络故障、代理失效、第三方服务中断等导致的损失，由使用者自行承担。</p>
      <h3>3. 内容与投资建议</h3>
      <p>软件内 AI 生成内容仅供参考，不构成任何投资建议、财务建议或交易建议。加密货币投资具有高风险，请独立判断并自行研究（DYOR）。</p>
      <h3>4. 数据与隐私</h3>
      <p>API Key、Cookie、配置与缓存数据默认保存在本机。请妥善保管密钥，勿向他人泄露。开发者不对因密钥泄露造成的损失负责。</p>
      <h3>5. 软件按现状提供</h3>
      <p>本软件按「现状」提供，不提供任何明示或暗示的保证。开发者不对使用本软件产生的直接或间接损害承担责任。</p>
    `,
  },
  license: {
    title: "许可协议",
    html: `
      <p>感谢您使用「币安广场批量发帖工具」。在使用、复制或分发本软件前，请仔细阅读本许可协议。</p>
      <h3>1. 授权范围</h3>
      <p>在您遵守本协议的前提下，授予您在本机安装、运行本软件的非独占、不可转让、免费使用许可，仅供个人或内部业务场景下的合法内容发布与管理。</p>
      <h3>2. 使用限制</h3>
      <ul>
        <li>不得将本软件用于 spam、虚假宣传、操纵市场、违法违规内容发布或其他滥用行为；</li>
        <li>不得对本软件进行逆向工程、破解授权、移除版权声明或恶意传播修改版；</li>
        <li>不得将本软件用于侵犯他人知识产权、隐私权或其他合法权益的行为；</li>
        <li>应遵守币安平台规则、智谱 AI 等第三方服务条款及适用法律法规。</li>
      </ul>
      <h3>3. 知识产权</h3>
      <p>本软件界面、代码与文档的知识产权归开发者所有。第三方组件（如 Electron、Playwright 等）遵循其各自开源许可。</p>
      <h3>4. 设备绑定</h3>
      <p>本软件可在本机记录设备标识用于授权管理。您可通过「解绑设备」解除当前设备绑定，以便在其他电脑重新使用。</p>
      <h3>5. 协议变更与终止</h3>
      <p>开发者保留更新本协议的权利。若您不同意更新后的条款，应停止使用本软件。违反本协议时，开发者有权终止您的使用许可。</p>
    `,
  },
};
const MONITOR_SETTINGS_KEY = "binance-square-poster-monitor";
const ALERTS_KEY = "binance-square-poster-alerts";
const MAX_ALERTS = 50;

/** @typedef {{id:string,text:string,title:string,imagePaths:string[],selected:boolean,publishState:'draft'|'published'|'failed'|'publishing',result?:object,error?:string,publishedAt?:number,createdAt:number,accountId?:string|null,accountName?:string,stats?:object,statsLoading?:boolean,statsError?:string,commentsExpanded?:boolean,commentsLoading?:boolean,commentsError?:string,commentsList?:object[],commentsHint?:string}} DraftPost */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function getTheme() {
  return localStorage.getItem(THEME_STORAGE_KEY) === "light" ? "light" : "dark";
}

const THEME_TOGGLE_ICONS = {
  dark: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>`,
  light: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21 14.5A7.5 7.5 0 0 1 9.5 3 6.5 6.5 0 1 0 21 14.5Z"/></svg>`,
};

function applyTheme(theme = getTheme()) {
  document.documentElement.setAttribute("data-theme", theme);
  const icon = $("#themeToggleIcon");
  const label = $("#themeToggleLabel");
  if (icon) icon.innerHTML = theme === "dark" ? THEME_TOGGLE_ICONS.dark : THEME_TOGGLE_ICONS.light;
  if (label) label.textContent = theme === "dark" ? "白天模式" : "黑夜模式";
}

function toggleTheme() {
  const next = getTheme() === "dark" ? "light" : "dark";
  localStorage.setItem(THEME_STORAGE_KEY, next);
  applyTheme(next);
}

function showLegalModal(type) {
  const content = LEGAL_CONTENT[type];
  if (!content) return;
  const modal = $("#legalModal");
  const title = $("#legalModalTitle");
  const body = $("#legalModalBody");
  if (!modal || !title || !body) return;
  title.textContent = content.title;
  body.innerHTML = content.html;
  openAppModal("legalModal");
}

async function unbindCurrentDevice() {
  let device = {};
  try {
    const res = await fetch("/api/device");
    device = await res.json();
  } catch {
    alert("无法连接本地服务，请确认软件已启动。");
    return;
  }

  const confirmed = confirm(
    `确认解绑本设备吗？\n\n当前设备 ID：${device.maskedDeviceId || "未知"}\n机器标识：${device.maskedMachineId || "未知"}\n\n解绑后可在其他电脑安装使用。本机配置与缓存数据不会自动删除。`,
  );
  if (!confirmed) return;

  try {
    const res = await fetch("/api/device/unbind", { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "解绑失败");
    alert(data.message || "设备已解绑");
  } catch (err) {
    alert(err.message || "解绑失败，请稍后重试");
  }
}

function generateId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeStoredPost(p) {
  const publishState =
    p.publishState ||
    (p.status === "success" ? "published" : p.status === "error" ? "failed" : p.status === "publishing" ? "publishing" : "draft");

  return {
    id: p.id || generateId(),
    text: p.text || "",
    title: p.title || "",
    imagePaths: Array.isArray(p.imagePaths) ? p.imagePaths : [],
    selected: publishState === "published" ? Boolean(p.selected) : p.selected !== false,
    publishState,
    result: p.result || null,
    error: p.error || null,
    publishedAt: p.publishedAt || null,
    createdAt: p.createdAt || Date.now(),
    accountId: p.accountId || null,
    accountName: p.accountName || null,
    stats: p.stats || null,
    commentsExpanded: Boolean(p.commentsExpanded),
    commentsList: Array.isArray(p.commentsList) ? p.commentsList : null,
    commentsHint: p.commentsHint || null,
  };
}

function loadDrafts() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data.map(normalizeStoredPost) : [];
  } catch {
    return [];
  }
}

function saveDrafts() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(posts));
}

function defaultMonitorSettings() {
  return {
    autoRefreshEnabled: false,
    autoRefreshMinutes: 5,
    viewAlertThreshold: 10,
    notifyBrowser: true,
    monitorAccountId: "",
    monitorSearchQuery: "",
  };
}

function loadMonitorSettings() {
  try {
    const raw = localStorage.getItem(MONITOR_SETTINGS_KEY);
    return raw ? { ...defaultMonitorSettings(), ...JSON.parse(raw) } : defaultMonitorSettings();
  } catch {
    return defaultMonitorSettings();
  }
}

function saveMonitorSettings(settings) {
  localStorage.setItem(MONITOR_SETTINGS_KEY, JSON.stringify(settings));
}

function loadAlerts() {
  try {
    const raw = localStorage.getItem(ALERTS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveAlerts() {
  localStorage.setItem(ALERTS_KEY, JSON.stringify(alerts.slice(0, MAX_ALERTS)));
}

function applyMonitorSettingsToUI(settings) {
  $("#autoRefreshEnabled").checked = settings.autoRefreshEnabled;
  $("#autoRefreshMinutes").value = settings.autoRefreshMinutes;
  $("#viewAlertThreshold").value = settings.viewAlertThreshold;
  $("#notifyBrowser").checked = settings.notifyBrowser;
  selectedMonitorAccountId = settings.monitorAccountId || "";
  monitorSearchQuery = settings.monitorSearchQuery || "";
  if ($("#monitorSearchInput")) $("#monitorSearchInput").value = monitorSearchQuery;
  renderMonitorAccountSelect();
  updateMonitorSectionHint();
  updateAutoRefreshStatus();
}

function readMonitorSettingsFromUI() {
  return {
    autoRefreshEnabled: $("#autoRefreshEnabled").checked,
    autoRefreshMinutes: Math.max(1, parseInt($("#autoRefreshMinutes").value, 10) || 5),
    viewAlertThreshold: Math.max(1, parseInt($("#viewAlertThreshold").value, 10) || 10),
    notifyBrowser: $("#notifyBrowser").checked,
    monitorAccountId: getSelectedMonitorAccountId(),
    monitorSearchQuery: getMonitorSearchQuery(),
  };
}

function updateAutoRefreshStatus() {
  const settings = loadMonitorSettings();
  const el = $("#autoRefreshStatus");
  if (settings.autoRefreshEnabled) {
    el.textContent = `定时刷新已开启，每 ${settings.autoRefreshMinutes} 分钟`;
    el.className = "monitor-status active";
  } else {
    el.textContent = "定时刷新未开启";
    el.className = "monitor-status";
  }
}

function stopAutoRefresh() {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
}

function startAutoRefresh() {
  stopAutoRefresh();
  const settings = loadMonitorSettings();
  if (!settings.autoRefreshEnabled) return;
  const ms = settings.autoRefreshMinutes * 60 * 1000;
  autoRefreshTimer = setInterval(() => {
    if (!publishing) refreshAllStats({ silent: true });
  }, ms);
}

function setupAutoRefresh() {
  const settings = readMonitorSettingsFromUI();
  saveMonitorSettings(settings);
  updateAutoRefreshStatus();
  if (settings.autoRefreshEnabled) {
    if (settings.notifyBrowser && Notification.permission === "default") {
      Notification.requestPermission();
    }
    startAutoRefresh();
  } else {
    stopAutoRefresh();
  }
}

function sortPostsNewestFirst(list, timeKey = "createdAt") {
  return [...list].sort((a, b) => {
    const tb = b[timeKey] || b.createdAt || 0;
    const ta = a[timeKey] || a.createdAt || 0;
    return tb - ta;
  });
}

function getDraftPosts() {
  let filtered;
  if (currentFilter === "draft") {
    filtered = posts.filter((p) => p.publishState === "draft" || p.publishState === "publishing");
  } else if (currentFilter === "failed") {
    filtered = posts.filter((p) => p.publishState === "failed");
  } else {
    filtered = posts.filter((p) => p.publishState !== "published");
  }
  return sortPostsNewestFirst(filtered);
}

function getPublishedPosts() {
  return sortPostsNewestFirst(
    posts.filter((p) => p.publishState === "published"),
    "publishedAt",
  );
}

function getFilteredPosts() {
  return getDraftPosts();
}

function switchView(view) {
  activeView = view;
  $$(".view-panel").forEach((panel) => panel.classList.add("hidden"));
  const target = $(`#view-${view}`);
  if (target) target.classList.remove("hidden");
  $$(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === view));
  if (view === "api") {
    updateApiStatusCard();
    refreshApiAiManagePanel();
  }
  if (view === "ai") loadAiConfig();
  if (view === "ai-host") loadAiConfig();
  if (view === "tokens") loadTokenRegistry();
  else stopTokenQuotesAutoRefresh();
  if (view === "monitor") {
    renderMonitorAccountSelect();
    updateMonitorSectionHint();
  }
  if (view === "home") renderHomeDashboard();
  if (view === "logs") $("#progressPanel")?.classList.remove("hidden");
  renderPosts();
  renderAlerts();
}

function renderHomeDashboard() {
  const card = $("#homeAccountCard");
  if (!card) return;

  const defaultId = getDefaultAccountId();
  const acc = accountStore.accounts.find((a) => a.id === defaultId) || accountStore.accounts[0];

  if (!acc) {
    card.innerHTML = `
      <div class="empty-state">
        <p>尚未配置账号，请先添加币安广场 OpenAPI 账号</p>
        <button type="button" class="btn btn-primary btn-sm" id="btnHomeAddAccount">+ 添加账号</button>
      </div>`;
    $("#btnHomeAddAccount")?.addEventListener("click", () => {
      switchView("accounts");
      openAccountModal(null);
    });
  } else {
    card.innerHTML = `
      <div class="home-account-row"><span>账号名称</span><strong>${escapeHtml(acc.name)}${acc.isDefault ? "（默认）" : ""}</strong></div>
      <div class="home-account-row"><span>API Key</span><strong>${acc.hasApiKey ? escapeHtml(acc.maskedKey) : '<span class="error-text">未配置</span>'}</strong></div>
      <div class="home-account-row"><span>Cookie</span><strong>${acc.hasCookie ? "已配置" : "未配置"}</strong></div>
      <div class="home-account-row"><span>广场用户名</span><strong>${acc.username ? escapeHtml(acc.username) : "—"}</strong></div>
      <div class="home-account-row"><span>连接状态</span><strong style="color:${apiConfigured ? "var(--success)" : "var(--accent)"}">${apiConfigured ? "已连接" : "待验证"}</strong></div>
      <div class="form-row" style="margin-top:8px">
        <button type="button" class="btn btn-secondary btn-sm" id="btnHomeAddPost">+ 发帖</button>
        <button type="button" class="btn btn-ghost btn-sm" id="btnHomeEditAccount">编辑账号</button>
      </div>`;
    $("#btnHomeAddPost")?.addEventListener("click", () => {
      switchView("drafts");
      openPostModal(null);
    });
    $("#btnHomeEditAccount")?.addEventListener("click", () => {
      switchView("accounts");
      openAccountModal(acc.id);
    });
  }

  const draftCount = countByState("draft") + countByState("publishing");
  const publishedCount = countByState("published");
  const failedCount = countByState("failed");
  $("#homeDraftCount").textContent = String(draftCount);
  $("#homePublishedCount").textContent = String(publishedCount);
  $("#homeFailedCount").textContent = String(failedCount);
  $("#homeAccountCount").textContent = String(accountStore.accounts.length);
  const hint = $("#homePublishedListHint");
  if (hint) hint.textContent = publishedCount ? `共 ${publishedCount} 条` : "";
}

function appendSystemLog(msg, type = "info") {
  const box = $("#systemLog");
  if (!box) return;
  const el = document.createElement("div");
  el.className = `log-line ${type}`;
  const stamp = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  el.textContent = `[${stamp}] ${msg}`;
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
}

let systemLogSinceId = 0;
let systemLogPolling = false;

async function pollServerSystemLogs() {
  if (systemLogPolling) return;
  systemLogPolling = true;
  try {
    const res = await fetch(`/api/system-log?sinceId=${systemLogSinceId}&limit=100`);
    if (!res.ok) return;
    const data = await res.json();
    const rows = data.logs || [];
    for (const row of rows) {
      systemLogSinceId = Math.max(systemLogSinceId, row.id || 0);
      const type = row.type === "err" || row.type === "error" ? "err" : row.type === "ok" ? "ok" : "info";
      const stamp = new Date(row.time || Date.now()).toLocaleTimeString("zh-CN", { hour12: false });
      const box = $("#systemLog");
      if (!box) continue;
      const el = document.createElement("div");
      el.className = `log-line ${type}`;
      el.textContent = `[${stamp}] ${row.message}`;
      box.appendChild(el);
      box.scrollTop = box.scrollHeight;
    }
  } catch {
    // ignore poll errors
  } finally {
    systemLogPolling = false;
  }
}

async function clearServerSystemLogs() {
  try {
    await fetch("/api/system-log", { method: "DELETE" });
  } catch {
    // ignore
  }
  systemLogSinceId = 0;
  if ($("#systemLog")) $("#systemLog").innerHTML = "";
  appendSystemLog("已清空系统日志", "info");
}

function showAppToast(message, type = "ok") {
  let root = document.getElementById("appToastRoot");
  if (!root) {
    root = document.createElement("div");
    root.id = "appToastRoot";
    root.className = "app-toast-root";
    document.body.appendChild(root);
  }
  const el = document.createElement("div");
  el.className = `app-toast app-toast-${type}`;
  el.textContent = message;
  root.appendChild(el);
  requestAnimationFrame(() => el.classList.add("visible"));
  setTimeout(() => {
    el.classList.remove("visible");
    setTimeout(() => el.remove(), 320);
  }, 3200);
}

function showPublishedImportStatus(message, type = "ok") {
  const el = $("#publishedImportStatus");
  if (!el) return;
  el.textContent = message;
  el.className = `message ${type}`;
  el.classList.remove("hidden");
}

let globalProxyConfig = { type: "http", host: "", port: "", username: "", password: "" };

function updateApiStatusCard(config = null) {
  const statusEl = $("#apiStatusText");
  if (!statusEl) return;
  const count = accountStore.accounts.length;
  $("#apiAccountCount").textContent = String(count);
  $("#apiProxyText").textContent = config?.proxyConfig?.proxyLabel || globalProxyConfig.proxyLabel || "未配置";
  const defaultAcc = accountStore.accounts.find((a) => a.isDefault) || accountStore.accounts[0];
  $("#apiMaskedKey").textContent = defaultAcc?.maskedKey || "未配置";
  if (apiConfigured) {
    statusEl.textContent = "已连接";
    statusEl.style.color = "var(--success)";
  } else if (count > 0) {
    statusEl.textContent = "账号已添加，Key 未验证";
    statusEl.style.color = "var(--accent)";
  } else {
    statusEl.textContent = "未配置";
    statusEl.style.color = "var(--text-muted)";
  }
}

async function testDefaultApi() {
  const el = $("#apiManageMessage");
  if (el) {
    el.textContent = "正在验证...";
    el.className = "message info";
  }
  try {
    const res = await fetch("/api/config/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: getDefaultAccountId() }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "验证失败");
    if (el) {
      el.textContent = data.message || "API 验证成功";
      el.className = "message ok";
    }
    appendSystemLog("默认账号 API 验证成功", "ok");
  } catch (err) {
    if (el) {
      el.textContent = err.message;
      el.className = "message err";
    }
    appendSystemLog(`API 验证失败: ${err.message}`, "err");
  }
}

function getSelectedPosts() {
  return posts.filter((p) => p.selected && p.publishState !== "publishing");
}

function countByState(state) {
  return posts.filter((p) => p.publishState === state).length;
}

function getAccountName(accountId) {
  if (!accountId) {
    const defaultAcc = accountStore.accounts.find((a) => a.isDefault);
    return defaultAcc?.name || "默认账号";
  }
  return accountStore.accounts.find((a) => a.id === accountId)?.name || "未知账号";
}

function getDefaultAccountId() {
  return accountStore.defaultAccountId || accountStore.accounts.find((a) => a.isDefault)?.id || null;
}

function getPostAccountId(post) {
  return post.accountId || getDefaultAccountId();
}

function getPostAccountName(post) {
  return post.accountName || getAccountName(getPostAccountId(post));
}

function buildPostAccountSelectOptionsHtml(selectedId) {
  const value = selectedId || getDefaultAccountId() || "";
  return accountStore.accounts
    .map(
      (a) =>
        `<option value="${a.id}" ${a.id === value ? "selected" : ""}>${escapeHtml(a.name)}${a.isDefault ? "（默认）" : ""}</option>`
    )
    .join("");
}

function setPostAccount(postId, accountId) {
  const post = posts.find((p) => p.id === postId);
  if (!post || !accountId || accountId === getPostAccountId(post)) return;
  post.accountId = accountId;
  post.accountName = getAccountName(accountId);
  saveDrafts();
  renderPosts();
}

function applyBulkAccountToSelected() {
  const accountId = $("#bulkAccountSelect")?.value;
  if (!accountId) return alert("请选择发布账号");
  const selected = getSelectedPosts().filter((p) => p.publishState === "draft" || p.publishState === "failed");
  if (!selected.length) return alert("请先勾选要设置账号的草稿或失败帖子");
  const accountName = getAccountName(accountId);
  selected.forEach((post) => {
    post.accountId = accountId;
    post.accountName = accountName;
  });
  saveDrafts();
  renderPosts();
  showAppToast(`已将 ${selected.length} 条帖子设为「${accountName}」`, "ok");
}

function updateDraftBulkAccountBar() {
  const bar = $("#draftBulkAccountBar");
  if (!bar) return;
  const show = accountStore.accounts.length > 1;
  bar.classList.toggle("hidden", !show);
  if (show) renderAccountSelectOptions($("#bulkAccountSelect"), getDefaultAccountId());
}

function buildPostAccountBlock(p, { editable = false } = {}) {
  const accountId = getPostAccountId(p);
  const accountName = getPostAccountName(p);
  const canEditAccount =
    editable &&
    accountStore.accounts.length > 0 &&
    (p.publishState === "draft" || p.publishState === "failed");

  if (canEditAccount) {
    return `
      <div class="post-account-row">
        <label class="post-account-label" for="post-account-${p.id}">发布账号</label>
        <select id="post-account-${p.id}" class="account-select post-account-select" data-id="${p.id}" title="选择发布此帖的账号">
          ${buildPostAccountSelectOptionsHtml(accountId)}
        </select>
      </div>`;
  }

  if (!accountStore.accounts.length) {
    return `
      <div class="post-account-row post-account-row--static">
        <span class="post-account-label">发布账号</span>
        <span class="post-account-badge post-account-badge--warn">请先添加账号</span>
      </div>`;
  }

  return `
    <div class="post-account-row post-account-row--static">
      <span class="post-account-label">发布账号</span>
      <span class="post-account-badge">${escapeHtml(accountName)}</span>
    </div>`;
}

function getPostAccountId(post) {
  return post?.accountId || getDefaultAccountId() || "";
}

function getSelectedMonitorAccountId() {
  return selectedMonitorAccountId || $("#monitorAccountSelect")?.value || loadMonitorSettings().monitorAccountId || "";
}

function getMonitorSearchQuery() {
  return ($("#monitorSearchInput")?.value || monitorSearchQuery || "").trim().toLowerCase();
}

function postMatchesMonitorSearch(post, query) {
  if (!query) return true;
  const haystack = [
    post.text,
    post.title,
    post.accountName,
    getAccountName(getPostAccountId(post)),
    post.result?.shareLink,
    post.result?.id,
    post.result?.postId,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(query);
}

function getPublishedPostsForMonitor() {
  const published = getPublishedPosts();
  const accountId = getSelectedMonitorAccountId();
  const query = getMonitorSearchQuery();
  let list = accountId ? published.filter((p) => getPostAccountId(p) === accountId) : published;
  if (query) list = list.filter((p) => postMatchesMonitorSearch(p, query));
  return list;
}

function renderMonitorAccountSelect() {
  const select = $("#monitorAccountSelect");
  if (!select) return;
  if (!accountStore.accounts.length) {
    select.innerHTML = `<option value="">暂无账号</option>`;
    selectedMonitorAccountId = "";
    select.disabled = true;
    return;
  }
  select.disabled = false;
  const saved = loadMonitorSettings().monitorAccountId || "";
  let value = selectedMonitorAccountId || saved || "";

  if (accountStore.accounts.length === 1) {
    value = accountStore.accounts[0].id;
    select.innerHTML = `<option value="${accountStore.accounts[0].id}" selected>${escapeHtml(accountStore.accounts[0].name)}</option>`;
    selectedMonitorAccountId = value;
    return;
  }

  const options = [`<option value="" ${value === "" ? "selected" : ""}>全部账号</option>`];
  for (const a of accountStore.accounts) {
    options.push(
      `<option value="${a.id}" ${a.id === value ? "selected" : ""}>${escapeHtml(a.name)}${a.isDefault ? "（默认）" : ""}</option>`,
    );
  }
  select.innerHTML = options.join("");
  selectedMonitorAccountId = value;
}

function updateMonitorSectionHint() {
  const el = $("#monitorSectionHint");
  if (!el) return;
  if (!accountStore.accounts.length) {
    el.textContent = "请先在「账号管理」中添加账号。";
    return;
  }
  const accountId = getSelectedMonitorAccountId();
  const query = getMonitorSearchQuery();
  const parts = [];
  if (accountId) {
    parts.push(`账号「${getAccountName(accountId)}」`);
  } else {
    parts.push("全部账号");
  }
  if (query) {
    parts.push(`搜索「${query}」`);
  }
  el.textContent = `当前显示 ${parts.join(" · ")} 的已发布帖子，可展开查看评论与互动数据。`;
}

function renderAccountSelectOptions(selectEl, selectedId) {
  if (!selectEl) return;
  if (!accountStore.accounts.length) {
    selectEl.innerHTML = `<option value="">请先添加账号</option>`;
    return;
  }
  const defaultId = getDefaultAccountId();
  const value = selectedId || defaultId || "";
  selectEl.innerHTML = accountStore.accounts
    .map(
      (a) =>
        `<option value="${a.id}" ${a.id === value ? "selected" : ""}>${escapeHtml(a.name)}${a.isDefault ? "（默认）" : ""}</option>`
    )
    .join("");
}

function renderAccountSelects() {
  renderAccountSelectOptions($("#defaultAccountSelect"), getDefaultAccountId());
  renderAccountSelectOptions($("#postAccountSelect"), getDefaultAccountId());
  if ($("#aiAccountSelect")) {
    renderAccountSelectOptions($("#aiAccountSelect"), getDefaultAccountId());
  }
  if ($("#historyAccountSelect")) {
    const historyValue =
      selectedHistoryAccountId || $("#historyAccountSelect").value || getDefaultAccountId();
    renderAccountSelectOptions($("#historyAccountSelect"), historyValue);
    selectedHistoryAccountId = historyValue;
    $("#historyAccountSelect").classList.toggle("hidden", accountStore.accounts.length <= 1);
  }
  renderMonitorAccountSelect();
  updateMonitorSectionHint();
  if ($("#publishedPostsAccountSelect")?.closest("dialog")?.open) {
    const current = $("#publishedPostsAccountSelect").value || publishedPostsCache.accountId || getDefaultAccountId();
    renderAccountSelectOptions($("#publishedPostsAccountSelect"), current);
  }
}

const PROXY_UI = {
  account: {
    prefix: "account",
    defaultType: "global",
    onMessage: (msg, type) => showAccountFormMessage(msg, type),
    typeLabels: {
      http: "HTTP",
      https: "HTTPS",
      socks5: "Socks5",
      ssh: "SSH",
    },
  },
  global: {
    prefix: "global",
    defaultType: "http",
    onMessage: (msg, type) => showProxyMessage(msg, type),
  },
};

function proxyEl(prefix, name) {
  return $(`#${prefix}Proxy${name}`);
}

function updateProxyDetailsVisibility(scope = "account") {
  const meta = PROXY_UI[scope];
  const type = proxyEl(meta.prefix, "TypeSelect")?.value || meta.defaultType;
  const details = proxyEl(meta.prefix, "Details");
  const hint = proxyEl(meta.prefix, "Hint");
  if (!details) return;
  const showDetails = ["http", "https", "socks5", "ssh"].includes(type);
  details.classList.toggle("hidden", !showDetails);
  if (!hint) return;
  if (scope === "global") {
    if (type === "direct") {
      hint.textContent = "直连模式下，使用全局代理的账号将走本地网络。";
    } else if (type === "ssh") {
      hint.textContent = "SSH 隧道经 Socks5 连接。使用全局代理的账号均走此处配置。";
    } else {
      hint.textContent = "使用全局代理的账号，发帖与拉取历史均走此处配置。";
    }
    return;
  }
  if (type === "direct") {
    hint.textContent = "直连模式：不走任何代理，使用本机网络。";
  } else if (type === "global") {
    hint.textContent = "将使用「设置」页的全局代理。如需独立 IP，请选择「自定义 Socks5/HTTP 代理 IP」。";
  } else if (type === "ssh") {
    hint.textContent = "SSH 隧道经 Socks5 连接。填写主机、端口与账号密码后，本账号固定走该代理。";
  } else {
    hint.textContent =
      "填写代理 IP 与端口后保存。点「检测代理」验证出网；点「验证 Key」经代理连接币安。";
  }
  if (scope === "account") updateAccountProxyModeTip(type);
}

function updateAccountProxyModeTip(type) {
  const el = $("#accountProxyModeTip");
  if (!el) return;
  if (type === "global") {
    el.textContent = "当前：使用全局代理（来自「设置」页）";
    el.classList.remove("is-custom");
  } else if (type === "direct") {
    el.textContent = "当前：直连模式（不走代理）";
    el.classList.remove("is-custom");
  } else {
    const label = PROXY_UI.account.typeLabels?.[type] || type.toUpperCase();
    el.textContent = `当前：独立代理 IP（${label}）`;
    el.classList.add("is-custom");
  }
}

function applyProxyToUI(scope, proxyConfig) {
  const meta = PROXY_UI[scope];
  const config = proxyConfig || { type: meta.defaultType, host: "", port: "", username: "", password: "" };
  const useGlobalDefaults = scope === "global" && ["http", "https", "socks5", "ssh"].includes(config.type || meta.defaultType);
  proxyEl(meta.prefix, "TypeSelect").value = config.type || meta.defaultType;
  proxyEl(meta.prefix, "QuickInput").value = "";
  proxyEl(meta.prefix, "HostInput").value = config.host || (useGlobalDefaults ? "127.0.0.1" : "");
  proxyEl(meta.prefix, "PortInput").value = config.port || (useGlobalDefaults ? "7897" : "");
  proxyEl(meta.prefix, "UserInput").value = config.username || "";
  const passInput = proxyEl(meta.prefix, "PassInput");
  if (passInput) {
    passInput.value = "";
    passInput.placeholder =
      config.hasPassword || config.password === "******" ? "已保存，留空不修改" : "选填";
  }
  updateProxyDetailsVisibility(scope);
}

function isBlankProxyPasswordInput(value) {
  const text = String(value ?? "").trim();
  if (!text) return true;
  if (/^\*+$/.test(text) || /^•+$/.test(text) || /^·+$/.test(text)) return true;
  if (/已保存|留空不修改|^选填$/.test(text)) return true;
  return false;
}

function collectProxyFromUI(scope) {
  const meta = PROXY_UI[scope];
  const type = proxyEl(meta.prefix, "TypeSelect")?.value || meta.defaultType;
  const passEl = proxyEl(meta.prefix, "PassInput");
  const config = {
    type,
    host: proxyEl(meta.prefix, "HostInput")?.value.trim() || "",
    port: proxyEl(meta.prefix, "PortInput")?.value.trim() || "",
    username: proxyEl(meta.prefix, "UserInput")?.value.trim() || "",
    password: passEl?.value || "",
  };
  if (type === "global" || type === "direct") {
    config.host = "";
    config.port = "";
    config.username = "";
    delete config.password;
  } else if (isBlankProxyPasswordInput(config.password)) {
    // 留空/掩码 → 不传密码，由服务端合并已保存密码
    delete config.password;
  }
  return config;
}

function parseProxyQuickText(text, preferredType = "http") {
  const raw = String(text || "").trim();
  if (!raw) return null;

  const colonFormat = raw.match(/^(https?|socks5|ssh):\/\/([^:/]+):(\d+)(?::([^:]*))?(?::(.*))?$/i);
  if (colonFormat) {
    const [, type, host, port, username = "", password = ""] = colonFormat;
    return { type: type.toLowerCase(), host: host.trim(), port: String(port), username, password };
  }

  const urlAuth = raw.match(/^(https?|socks5|ssh):\/\/(?:([^:@]+):([^@]*)@)?([^:/]+):(\d+)$/i);
  if (urlAuth) {
    const [, type, username = "", password = "", host, port] = urlAuth;
    return { type: type.toLowerCase(), host: host.trim(), port: String(port), username, password };
  }

  // user:pass@host:port
  const authAt = raw.match(/^([^:@\s]+):([^@\s]*)@([^:/]+):(\d+)$/);
  if (authAt) {
    const [, username, password, host, port] = authAt;
    return { type: preferredType, host: host.trim(), port: String(port), username, password };
  }

  // host:port:user:pass（常见供应商格式，无协议前缀）
  const bareAuth = raw.match(/^([^:/?\s]+):(\d+):([^:]*):(.*)$/);
  if (bareAuth) {
    const [, host, port, username = "", password = ""] = bareAuth;
    return { type: preferredType, host: host.trim(), port: String(port), username, password };
  }

  // host:port
  const bareHost = raw.match(/^([^:/?\s]+):(\d+)$/);
  if (bareHost) {
    const [, host, port] = bareHost;
    return { type: preferredType, host: host.trim(), port: String(port), username: "", password: "" };
  }

  return null;
}

function parseProxyQuickInput(scope) {
  const meta = PROXY_UI[scope];
  const quickEl = proxyEl(meta.prefix, "QuickInput");
  const raw = quickEl?.value.trim();
  if (!raw) return;

  const currentType = proxyEl(meta.prefix, "TypeSelect")?.value || meta.defaultType;
  const preferredType = ["http", "https", "socks5", "ssh"].includes(currentType) ? currentType : "socks5";
  const parsed = parseProxyQuickText(raw, preferredType);

  if (!parsed) {
    meta.onMessage("无法识别代理格式。支持：IP:端口:账号:密码 或 http://主机:端口:账号:密码", "err");
    return;
  }

  const nextType =
    parsed.type === "ssh"
      ? "ssh"
      : parsed.type === "socks5"
        ? "socks5"
        : parsed.type === "https"
          ? "https"
          : parsed.type === "http"
            ? "http"
            : preferredType;

  // 当前若是「全局/直连」，自动切到自定义代理，否则字段无法编辑
  if (currentType === "global" || currentType === "direct") {
    proxyEl(meta.prefix, "TypeSelect").value = nextType;
  } else if (["http", "https", "socks5", "ssh"].includes(parsed.type)) {
    proxyEl(meta.prefix, "TypeSelect").value = nextType;
  }

  proxyEl(meta.prefix, "HostInput").value = parsed.host;
  proxyEl(meta.prefix, "PortInput").value = parsed.port;
  proxyEl(meta.prefix, "UserInput").value = parsed.username || "";
  if (parsed.password) proxyEl(meta.prefix, "PassInput").value = parsed.password;
  updateProxyDetailsVisibility(scope);
  meta.onMessage("已自动拆分到主机 / 端口 / 账号 / 密码", "ok");
}

function getAccountProxyConfig(accountId) {
  const acc = accountStore.accounts.find((a) => a.id === accountId);
  return acc?.proxyConfig || { type: "global", host: "", port: "", username: "", password: "" };
}

function applyAccountProxyToUI(proxyConfig) {
  applyProxyToUI("account", proxyConfig);
}

function collectAccountProxyFromUI() {
  return collectProxyFromUI("account");
}

function updateAccountProxyDetailsVisibility() {
  updateProxyDetailsVisibility("account");
}

function parseAccountProxyQuickInput() {
  parseProxyQuickInput("account");
}

function getAccountUsername(accountId) {
  return accountStore.accounts.find((a) => a.id === accountId)?.username || "";
}

function formatAccountDate(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getFilteredAccounts() {
  let list = [...accountStore.accounts].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const q = accountListState.query.trim().toLowerCase();
  if (q) {
    list = list.filter(
      (acc) =>
        acc.name.toLowerCase().includes(q) ||
        (acc.username || "").toLowerCase().includes(q) ||
        (acc.maskedKey || "").toLowerCase().includes(q)
    );
  }
  if (accountListState.dateFrom) {
    const from = new Date(accountListState.dateFrom);
    from.setHours(0, 0, 0, 0);
    list = list.filter((acc) => (acc.createdAt || 0) >= from.getTime());
  }
  if (accountListState.dateTo) {
    const to = new Date(accountListState.dateTo);
    to.setHours(23, 59, 59, 999);
    list = list.filter((acc) => (acc.createdAt || 0) <= to.getTime());
  }
  return list;
}

function syncAccountFilterInputs() {
  const searchInput = $("#accountSearchInput");
  const dateFrom = $("#accountDateFrom");
  const dateTo = $("#accountDateTo");
  if (searchInput && searchInput.value !== accountListState.query) searchInput.value = accountListState.query;
  if (dateFrom && dateFrom.value !== accountListState.dateFrom) dateFrom.value = accountListState.dateFrom;
  if (dateTo && dateTo.value !== accountListState.dateTo) dateTo.value = accountListState.dateTo;
}

function resetAccountListFilters() {
  accountListState = { query: "", dateFrom: "", dateTo: "", page: 1 };
  syncAccountFilterInputs();
  renderAccountList();
}

function renderAccountPagination(total, totalPages) {
  const el = $("#accountPagination");
  if (!el) return;

  const hasFilters =
    accountListState.query.trim() ||
    accountListState.dateFrom ||
    accountListState.dateTo;

  if (total === 0 && !accountStore.accounts.length) {
    el.classList.add("hidden");
    el.innerHTML = "";
    return;
  }

  el.classList.remove("hidden");
  const start = total === 0 ? 0 : (accountListState.page - 1) * ACCOUNT_PAGE_SIZE + 1;
  const end = Math.min(accountListState.page * ACCOUNT_PAGE_SIZE, total);
  const summary =
    total === 0
      ? hasFilters
        ? "未找到匹配的账号"
        : "暂无账号"
      : `共 ${total} 个账号，显示 ${start}-${end}`;

  el.innerHTML = `
    <span class="account-pagination-summary">${summary}</span>
    <div class="account-pagination-actions">
      <button type="button" class="btn btn-ghost btn-sm" id="btnAccountPrevPage" ${accountListState.page <= 1 ? "disabled" : ""}>上一页</button>
      <span class="account-pagination-page">第 ${totalPages ? accountListState.page : 0} / ${totalPages || 0} 页</span>
      <button type="button" class="btn btn-ghost btn-sm" id="btnAccountNextPage" ${accountListState.page >= totalPages ? "disabled" : ""}>下一页</button>
    </div>
  `;

  $("#btnAccountPrevPage")?.addEventListener("click", () => {
    if (accountListState.page > 1) {
      accountListState.page -= 1;
      renderAccountList();
    }
  });
  $("#btnAccountNextPage")?.addEventListener("click", () => {
    if (accountListState.page < totalPages) {
      accountListState.page += 1;
      renderAccountList();
    }
  });
}

function renderAccountList() {
  const container = $("#accountList");
  if (!container) return;

  syncAccountFilterInputs();

  if (!accountStore.accounts.length) {
    $("#accountPagination")?.classList.add("hidden");
    container.innerHTML = `<div class="account-empty">暂无账号，点击「添加账号」开始配置</div>`;
    return;
  }

  const filtered = getFilteredAccounts();
  const totalPages = Math.max(1, Math.ceil(filtered.length / ACCOUNT_PAGE_SIZE));
  if (accountListState.page > totalPages) accountListState.page = totalPages;
  if (accountListState.page < 1) accountListState.page = 1;

  const pageAccounts = filtered.slice(
    (accountListState.page - 1) * ACCOUNT_PAGE_SIZE,
    accountListState.page * ACCOUNT_PAGE_SIZE
  );

  renderAccountPagination(filtered.length, totalPages);

  if (!pageAccounts.length) {
    container.innerHTML = `
      <div class="account-empty">
        未找到匹配的账号
        <button type="button" class="btn btn-ghost btn-sm" id="btnAccountEmptyClear">清除筛选</button>
      </div>`;
    $("#btnAccountEmptyClear")?.addEventListener("click", resetAccountListFilters);
    return;
  }

  container.innerHTML = pageAccounts
    .map(
      (acc) => `
    <div class="account-card ${acc.isDefault ? "is-default" : ""}" data-id="${acc.id}">
      <div class="account-card-main">
        <div class="account-card-title">
          <strong>${escapeHtml(acc.name)}</strong>
          ${acc.isDefault ? '<span class="badge badge-green account-default-badge">默认</span>' : ""}
        </div>
        <div class="account-card-meta">
          <span>${acc.hasApiKey ? `API Key: ${escapeHtml(acc.maskedKey)}` : '<span class="error-text">未配置 API Key</span>'}</span>
          <span>${acc.hasCookie ? "已配置 Cookie" : "未配置 Cookie"}</span>
          <span>${acc.proxyLabel ? `代理: ${escapeHtml(acc.proxyLabel)}` : "代理: 全局"}</span>
          ${acc.username ? `<span>用户名: ${escapeHtml(acc.username)}</span>` : ""}
          <span>添加时间: ${formatAccountDate(acc.createdAt)}</span>
        </div>
      </div>
      <div class="account-card-actions">
        <button class="btn btn-ghost btn-sm" data-action="view-posts" data-id="${acc.id}">已发布</button>
        ${acc.isDefault ? "" : `<button class="btn btn-ghost btn-sm" data-action="set-default" data-id="${acc.id}">设为默认</button>`}
        <button class="btn btn-ghost btn-sm" data-action="edit-account" data-id="${acc.id}">编辑</button>
        <button class="btn btn-ghost btn-sm btn-danger" data-action="delete-account" data-id="${acc.id}" ${accountStore.accounts.length <= 1 ? "disabled" : ""}>删除</button>
      </div>
    </div>`
    )
    .join("");

  container.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      if (btn.dataset.action === "edit-account") openAccountModal(id);
      if (btn.dataset.action === "delete-account") deleteAccount(id);
      if (btn.dataset.action === "set-default") setDefaultAccount(id);
      if (btn.dataset.action === "view-posts") {
        if (!canFetchAccountHistory(id)) {
          showPublishedPostsEmptyState(id);
        } else {
          showPublishedPostsModal(id, { postRef: findLocalPostRefForAccount(id) });
        }
      }
    });
  });
}

async function loadAccounts() {
  const res = await fetch("/api/accounts");
  accountStore = await res.json();
  renderAccountList();
  renderAccountSelects();
  if (activeView === "home") renderHomeDashboard();
  if (activeView === "ai" || activeView === "api") {
    try {
      const aiRes = await fetch("/api/ai/config");
      const aiData = normalizeAiConfigResponse(await aiRes.json());
      if (activeView === "ai") await applyAiConfigToUI(aiData);
      if (activeView === "api") {
        aiProfilesCache = aiData.aiProfiles || [];
        defaultAiProfileIdCache = aiData.defaultAiProfileId || null;
        updateApiAiStatusCard(aiData);
        renderAiProfilesList(aiProfilesCache, defaultAiProfileIdCache);
      }
    } catch {
      // ignore ai refresh errors when syncing accounts
    }
  }
}

async function init() {
  applyTheme();
  posts = loadDrafts();
  alerts = loadAlerts();
  applyMonitorSettingsToUI(loadMonitorSettings());
  selectedMonitorAccountId = loadMonitorSettings().monitorAccountId || "";
  monitorSearchQuery = loadMonitorSettings().monitorSearchQuery || "";
  await loadAccounts();
  await syncAllLocalPublishedToCache();
  await loadConfig();
  await loadAiConfig();
  initAiCollapseSections();
  bindEvents();
  initDesktopUpdater();
  switchView("home");
  renderPosts();
  renderAlerts();
  if (loadMonitorSettings().autoRefreshEnabled) startAutoRefresh();
  setInterval(refreshAiRuntimeStatus, 30000);
  setInterval(pollServerSystemLogs, 5000);
  pollServerSystemLogs();
}

async function refreshAiRuntimeStatus() {
  if (activeView !== "ai-host" && activeView !== "ai") return;
  try {
    const res = await fetch("/api/ai/config");
    const data = await res.json();
    renderAiStatus(data);
  } catch {
    // ignore background status refresh errors
  }
}

async function loadConfig() {
  const res = await fetch("/api/config");
  const data = await res.json();
  apiConfigured = data.configured;
  const badge = $("#keyStatus");
  const count = data.accountCount || accountStore.accounts.length;
  if (data.configured) {
    badge.textContent = count > 1 ? `${count} 个账号已配置` : `账号: ${getAccountName(data.defaultAccountId)}`;
    badge.className = "badge badge-green";
  } else if (count > 0) {
    badge.textContent = `${count} 个账号（未配置 Key）`;
    badge.className = "badge badge-gray";
  } else {
    badge.textContent = "未配置账号";
    badge.className = "badge badge-gray";
  }
  if (data.proxyConfig) {
    globalProxyConfig = data.proxyConfig;
    applyProxyToUI("global", data.proxyConfig);
    updateSystemProxyHint(data.proxyConfig);
    maybeNotifySystemProxy(data.proxyConfig);
  }
  if (data.dataDirInfo) {
    applyDataDirToUI(data.dataDirInfo);
  } else if (data.dataDir) {
    applyDataDirToUI({ currentDir: data.dataDir, defaultDir: data.dataDir });
  }
  if ($("#browserPathInput")) {
    $("#browserPathInput").value = data.browserPath || "";
  }
  updateApiStatusCard(data);
  updatePublishBtn();
  if (activeView === "home") renderHomeDashboard();
  await maybeShowProxySetupGuide(data.proxyConfig);
}

function updateSystemProxyHint(proxyConfig) {
  const el = $("#systemProxyHint");
  if (!el) return;
  if (proxyConfig?.proxySource === "system" && proxyConfig.systemProxy) {
    el.textContent = `已自动使用 Windows 系统代理（${proxyConfig.systemProxy.host}:${proxyConfig.systemProxy.port}）。梯子开启系统代理时可不手动填写，也可保存为固定配置。`;
    el.classList.remove("hidden");
    return;
  }
  if (proxyConfig?.proxySource === "none") {
    el.textContent = "未检测到可用代理。请开启梯子并启用「系统代理」，或在下方手动填写主机与端口。";
    el.classList.remove("hidden");
    return;
  }
  el.classList.add("hidden");
}

function maybeNotifySystemProxy(proxyConfig) {
  if (proxyConfig?.proxySource !== "system" || !proxyConfig.systemProxy) return;
  if (localStorage.getItem(PROXY_SYSTEM_NOTIFIED_KEY)) return;
  localStorage.setItem(PROXY_SYSTEM_NOTIFIED_KEY, "1");
  appendSystemLog(
    `已自动使用 Windows 系统代理（${proxyConfig.systemProxy.host}:${proxyConfig.systemProxy.port}）`,
    "ok",
  );
}

let proxySetupPrompted = false;

async function maybeShowProxySetupGuide(proxyConfig) {
  if (!proxyConfig?.needsProxySetup || proxySetupPrompted) return;
  proxySetupPrompted = true;
  const modal = $("#proxySetupModal");
  if (!modal) return;

  const systemBlock = $("#proxySetupSystemBlock");
  const systemText = $("#proxySetupSystemText");
  if (proxyConfig.systemProxy) {
    systemBlock?.classList.remove("hidden");
    if (systemText) {
      systemText.textContent = `检测到 ${proxyConfig.systemProxy.host}:${proxyConfig.systemProxy.port}，可直接使用。`;
    }
  } else {
    systemBlock?.classList.add("hidden");
  }

  showProxySetupMessage("", "");
  openAppModal("proxySetupModal");
}

function showProxySetupMessage(msg, type) {
  const el = $("#proxySetupMessage");
  if (!el) return;
  el.textContent = msg || "";
  el.className = msg ? `message ${type}` : "message";
}

async function dismissProxySetupGuide() {
  await fetch("/api/config/proxy/dismiss-guide", { method: "POST" });
  $("#proxySetupModal")?.close();
}

async function applySystemProxyFromGuide() {
  try {
    showProxySetupMessage("正在应用系统代理...", "info");
    const res = await fetch("/api/config/proxy/apply-system", { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "应用失败");
    await loadConfig();
    showProxySetupMessage("已应用系统代理，正在测试网络...", "info");
    const testRes = await fetch("/api/config/network-test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const testData = await testRes.json();
    if (!testRes.ok) throw new Error(testData.error || "网络测试失败");
    appendSystemLog(testData.message || "网络连接正常", "ok");
    $("#proxySetupModal")?.close();
  } catch (err) {
    showProxySetupMessage(err.message, "err");
  }
}

function goProxySetupSettings() {
  $("#proxySetupModal")?.close();
  switchView("settings");
  const typeSelect = $("#globalProxyTypeSelect");
  if (typeSelect) typeSelect.value = "http";
  updateProxyDetailsVisibility("global");
  if (!$("#globalProxyHostInput")?.value) $("#globalProxyHostInput").value = "127.0.0.1";
  if (!$("#globalProxyPortInput")?.value) $("#globalProxyPortInput").value = "7897";
  $("#globalProxyHostInput")?.focus();
}

function bindEvents() {
  bindAppModalDismiss();
  $$(".nav-item").forEach((item) => {
    item.addEventListener("click", () => switchView(item.dataset.view));
  });

  $("#btnHomeManageAccount")?.addEventListener("click", () => switchView("accounts"));
  $("#btnHomeViewAllPublished")?.addEventListener("click", () => switchView("published"));
  $("#btnHomeRefreshStats")?.addEventListener("click", () => refreshAllStats());

  $("#btnTestDefaultApi")?.addEventListener("click", testDefaultApi);
  $("#btnGoAccounts")?.addEventListener("click", () => switchView("accounts"));
  $("#btnAddAiProfile")?.addEventListener("click", () => openAiProfileModal(null));
  $("#btnGoAiSettings")?.addEventListener("click", () => switchView("ai"));
  $("#btnGoAiHostFromStyles")?.addEventListener("click", () => switchView("ai-host"));
  $("#btnAddToken")?.addEventListener("click", () => openTokenModal(null));
  $("#btnRefreshTokenQuotes")?.addEventListener("click", () => refreshTokenQuotes(true));
  $("#btnSyncBinanceTokens")?.addEventListener("click", syncBinanceTokensFromUi);
  $("#btnSaveTokenRefresh")?.addEventListener("click", saveTokenRefreshSettings);
  $("#tokenSearchInput")?.addEventListener("input", (e) => {
    tokenRegistryState.query = e.target.value || "";
    tokenRegistryState.page = 1;
    renderTokenRegistryTable();
  });
  $("#tokenRegistryPagination")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-token-page]");
    if (!btn) return;
    const page = Number(btn.dataset.tokenPage);
    if (!Number.isFinite(page) || page < 1) return;
    tokenRegistryState.page = page;
    renderTokenRegistryTable();
    refreshTokenQuotes(false);
  });
  $("#tokenForm")?.addEventListener("submit", saveTokenFromModal);
  $("#btnCancelToken")?.addEventListener("click", () => $("#tokenModal")?.close());
  $("#tokenRegistryBody")?.addEventListener("click", onTokenRegistryClick);
  $("#tokenRegistryBody")?.addEventListener("change", onTokenRegistryChange);
  $("#apiAiProfilesList")?.addEventListener("click", onApiAiProfilesListClick);
  $("#aiProfileForm")?.addEventListener("submit", saveAiProfileFromModal);
  $("#btnCancelAiProfile")?.addEventListener("click", () => $("#aiProfileModal")?.close());
  $("#btnTestAiProfileModal")?.addEventListener("click", testAiProfileFromModal);
  $("#aiProfileProviderSelect")?.addEventListener("change", onAiProfileProviderChange);
  $("#btnClearSystemLog")?.addEventListener("click", () => {
    clearServerSystemLogs();
  });

  $("#btnAddAccount").addEventListener("click", () => openAccountModal(null));
  $("#accountSearchInput")?.addEventListener("input", (e) => {
    accountListState.query = e.target.value;
    accountListState.page = 1;
    renderAccountList();
  });
  $("#accountDateFrom")?.addEventListener("change", (e) => {
    accountListState.dateFrom = e.target.value;
    accountListState.page = 1;
    renderAccountList();
  });
  $("#accountDateTo")?.addEventListener("change", (e) => {
    accountListState.dateTo = e.target.value;
    accountListState.page = 1;
    renderAccountList();
  });
  $("#btnAccountClearFilters")?.addEventListener("click", resetAccountListFilters);
  $("#btnSaveProxy").addEventListener("click", saveProxy);
  $("#btnTestNetwork").addEventListener("click", testNetwork);
  $("#btnPickDataDir")?.addEventListener("click", pickDataDir);
  $("#btnSaveDataDir")?.addEventListener("click", saveDataDir);
  $("#btnResetDataDir")?.addEventListener("click", resetDataDir);
  $("#btnRestartApp")?.addEventListener("click", restartAppForDataDir);
  $("#btnCheckUpdate")?.addEventListener("click", manualCheckForUpdates);
  $("#btnUpdateDownload")?.addEventListener("click", startUpdateDownload);
  $("#btnUpdateInstall")?.addEventListener("click", installDownloadedUpdate);
  $("#btnUpdateLater")?.addEventListener("click", () => dismissUpdateModal(true));
  $("#btnSaveBrowser")?.addEventListener("click", saveBrowserPath);
  $("#btnTestBrowser")?.addEventListener("click", testBrowser);
  $("#btnProxySetupApplySystem")?.addEventListener("click", applySystemProxyFromGuide);
  $("#btnProxySetupGoSettings")?.addEventListener("click", goProxySetupSettings);
  $("#btnProxySetupLater")?.addEventListener("click", dismissProxySetupGuide);
  $("#globalProxyTypeSelect")?.addEventListener("change", () => updateProxyDetailsVisibility("global"));
  $("#globalProxyQuickInput")?.addEventListener("change", () => parseProxyQuickInput("global"));
  $("#globalProxyQuickInput")?.addEventListener("paste", () => {
    setTimeout(() => parseProxyQuickInput("global"), 0);
  });
  $("#globalProxyQuickInput")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      parseProxyQuickInput("global");
    }
  });
  $("#btnSaveAiConfig").addEventListener("click", saveAiConfig);
  $("#btnSaveAiSettings")?.addEventListener("click", saveAiSettingsOnly);
  $("#btnPreviewAiStyleRef")?.addEventListener("click", () => previewAiStyleReference());
  $("#btnAddAiStyleRef")?.addEventListener("click", addAiStyleReferenceFromUi);
  $("#aiStyleRefFileInput")?.addEventListener("change", onAiStyleRefFileSelected);
  $("#aiStyleRefList")?.addEventListener("click", onAiStyleRefListClick);
  $("#btnTestAi")?.addEventListener("click", testAiApi);
  $("#aiProviderSelect")?.addEventListener("change", onAiProviderChange);
  $("#btnAddCustomToken")?.addEventListener("click", addCustomTokenFromInput);
  $("#aiCustomTokenInput")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addCustomTokenFromInput();
    }
  });
  $("#btnAiGenerateDraft").addEventListener("click", () => aiRun({ publish: false }));
  $("#btnAiRunNow").addEventListener("click", () => aiRun({ publish: true }));
  $("#btnAiCancelHosting").addEventListener("click", stopAiHosting);
  $("#btnAiFillPost").addEventListener("click", aiFillPostModal);
  $("#btnThemeToggle")?.addEventListener("click", toggleTheme);
  $("#btnDisclaimer")?.addEventListener("click", () => showLegalModal("disclaimer"));
  $("#btnLicense")?.addEventListener("click", () => showLegalModal("license"));
  $("#btnUnbindDevice")?.addEventListener("click", unbindCurrentDevice);
  $("#btnCloseLegalModal")?.addEventListener("click", () => $("#legalModal")?.close());
  $("#defaultAccountSelect").addEventListener("change", (e) => setDefaultAccount(e.target.value, { silent: true }));

  $("#accountForm").addEventListener("submit", (e) => {
    e.preventDefault();
    saveAccountFromModal();
  });
  $("#btnCancelAccountModal").addEventListener("click", () => $("#accountModal").close());
  $("#accountProxyTypeSelect")?.addEventListener("change", updateAccountProxyDetailsVisibility);
  $("#accountProxyQuickInput")?.addEventListener("change", parseAccountProxyQuickInput);
  $("#accountProxyQuickInput")?.addEventListener("paste", () => {
    setTimeout(parseAccountProxyQuickInput, 0);
  });
  $("#accountProxyQuickInput")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      parseAccountProxyQuickInput();
    }
  });
  $("#btnTestAccountKey").addEventListener("click", testAccountKey);
  $("#btnTestAccountProxy")?.addEventListener("click", testAccountProxy);
  $("#btnClosePublishedPosts").addEventListener("click", () => $("#publishedPostsModal").close());
  $("#btnDonePublishedPosts").addEventListener("click", () => $("#publishedPostsModal").close());
  $("#btnImportPublishedPosts").addEventListener("click", importPublishedPostsToList);

  $("#btnAddPost").addEventListener("click", () => openPostModal(null));
  $("#btnImport").addEventListener("click", () => openAppModal("importModal"));
  $("#btnClearDrafts").addEventListener("click", clearDrafts);
  $("#btnClearPublished").addEventListener("click", clearPublished);
  $("#btnDeleteSelected")?.addEventListener("click", deleteSelectedDrafts);
  $("#btnPublish").addEventListener("click", startBatchPublish);

  $("#btnSelectDrafts").addEventListener("click", selectDraftsOnly);
  $("#btnSelectNone").addEventListener("click", selectNone);
  $("#btnApplyBulkAccount")?.addEventListener("click", applyBulkAccountToSelected);
  $("#btnRefreshAllStats").addEventListener("click", () => refreshAllStats());
  $("#monitorAccountSelect")?.addEventListener("change", (e) => {
    selectedMonitorAccountId = e.target.value;
    const settings = loadMonitorSettings();
    settings.monitorAccountId = selectedMonitorAccountId;
    saveMonitorSettings(settings);
    updateMonitorSectionHint();
    renderPosts();
    renderAlerts();
  });
  $("#monitorSearchInput")?.addEventListener("input", () => {
    monitorSearchQuery = getMonitorSearchQuery();
    const settings = loadMonitorSettings();
    settings.monitorSearchQuery = monitorSearchQuery;
    saveMonitorSettings(settings);
    updateMonitorSectionHint();
    renderPosts();
    renderAlerts();
  });
  $("#btnFetchHistoryPosts").addEventListener("click", () => fetchHistoryForCurrentAccount());
  $("#historyAccountSelect")?.addEventListener("change", (e) => {
    selectedHistoryAccountId = e.target.value;
  });
  $("#publishedPostsAccountSelect")?.addEventListener("change", () => reloadPublishedPostsForSelectedAccount());
  $("#btnExportExcel").addEventListener("click", exportToExcel);
  $("#btnClearAlerts").addEventListener("click", clearAlerts);
  $("#autoRefreshEnabled").addEventListener("change", setupAutoRefresh);
  $("#autoRefreshMinutes").addEventListener("change", setupAutoRefresh);
  $("#viewAlertThreshold").addEventListener("change", setupAutoRefresh);
  $("#notifyBrowser").addEventListener("change", setupAutoRefresh);
  $("#selectAllCheckbox").addEventListener("change", (e) => toggleSelectAll(e.target.checked));

  $$(".filter-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      $$(".filter-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      currentFilter = tab.dataset.filter;
      renderPosts();
    });
  });

  $("#postList").addEventListener("change", (e) => {
    if (e.target.classList.contains("post-select")) {
      const post = posts.find((p) => p.id === e.target.dataset.id);
      if (!post || publishing) return;
      post.selected = e.target.checked;
      saveDrafts();
      updatePublishBtn();
      updateSelectAllCheckbox();
      return;
    }
    if (e.target.classList.contains("post-account-select")) {
      const postId = e.target.dataset.id;
      const accountId = e.target.value;
      if (!postId || !accountId || publishing) return;
      const post = posts.find((p) => p.id === postId);
      if (!post) return;
      post.accountId = accountId;
      post.accountName = getAccountName(accountId);
      saveDrafts();
      showAppToast(`已设为「${post.accountName}」`, "ok");
    }
  });

  $("#postForm").addEventListener("submit", (e) => {
    e.preventDefault();
    savePostFromModal();
  });
  $("#btnCancelModal").addEventListener("click", () => $("#postModal").close());

  $("#postText").addEventListener("input", () => {
    $("#charCount").textContent = $("#postText").value.length;
  });

  $("#postImages").addEventListener("change", handleImageSelect);

  $("#btnCancelImport").addEventListener("click", () => $("#importModal").close());
  $("#btnConfirmImport").addEventListener("click", confirmImport);

  $$(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      $$(".tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      const name = tab.dataset.tab;
      $("#tabJson").classList.toggle("hidden", name !== "json");
      $("#tabText").classList.toggle("hidden", name !== "text");
    });
  });
}

async function setDefaultAccount(accountId, { silent = false } = {}) {
  if (!accountId || accountId === getDefaultAccountId()) return;
  try {
    const res = await fetch(`/api/accounts/${encodeURIComponent(accountId)}/default`, { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "设置失败");
    await loadAccounts();
    await loadConfig();
    if (!silent) showAccountMessage("已设为默认账号", "ok");
  } catch (err) {
    if (!silent) showAccountMessage(err.message, "err");
    renderAccountSelects();
  }
}

function openAccountModal(accountId) {
  const isEdit = Boolean(accountId);
  const acc = isEdit ? accountStore.accounts.find((a) => a.id === accountId) : null;
  $("#editAccountId").value = accountId || "";
  $("#accountModalTitle").textContent = isEdit ? "编辑账号" : "添加账号";
  $("#accountNameInput").value = isEdit ? getAccountName(accountId) : "";
  $("#accountUsernameInput").value = isEdit ? getAccountUsername(accountId) : "";
  applyAccountProxyToUI(isEdit ? getAccountProxyConfig(accountId) : { type: "global" });
  // 编辑时故意不回填明文 Key；留空表示不修改，避免误覆盖
  const apiKeyInput = $("#accountApiKeyInput");
  apiKeyInput.value = "";
  $("#accountCookieInput").value = "";
  apiKeyInput.required = !isEdit;
  apiKeyInput.autocomplete = "new-password";
  apiKeyInput.placeholder = isEdit && acc?.hasApiKey
    ? `已保存 ${acc.maskedKey || "***"}（留空不修改）`
    : "粘贴 Square OpenAPI Key";
  $("#apiKeyRequired").style.display = isEdit ? "none" : "inline";
  $("#apiKeyHint").classList.toggle("hidden", !isEdit);
  if (isEdit) {
    const keyHint = acc?.hasApiKey
      ? `已保存 Key：${acc.maskedKey || "***"}。验证与保存时留空都会沿用原 Key，不会丢失。`
      : "该账号尚未配置 API Key，请粘贴后保存";
    $("#apiKeyHint").textContent = keyHint;
    const cookieHint = $("#accountCookieHint");
    if (cookieHint) {
      cookieHint.textContent = acc?.hasCookie
        ? "已配置 Cookie：下方留空表示不修改；仅填空格再保存可清除。"
        : "配置 Cookie 可立即拉取历史帖子；不配置则需先发布 1 条帖子，系统会自动识别用户名";
    }
  } else {
    $("#apiKeyHint").textContent = "编辑已有账号时留空表示不修改";
  }
  showAccountFormMessage(
    isEdit && acc?.hasApiKey ? "编辑模式：API Key 留空不会丢失，验证将使用已保存的 Key。" : "",
    isEdit && acc?.hasApiKey ? "info" : "",
  );
  openAppModal("accountModal");
}

function formatRemotePostTime(ts) {
  if (!ts) return "未知时间";
  return formatTime(ts);
}

function canFetchAccountHistory(accountId) {
  const acc = accountStore.accounts.find((a) => a.id === accountId);
  const postRef = findLocalPostRefForAccount(accountId);
  return Boolean(postRef || acc?.hasCookie || acc?.username || acc?.hasSquareUid || acc?.hasAnchorPost);
}

function renderPublishedPostsList(posts, emptyText = "暂无已发布帖子") {
  const list = $("#publishedPostsList");
  if (!posts.length) {
    list.innerHTML = `<div class="account-empty">${escapeHtml(emptyText)}</div>`;
    return;
  }

  list.innerHTML = posts
    .map(
      (post) => `
    <div class="published-post-item">
      <div class="post-text">${escapeHtml(postPreview(post.text, 180))}</div>
      <div class="published-post-meta">
        ${post.title ? `<span>标题: ${escapeHtml(post.title)}</span>` : ""}
        <span>${formatRemotePostTime(post.publishedAt)}</span>
        <span>浏览 ${post.viewCount ?? "-"}</span>
        <span>点赞 ${post.likeCount ?? "-"}</span>
        <span>评论 ${post.commentCount ?? "-"}</span>
        ${post.shareLink ? `<a href="${post.shareLink}" target="_blank" rel="noopener">查看</a>` : ""}
      </div>
    </div>`
    )
    .join("");
}

function findLocalPostRefForAccount(accountId) {
  const defaultId = getDefaultAccountId();
  const post = posts.find((p) => {
    if (p.publishState !== "published") return false;
    if (!(p.result?.id || p.result?.shareLink)) return false;
    if (p.accountId === accountId) return true;
    if (!p.accountId && accountId === defaultId) return true;
    return false;
  });
  return post?.result?.id || extractPostIdFromRef(post?.result?.shareLink) || post?.result?.shareLink || null;
}

function extractPostIdFromRef(ref) {
  if (!ref) return null;
  const value = String(ref).trim();
  if (/^\d+$/.test(value)) return value;
  const m = value.match(/\/post\/(\d+)/i);
  return m ? m[1] : null;
}

function localPublishedPostsForAccount(accountId) {
  const defaultId = getDefaultAccountId();
  return posts
    .filter((p) => {
      if (p.publishState !== "published") return false;
      const ref = p.result?.id || p.result?.shareLink;
      if (!ref) return false;
      if (p.accountId === accountId) return true;
      if (!p.accountId && accountId === defaultId) return true;
      return false;
    })
    .map((p) => ({
      id: p.result.id || extractPostIdFromRef(p.result.shareLink),
      text: p.text,
      title: p.title || "",
      shareLink: p.result.shareLink,
      publishedAt: p.publishedAt || Date.now(),
      viewCount: p.stats?.viewCount ?? null,
      likeCount: p.stats?.likeCount ?? null,
      commentCount: p.stats?.commentCount ?? null,
      shareCount: p.stats?.shareCount ?? null,
      source: "local",
    }));
}

async function syncPublishedPostsToServerCache(accountId, list) {
  if (!accountId || !list?.length) return;
  try {
    await fetch(`/api/accounts/${encodeURIComponent(accountId)}/posts/cache`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ posts: list }),
    });
  } catch {
    // ignore sync errors
  }
}

async function syncAllLocalPublishedToCache() {
  const defaultId = getDefaultAccountId();
  if (!defaultId) return;
  const byAccount = {};
  for (const p of posts) {
    const postId = p.result?.id || extractPostIdFromRef(p.result?.shareLink);
    if (p.publishState !== "published" || !postId) continue;
    const aid = p.accountId || defaultId;
    if (!byAccount[aid]) byAccount[aid] = [];
    byAccount[aid].push({
      id: postId,
      text: p.text,
      title: p.title || "",
      shareLink: p.result.shareLink,
      publishedAt: p.publishedAt || Date.now(),
      viewCount: p.stats?.viewCount ?? null,
      likeCount: p.stats?.likeCount ?? null,
      commentCount: p.stats?.commentCount ?? null,
      shareCount: p.stats?.shareCount ?? null,
      source: "local",
    });
  }
  await Promise.all(
    Object.entries(byAccount).map(([accountId, list]) => syncPublishedPostsToServerCache(accountId, list)),
  );
}

function showPublishedPostsEmptyState(accountId, { statusMessage = NO_HISTORY_DETECTED_MSG, listMessage = NO_HISTORY_DETECTED_MSG } = {}) {
  publishedPostsCache = { accountId, posts: [] };
  renderAccountSelectOptions($("#publishedPostsAccountSelect"), accountId);
  const picker = document.querySelector(".published-posts-account-picker");
  if (picker) picker.classList.toggle("hidden", accountStore.accounts.length <= 1);
  $("#publishedPostsTitle").textContent = `${getAccountName(accountId)} · 广场历史帖子`;
  $("#publishedPostsSubtitle").textContent = "";
  $("#publishedPostsStatus").textContent = statusMessage;
  $("#publishedPostsStatus").className = "message info";
  renderPublishedPostsList([], listMessage);
  $("#btnImportPublishedPosts").disabled = true;
  openAppModal("publishedPostsModal");
}

function showAccountNeedsPublishHint(accountId) {
  showPublishedPostsEmptyState(accountId, {
    statusMessage:
      "该功能需要发布成功一条帖子才能拉取历史。请先使用本工具发布至少 1 条帖子，系统将从该帖子自动识别用户名；也可配置 Cookie 或填写广场用户名。",
    listMessage: NO_HISTORY_DETECTED_MSG,
  });
}

async function fetchHistoryForCurrentAccount() {
  const accountId = $("#historyAccountSelect")?.value || getDefaultAccountId();
  if (!accountId) return alert("请先添加账号");
  const accountName = getAccountName(accountId);
  if (!confirm(`拉取「${accountName}」的广场历史帖子\n\n${HISTORY_FETCH_CONFIRM_MSG}`)) return;

  if (!canFetchAccountHistory(accountId)) {
    showPublishedPostsEmptyState(accountId);
    return;
  }

  const postRef = findLocalPostRefForAccount(accountId);
  await showPublishedPostsModal(accountId, { postRef });
}

async function reloadPublishedPostsForSelectedAccount() {
  const accountId = $("#publishedPostsAccountSelect")?.value;
  if (!accountId) return;
  if (!canFetchAccountHistory(accountId)) {
    showPublishedPostsEmptyState(accountId);
    return;
  }
  const postRef = findLocalPostRefForAccount(accountId);
  await showPublishedPostsModal(accountId, { postRef });
}

async function discoverAccountFromPost(accountId, postRef) {
  if (!accountId || !postRef) return null;
  const before = accountStore.accounts.find((a) => a.id === accountId);
  const hadIdentity = Boolean(before?.username || before?.hasSquareUid || before?.hasAnchorPost);

  const res = await fetch(`/api/accounts/${encodeURIComponent(accountId)}/discover-from-post`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ postRef }),
  });
  const data = await res.json();
  if (!res.ok) return null;

  await loadAccounts();
  return { ...data, firstDiscovery: !hadIdentity };
}

async function showPublishedPostsModal(accountId, { postRef } = {}) {
  publishedPostsCache = { accountId, posts: [] };
  const accountName = getAccountName(accountId);
  renderAccountSelectOptions($("#publishedPostsAccountSelect"), accountId);
  const picker = document.querySelector(".published-posts-account-picker");
  if (picker) picker.classList.toggle("hidden", accountStore.accounts.length <= 1);
  $("#publishedPostsTitle").textContent = `${accountName} · 广场历史帖子`;
  $("#publishedPostsSubtitle").textContent = "正在从币安广场拉取...";
  $("#publishedPostsStatus").textContent = "正在加载已发布帖子，请稍候...";
  $("#publishedPostsStatus").className = "message info";
  $("#publishedPostsList").innerHTML = "";
  $("#btnImportPublishedPosts").disabled = true;
  openAppModal("publishedPostsModal");

  try {
    const ref = postRef || findLocalPostRefForAccount(accountId);
    let url = `/api/accounts/${encodeURIComponent(accountId)}/posts?limit=20`;
    if (ref) url += `&postRef=${encodeURIComponent(ref)}`;

    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok) {
      const err = new Error(data.error || "加载失败");
      err.code = data.code;
      throw err;
    }

    publishedPostsCache = { accountId, posts: data.posts || [] };
    await loadAccounts();

    const identity = [
      data.displayName,
      data.username ? `@${data.username}` : "",
      data.discoveredFromPost ? "通过已发布帖子识别" : "",
      data.source === "cache" ? "本地缓存" : data.source === "openApi" ? "OpenAPI" : data.source === "browser" ? "广场 API" : "",
    ]
      .filter(Boolean)
      .join(" · ");
    $("#publishedPostsSubtitle").textContent = identity
      ? `${identity} · 共 ${publishedPostsCache.posts.length} 条`
      : `共 ${publishedPostsCache.posts.length} 条`;

    let statusText = "";
    let statusClass = "message info";
    if (data.remoteError && data.fromCache) {
      statusText = `${data.hint || "远程拉取失败"}：${data.remoteError}`;
      statusClass = publishedPostsCache.posts.length ? "message ok" : "message err";
    } else if (data.hint && !publishedPostsCache.posts.length) {
      statusText = data.hint;
    } else if (data.hint && publishedPostsCache.posts.length) {
      statusText = data.hint;
      statusClass = "message ok";
    } else {
      const hasIdentity = Boolean(
        data.username || data.squareUid || data.displayName || data.discoveredFromPost || data.source,
      );
      statusText = publishedPostsCache.posts.length
        ? "以下为该账号在币安广场已发布的帖子，可导入到本地列表查看互动数据"
        : hasIdentity
          ? "该账号暂无已发布的广场帖子"
          : NO_HISTORY_DETECTED_MSG;
    }
    $("#publishedPostsStatus").textContent = statusText;
    $("#publishedPostsStatus").className = statusClass;

    const listEmptyText = publishedPostsCache.posts.length
      ? "暂无已发布帖子"
      : statusText.includes("暂无已发布")
        ? "该账号暂无已发布的广场帖子"
        : NO_HISTORY_DETECTED_MSG;
    renderPublishedPostsList(publishedPostsCache.posts, listEmptyText);
    $("#btnImportPublishedPosts").disabled = publishedPostsCache.posts.length === 0;
  } catch (err) {
    const localFallback = localPublishedPostsForAccount(accountId);
    if (localFallback.length) {
      await syncPublishedPostsToServerCache(accountId, localFallback);
      publishedPostsCache = { accountId, posts: localFallback };
      $("#publishedPostsStatus").textContent = `远程拉取失败，已显示本地记录（${localFallback.length} 条）并写入缓存`;
      $("#publishedPostsStatus").className = "message ok";
      $("#publishedPostsSubtitle").textContent = `本地缓存 · 共 ${localFallback.length} 条`;
      renderPublishedPostsList(localFallback);
      $("#btnImportPublishedPosts").disabled = false;
      return;
    }
    const isNeedPublish = err.code === "NEED_PUBLISH_FIRST";
    $("#publishedPostsStatus").textContent = isNeedPublish
      ? "该功能需要发布成功一条帖子才能拉取，否则系统获取不到历史发布的帖子"
      : err.message;
    $("#publishedPostsStatus").className = isNeedPublish ? "message info" : "message err";
    $("#publishedPostsSubtitle").textContent = "";
    renderPublishedPostsList([], isNeedPublish ? NO_HISTORY_DETECTED_MSG : "拉取失败");
  }
}

function importPublishedPostsToList() {
  const { accountId, posts: remotePosts } = publishedPostsCache;
  if (!accountId || !remotePosts.length) {
    showAppToast("没有可导入的帖子，请先拉取广场历史帖子", "info");
    return;
  }

  const accountName = getAccountName(accountId);
  const existingIds = new Set(
    posts.map((p) => p.result?.id).filter(Boolean).map(String)
  );
  let imported = 0;

  try {
    for (const rp of remotePosts) {
      if (!rp.id || existingIds.has(String(rp.id))) continue;
      existingIds.add(String(rp.id));
      posts.push({
        id: generateId(),
        text: rp.text || "",
        title: rp.title || "",
        imagePaths: [],
        accountId,
        accountName,
        selected: false,
        publishState: "published",
        result: { id: rp.id, shareLink: rp.shareLink },
        error: null,
        publishedAt: rp.publishedAt || Date.now(),
        createdAt: Date.now(),
        stats: {
          viewCount: rp.viewCount,
          likeCount: rp.likeCount,
          commentCount: rp.commentCount,
          shareCount: rp.shareCount,
          fetchedAt: Date.now(),
        },
      });
      imported++;
    }

    saveDrafts();
  } catch (err) {
    console.error("importPublishedPostsToList failed:", err);
    showAppToast(`导入失败：${err.message || "保存本地数据出错"}`, "err");
    $("#publishedPostsStatus").textContent = `导入失败：${err.message || "保存本地数据出错"}`;
    $("#publishedPostsStatus").className = "message err";
    return;
  }

  const message =
    imported > 0 ? `已成功导入 ${imported} 条帖子到已发布列表` : "帖子已在列表中，无需重复导入";
  const logType = imported > 0 ? "ok" : "info";
  const statusType = imported > 0 ? "ok" : "info";

  $("#publishedPostsStatus").textContent = message;
  $("#publishedPostsStatus").className = `message ${statusType}`;
  appendSystemLog(message, logType);

  if (imported > 0) {
    $("#publishedPostsModal").close();
    switchView("published");
    showPublishedImportStatus(message, statusType);
    setTimeout(() => showAppToast(message, statusType), 50);
    return;
  }

  showAppToast(message, statusType);
}

async function saveAccountFromModal() {
  const accountId = $("#editAccountId").value;
  const name = $("#accountNameInput").value.trim();
  const username = $("#accountUsernameInput").value.trim();
  const proxyConfig = collectAccountProxyFromUI();
  const apiKey = $("#accountApiKeyInput").value.trim();
  const cookieRaw = $("#accountCookieInput").value;
  const existing = accountId ? accountStore.accounts.find((a) => a.id === accountId) : null;

  if (!name) return showAccountFormMessage("请输入账号名称", "err");
  if (!accountId && !apiKey) return showAccountFormMessage("请输入 API Key", "err");
  if (accountId && !apiKey && !existing?.hasApiKey) {
    return showAccountFormMessage("该账号还没有 API Key，请填写后再保存", "err");
  }
  if (["http", "https", "socks5", "ssh"].includes(proxyConfig.type)) {
    if (!proxyConfig.host || !proxyConfig.port) {
      return showAccountFormMessage("请填写代理主机和端口", "err");
    }
  }

  const payload = { name, username, proxyConfig };
  // 仅当用户明确填写了新 Key 才更新；留空绝对不传，防止覆盖
  if (apiKey) payload.apiKey = apiKey;
  if (accountId) {
    if (cookieRaw.length > 0 && cookieRaw.trim() === "") payload.cookie = "";
    else if (cookieRaw !== "") payload.cookie = cookieRaw.trim();
  } else if (cookieRaw.trim()) {
    payload.cookie = cookieRaw.trim();
  }

  try {
    const url = accountId ? `/api/accounts/${encodeURIComponent(accountId)}` : "/api/accounts";
    const res = await fetch(url, {
      method: accountId ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "保存失败");

    const savedId = accountId || data.account?.id;
    closeAppModals();
    await loadAccounts();
    await loadConfig();
    showAccountMessage(accountId ? "账号已更新" : "账号已添加", "ok");

    if (!savedId) return;

    const acc = accountStore.accounts.find((a) => a.id === savedId);
    const postRef = findLocalPostRefForAccount(savedId);
    const canTryFetch = postRef || acc?.hasCookie || acc?.username || acc?.hasSquareUid || acc?.hasAnchorPost;

    if (canTryFetch) {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await showPublishedPostsModal(savedId, { postRef });
    } else {
      showAccountNeedsPublishHint(savedId);
    }
  } catch (err) {
    showAccountFormMessage(err.message, "err");
  }
}

async function deleteAccount(accountId) {
  const name = getAccountName(accountId);
  if (!confirm(`确定删除账号「${name}」？`)) return;
  try {
    const res = await fetch(`/api/accounts/${encodeURIComponent(accountId)}`, { method: "DELETE" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "删除失败");
    await loadAccounts();
    await loadConfig();
    showAccountMessage("账号已删除", "ok");
  } catch (err) {
    showAccountMessage(err.message, "err");
  }
}

function applySuggestedProxyType(scope, suggestedType) {
  if (!["http", "https", "socks5"].includes(suggestedType)) return false;
  const select = proxyEl(PROXY_UI[scope]?.prefix, "TypeSelect");
  if (!select) return false;
  if (select.value === suggestedType) {
    updateProxyDetailsVisibility(scope);
    if (scope === "account") updateAccountProxyModeTip(suggestedType);
    return false;
  }
  select.value = suggestedType;
  // 同步绿色状态条与详情区，确保用户能立刻看到切换结果
  updateProxyDetailsVisibility(scope);
  if (scope === "account") updateAccountProxyModeTip(suggestedType);
  select.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

function maybeApplyProbeProxyType(scope, data, currentType) {
  const suggested = data?.suggestedProxyType;
  if (!suggested) return false;
  if (suggested === currentType && !data.typeCorrected) return false;
  return applySuggestedProxyType(scope, suggested);
}

async function testAccountProxy() {
  const btn = $("#btnTestAccountProxy");
  const accountId = ($("#editAccountId").value || "").trim() || undefined;
  const proxyConfig = collectAccountProxyFromUI();
  const existing = accountId ? accountStore.accounts.find((a) => a.id === accountId) : null;
  const useSavedProxyPassword = !Object.prototype.hasOwnProperty.call(proxyConfig, "password");
  if (!["http", "https", "socks5", "ssh"].includes(proxyConfig.type)) {
    showAccountFormMessage("请先选择自定义代理类型（Socks5 / HTTP 等）", "err");
    return;
  }
  if (!proxyConfig.host || !proxyConfig.port) {
    showAccountFormMessage("请填写代理主机和端口", "err");
    return;
  }
  if (
    useSavedProxyPassword &&
    accountId &&
    existing?.proxyConfig?.hasPassword === false &&
    String(proxyConfig.username || "").trim()
  ) {
    showAccountFormMessage("已填写代理账号但未保存密码，请填写密码后再检测", "err");
    return;
  }
  const prevText = btn?.textContent || "检测代理";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "检测中…";
  }
  showAccountFormMessage(
    useSavedProxyPassword && accountId && existing?.proxyConfig?.hasPassword
      ? "正在用已保存的代理密码快速检测…"
      : "正在快速检测代理出网…",
    "info",
  );
  try {
    const res = await fetch("/api/config/network-test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        proxyConfig,
        accountId,
        useSavedProxyPassword: Boolean(
          useSavedProxyPassword && accountId && existing?.proxyConfig?.hasPassword,
        ),
      }),
    });
    const data = await res.json();
    const switched = maybeApplyProbeProxyType("account", data, proxyConfig.type);
    let msg = data.message || data.error || "代理检测失败";
    if (switched) {
      msg = `${msg}（「代理方式」已自动切换为 ${String(data.suggestedProxyType).toUpperCase()}）`;
    }
    showAccountFormMessage(msg, data.ok ? "ok" : "err");
  } catch {
    showAccountFormMessage("无法连接本地服务", "err");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = prevText;
    }
  }
}

function isBlankApiKeyInput(value) {
  const text = String(value ?? "").trim();
  if (!text) return true;
  if (/^\*+$/.test(text) || /^•+$/.test(text)) return true;
  if (/已保存|留空不修改|粘贴 Square/i.test(text)) return true;
  // 误把脱敏 Key（如 abcd...wxyz）当真 Key 提交
  if (/^[A-Za-z0-9_-]{2,8}\.{3}[A-Za-z0-9_-]{2,8}$/.test(text)) return true;
  return false;
}

async function testAccountKey() {
  const btn = $("#btnTestAccountKey");
  const accountId = ($("#editAccountId").value || "").trim();
  const rawApiKey = $("#accountApiKeyInput").value;
  const apiKey = isBlankApiKeyInput(rawApiKey) ? "" : String(rawApiKey).trim();
  const proxyConfig = collectAccountProxyFromUI();
  const existing = accountId ? accountStore.accounts.find((a) => a.id === accountId) : null;
  const useSavedApiKey = !apiKey && Boolean(accountId);

  if (!apiKey && !accountId) {
    showAccountFormMessage("请先填写 API Key", "err");
    return;
  }
  if (useSavedApiKey && !existing?.hasApiKey) {
    showAccountFormMessage("该账号尚未保存 API Key，请先粘贴 Key 再验证", "err");
    return;
  }
  if (["http", "https", "socks5", "ssh"].includes(proxyConfig.type) && (!proxyConfig.host || !proxyConfig.port)) {
    showAccountFormMessage("已选独立代理，请先填写代理主机和端口", "err");
    return;
  }

  const prevText = btn?.textContent || "验证 Key";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "验证中…";
  }
  const viaProxy = ["http", "https", "socks5", "ssh"].includes(proxyConfig.type);
  showAccountFormMessage(
    useSavedApiKey
      ? viaProxy
        ? `正在用已保存的 Key（${existing?.maskedKey || "***"}）经代理验证币安（不稳定时会自动重试）…`
        : `正在用已保存的 Key（${existing?.maskedKey || "***"}）验证…`
      : viaProxy
        ? "正在经代理验证新填写的 Key（不稳定时会自动重试）…"
        : "正在验证新填写的 Key…",
    "info",
  );

  try {
    const res = await fetch("/api/config/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(apiKey ? { apiKey } : {}),
        ...(accountId ? { accountId } : {}),
        useSavedApiKey,
        proxyConfig,
      }),
    });
    const data = await res.json();
    if (res.ok) {
      showAccountFormMessage(data.message || "API Key 验证成功（已连通币安）", "ok");
    } else {
      const err = data.error || "验证失败";
      const needPrefix = !/币安|API Key|未配置|未授权|访问被拒绝|偶发|自动重试/.test(err);
      showAccountFormMessage(needPrefix ? `连接币安验证 Key 失败：${err}` : err, "err");
    }
  } catch {
    showAccountFormMessage("请求失败，请检查本地服务是否运行", "err");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = prevText;
    }
  }
}

function showAccountMessage(msg, type) {
  const el = $("#accountMessage");
  if (!el) return;
  el.textContent = msg;
  el.className = `message ${type}`;
}

function showAccountFormMessage(msg, type) {
  const el = $("#accountFormMessage");
  if (!el) return;
  el.textContent = msg;
  el.className = msg ? `message ${type}` : "message";
}

async function saveProxy() {
  const proxyConfig = collectProxyFromUI("global");
  if (["http", "https", "socks5", "ssh"].includes(proxyConfig.type)) {
    if (!proxyConfig.host || !proxyConfig.port) {
      showProxyMessage("请填写代理主机和端口", "err");
      return;
    }
  }
  try {
    const res = await fetch("/api/config/proxy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ proxyConfig }),
    });
    const data = await res.json();
    if (res.ok && data.proxyConfig) {
      globalProxyConfig = data.proxyConfig;
      applyProxyToUI("global", data.proxyConfig);
    }
    showProxyMessage(res.ok ? "全局代理已保存" : data.error || "保存失败", res.ok ? "ok" : "err");
    updateApiStatusCard({ proxyConfig: data.proxyConfig || globalProxyConfig });
  } catch {
    showProxyMessage("无法连接本地服务", "err");
  }
}

function showDataDirMessage(msg, type) {
  const el = $("#dataDirMessage");
  if (!el) return;
  el.textContent = msg || "";
  el.className = msg ? `message ${type}` : "message";
}

function applyDataDirToUI(info = {}) {
  const hint = $("#dataDirHint");
  const input = $("#dataDirInput");
  const pickBtn = $("#btnPickDataDir");
  const restartBtn = $("#btnRestartApp");
  const currentDir = info.currentDir || "";
  const defaultDir = info.defaultDir || currentDir;
  const canPick = Boolean(info.canPickFolder || window.desktopApi?.isDesktop);

  if (hint && currentDir) {
    const tag = info.isCustom ? "自定义" : "默认";
    hint.textContent = `当前数据目录（${tag}）：${currentDir}`;
  }
  if (input) {
    input.value = info.customDir || currentDir || defaultDir || "";
    if (defaultDir) input.placeholder = defaultDir;
  }
  if (pickBtn) pickBtn.classList.toggle("hidden", !canPick);
  if (restartBtn) restartBtn.classList.add("hidden");
}

async function refreshDataDirInfo() {
  try {
    const res = await fetch("/api/config/data-dir");
    if (!res.ok) return;
    applyDataDirToUI(await res.json());
  } catch {
    // ignore
  }
}

async function pickDataDir() {
  if (window.desktopApi?.pickDirectory) {
    try {
      const picked = await window.desktopApi.pickDirectory();
      if (picked && $("#dataDirInput")) $("#dataDirInput").value = picked;
    } catch {
      showDataDirMessage("无法打开文件夹选择器", "err");
    }
    return;
  }
  showDataDirMessage("请直接在输入框粘贴绝对路径（例如 D:\\数据\\binance-square）", "info");
}

async function saveDataDir() {
  const dirPath = ($("#dataDirInput")?.value || "").trim();
  if (!dirPath) {
    showDataDirMessage("请填写或选择数据保存目录", "err");
    return;
  }
  if (
    !confirm(
      `确定将数据目录改为：\n${dirPath}\n\n现有数据将复制到新目录（同名文件不覆盖），之后需重启应用才能完全生效。`,
    )
  ) {
    return;
  }
  showDataDirMessage("正在迁移数据…", "info");
  try {
    const res = await fetch("/api/config/data-dir", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: dirPath, migrate: true }),
    });
    const data = await res.json();
    if (!res.ok) {
      showDataDirMessage(data.error || "设置失败", "err");
      return;
    }
    showDataDirMessage(data.message || "数据目录已更新", "ok");
    await refreshDataDirInfo();
    $("#btnRestartApp")?.classList.remove("hidden");
  } catch {
    showDataDirMessage("无法连接本地服务", "err");
  }
}

async function resetDataDir() {
  if (!confirm("确定恢复为默认数据目录？现有数据将复制回默认位置，之后需重启应用才能完全生效。")) {
    return;
  }
  showDataDirMessage("正在恢复默认目录…", "info");
  try {
    const res = await fetch("/api/config/data-dir/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ migrate: true }),
    });
    const data = await res.json();
    if (!res.ok) {
      showDataDirMessage(data.error || "恢复失败", "err");
      return;
    }
    showDataDirMessage(data.message || "已恢复默认目录", "ok");
    await refreshDataDirInfo();
    $("#btnRestartApp")?.classList.remove("hidden");
  } catch {
    showDataDirMessage("无法连接本地服务", "err");
  }
}

function restartAppForDataDir() {
  if (window.desktopApi?.restartApp) {
    window.desktopApi.restartApp();
    return;
  }
  showDataDirMessage("请手动关闭并重新启动本软件", "info");
}

function formatUpdateBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function renderAppVersionText() {
  const el = $("#appVersionText");
  if (!el) return;
  el.textContent = desktopUpdateState.currentVersion
    ? `当前版本：v${desktopUpdateState.currentVersion}`
    : "当前版本：未知";
}

function showUpdateSettingsMessage(msg, type) {
  const el = $("#appUpdateSettingsMessage");
  if (!el) return;
  el.textContent = msg || "";
  el.className = msg ? `message ${type}` : "message";
}

function setUpdateModalMessage(msg, type) {
  const el = $("#updateModalMessage");
  if (!el) return;
  el.textContent = msg || "";
  el.className = msg ? `message ${type}` : "message";
}

function shouldPromptForUpdate(version) {
  if (!version) return false;
  return localStorage.getItem(SKIPPED_UPDATE_VERSION_KEY) !== version;
}

function openUpdateModal(info = {}) {
  const version = info.version || desktopUpdateState.availableVersion || "";
  desktopUpdateState.availableVersion = version;
  if ($("#updateModalTitle")) {
    $("#updateModalTitle").textContent = version ? `发现新版本 v${version}` : "发现新版本";
  }
  if ($("#updateModalVersion")) {
    const current = desktopUpdateState.currentVersion ? `v${desktopUpdateState.currentVersion}` : "当前版本";
    $("#updateModalVersion").textContent = version
      ? `${current} → v${version}`
      : "有新版本可供安装";
  }
  const notesEl = $("#updateModalNotes");
  if (notesEl) {
    notesEl.textContent = "修复部分BUG";
    notesEl.classList.remove("hidden");
  }
  $("#updateProgressWrap")?.classList.add("hidden");
  $("#btnUpdateInstall")?.classList.add("hidden");
  $("#btnUpdateDownload")?.classList.remove("hidden");
  $("#btnUpdateLater")?.classList.remove("hidden");
  setUpdateModalMessage("", "");
  openAppModal("updateModal");
}

function showUpdateProgress(payload = {}) {
  $("#updateProgressWrap")?.classList.remove("hidden");
  $("#btnUpdateDownload")?.classList.add("hidden");
  $("#btnUpdateLater")?.classList.add("hidden");
  const percent = Math.max(0, Math.min(100, Number(payload.percent) || 0));
  if ($("#updateProgressFill")) $("#updateProgressFill").style.width = `${percent.toFixed(1)}%`;
  if ($("#updateProgressText")) {
    const transferred = formatUpdateBytes(payload.transferred);
    const total = formatUpdateBytes(payload.total);
    $("#updateProgressText").textContent = `正在下载更新… ${percent.toFixed(1)}%（${transferred} / ${total}）`;
  }
  setUpdateModalMessage("", "");
  if (!$("#updateModal")?.open) openAppModal("updateModal");
}

function showUpdateDownloaded(info = {}) {
  const version = info.version || desktopUpdateState.availableVersion || "";
  $("#updateProgressWrap")?.classList.add("hidden");
  $("#btnUpdateDownload")?.classList.add("hidden");
  $("#btnUpdateLater")?.classList.add("hidden");
  $("#btnUpdateInstall")?.classList.remove("hidden");
  setUpdateModalMessage(`v${version || "新版本"} 已下载完成，重启后将自动安装。`, "ok");
  if (!$("#updateModal")?.open) openAppModal("updateModal");
  showUpdateSettingsMessage("更新包已下载，可点击「重启并安装」", "ok");
}

function dismissUpdateModal(rememberSkip = false) {
  if (rememberSkip && desktopUpdateState.availableVersion) {
    localStorage.setItem(SKIPPED_UPDATE_VERSION_KEY, desktopUpdateState.availableVersion);
  }
  $("#updateModal")?.close();
}

function handleDesktopUpdateStatus(payload = {}) {
  const phase = payload.phase;
  if (phase === "checking") {
    showUpdateSettingsMessage("正在检查更新…", "info");
    return;
  }
  if (phase === "not-available") {
    manualUpdateCheckPending = false;
    showUpdateSettingsMessage("当前已是最新版本", "ok");
    return;
  }
  if (phase === "error") {
    manualUpdateCheckPending = false;
    const msg = payload.message || "检查更新失败";
    showUpdateSettingsMessage(msg, "err");
    setUpdateModalMessage(msg, "err");
    return;
  }
  if (phase === "available") {
    desktopUpdateState.availableVersion = payload.info?.version || "";
    showUpdateSettingsMessage(`发现新版本 v${desktopUpdateState.availableVersion}`, "ok");
    if (manualUpdateCheckPending || shouldPromptForUpdate(desktopUpdateState.availableVersion)) {
      openUpdateModal(payload.info || {});
    }
    manualUpdateCheckPending = false;
    return;
  }
  if (phase === "progress") {
    showUpdateProgress(payload);
    return;
  }
  if (phase === "downloaded") {
    manualUpdateCheckPending = false;
    showUpdateDownloaded(payload.info || {});
  }
}

async function manualCheckForUpdates() {
  if (!window.desktopApi?.checkForUpdates) {
    showUpdateSettingsMessage("仅桌面安装版支持自动更新", "info");
    return;
  }
  manualUpdateCheckPending = true;
  showUpdateSettingsMessage("正在检查更新…", "info");
  try {
    const result = await window.desktopApi.checkForUpdates();
    if (result?.reason === "dev") {
      manualUpdateCheckPending = false;
      showUpdateSettingsMessage("开发模式不支持自动更新", "info");
    }
  } catch (err) {
    manualUpdateCheckPending = false;
    showUpdateSettingsMessage(err.message || "检查更新失败", "err");
  }
}

async function startUpdateDownload() {
  if (!window.desktopApi?.downloadUpdate) return;
  setUpdateModalMessage("正在准备下载…", "info");
  try {
    await window.desktopApi.downloadUpdate();
  } catch (err) {
    setUpdateModalMessage(err.message || "下载失败", "err");
  }
}

function installDownloadedUpdate() {
  if (!window.desktopApi?.installUpdate) return;
  window.desktopApi.installUpdate();
}

function initDesktopUpdater() {
  const panel = $("#appUpdatePanel");
  if (!window.desktopApi?.isDesktop) {
    panel?.classList.add("hidden");
    return;
  }
  window.desktopApi
    .getAppVersion()
    .then((info) => {
      desktopUpdateState.currentVersion = info?.version || "";
      renderAppVersionText();
    })
    .catch(() => renderAppVersionText());
  window.desktopApi.onUpdateStatus?.(handleDesktopUpdateStatus);
}

async function testNetwork() {
  const proxyConfig = collectProxyFromUI("global");
  const useSavedProxyPassword = !Object.prototype.hasOwnProperty.call(proxyConfig, "password");
  if (
    useSavedProxyPassword &&
    globalProxyConfig?.hasPassword === false &&
    String(proxyConfig.username || "").trim()
  ) {
    showProxyMessage("已填写代理账号但未填写密码。请填写密码，或清空账号后再检测。", "err");
    return;
  }
  showProxyMessage(
    ["http", "https", "socks5", "ssh"].includes(proxyConfig.type)
      ? useSavedProxyPassword && globalProxyConfig?.hasPassword
        ? "正在用已保存的代理密码快速检测…"
        : "正在快速检测代理出网…"
      : "正在测试网络…",
    "info",
  );
  try {
    const res = await fetch("/api/config/network-test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        proxyConfig,
        useSavedProxyPassword: Boolean(useSavedProxyPassword && globalProxyConfig?.hasPassword),
      }),
    });
    const data = await res.json();
    const switched = maybeApplyProbeProxyType("global", data, proxyConfig.type);
    let msg = data.message || data.error || "网络测试失败";
    if (switched) {
      msg = `${msg}（「代理方式」已自动切换为 ${String(data.suggestedProxyType).toUpperCase()}）`;
    }
    showProxyMessage(msg, data.ok ? "ok" : "err");
  } catch {
    showProxyMessage("无法连接本地服务", "err");
  }
}

function showProxyMessage(msg, type) {
  const el = $("#proxyMessage");
  if (!el) return;
  el.textContent = msg;
  el.className = msg ? `message ${type}` : "message";
}

function showBrowserMessage(msg, type) {
  const el = $("#browserMessage");
  if (!el) return;
  el.textContent = msg;
  el.className = msg ? `message ${type}` : "message";
}

async function saveBrowserPath() {
  const browserPath = ($("#browserPathInput")?.value || "").trim();
  try {
    const res = await fetch("/api/config/browser", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ browserPath }),
    });
    const data = await res.json();
    showBrowserMessage(
      res.ok ? (browserPath ? "浏览器路径已保存" : "已清除自定义路径，将使用 Playwright 内置浏览器") : data.error || "保存失败",
      res.ok ? "ok" : "err",
    );
  } catch {
    showBrowserMessage("无法连接本地服务", "err");
  }
}

async function testBrowser() {
  const browserPath = ($("#browserPathInput")?.value || "").trim();
  showBrowserMessage("正在测试浏览器启动...", "info");
  try {
    const res = await fetch("/api/config/browser/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ browserPath }),
    });
    const data = await res.json();
    showBrowserMessage(res.ok ? data.message : data.error || "测试失败", res.ok ? "ok" : "err");
  } catch {
    showBrowserMessage("无法连接本地服务", "err");
  }
}

function showAiMessage(msg, type) {
  const el = $("#aiMessage");
  if (!el) return;
  el.textContent = msg;
  el.className = msg ? `message ${type}` : "message";
}

function formatTime(ts, compact = false) {
  if (!ts) return compact ? "" : "—";
  const d = new Date(ts);
  if (compact) {
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  return d.toLocaleString("zh-CN");
}

let aiRunning = false;
let aiCustomTokens = [];
/** @type {Record<string, string[]>} */
let aiHostedCustomTokens = {};
/** @type {{contentStyleOptions:Array,marketSentimentOptions:Array,availableTokens:Array}} */
let aiUiOptions = {
  contentStyleOptions: DEFAULT_CONTENT_STYLE_OPTIONS,
  marketSentimentOptions: DEFAULT_SENTIMENT_OPTIONS,
  availableTokens: DEFAULT_AVAILABLE_TOKENS,
};
/** @type {Array<{id:string,name:string,sampleText:string,createdAt?:number}>} */
let aiStyleReferencesCache = [];
/** @type {Set<string>} */
let aiHostedExpanded = new Set();
/** 完整托管账号列表缓存（搜索筛选时仍保留未显示行） */
let aiHostedAccountsCache = [];
/** @type {Array<{id:string,label:string,models:Array<{id:string,label:string}>,keyHint:string,keyUrl:string,defaultModel:string,allowCustomBaseUrl?:boolean,allowCustomModel?:boolean}>} */
let aiProvidersCache = [];
let aiProfilesCache = [];
let defaultAiProfileIdCache = null;

function buildLegacyAiProfileFromConfig(data = {}) {
  const id = data.defaultAiProfileId || "legacy-default";
  return {
    id,
    name: `${data.providerLabel || data.provider || "AI"}（默认）`,
    enabled: true,
    provider: data.provider || "zhipu",
    providerLabel: data.providerLabel || data.provider || "AI",
    baseUrl: data.baseUrl || "",
    model: data.model || "",
    hasApiKey: true,
    maskedKey: data.maskedKey || "",
    keyHint: data.keyHint,
    keyUrl: data.keyUrl,
    allowCustomBaseUrl: data.allowCustomBaseUrl,
    allowCustomModel: data.allowCustomModel,
    models: data.models,
    defaultModel: data.model,
    createdAt: Date.now(),
  };
}

function normalizeAiProfilesFromConfig(data = {}) {
  let profiles = [];
  const incoming = data.aiProfiles;
  if (Array.isArray(incoming) && incoming.length) {
    profiles = incoming.map((item) => ({
      ...item,
      hasApiKey: item.hasApiKey ?? Boolean(item.maskedKey || item.apiKey),
    }));
  }

  const hasLegacyKey = Boolean(data.hasApiKey || data.maskedKey);
  if (!profiles.some((item) => item.hasApiKey) && hasLegacyKey) {
    const legacyProfile = buildLegacyAiProfileFromConfig(data);
    const existingIndex = profiles.findIndex((item) => item.id === legacyProfile.id);
    if (existingIndex >= 0) {
      profiles[existingIndex] = { ...profiles[existingIndex], ...legacyProfile, hasApiKey: true };
    } else if (profiles.length) {
      profiles[0] = { ...profiles[0], ...legacyProfile, id: profiles[0].id, hasApiKey: true };
    } else {
      profiles = [legacyProfile];
    }
  }

  return profiles;
}

function buildHostedAccountsFallback(data = {}) {
  if (!accountStore.accounts.length) return [];
  const defaultId = data.accountId || getDefaultAccountId();
  return sortAccountsNewestFirst(accountStore.accounts).map((acc) => ({
    accountId: acc.id,
    accountName: acc.name,
    isDefault: acc.isDefault,
    enabled: acc.id === defaultId || Boolean(acc.isDefault),
    aiProfileId: null,
    selectedTokens: data.selectedTokens || [],
    customTokens: data.customTokens || [],
    marketSentiment: data.marketSentiment || "auto",
    contentStyles: data.contentStyles || ["casual"],
    articleCount: 0,
    viewCount: 0,
    likeCount: 0,
    commentCount: 0,
    commission: null,
    createdAt: acc.createdAt || null,
  }));
}

function sortAccountsNewestFirst(accounts = []) {
  return [...accounts].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

function normalizeHostedAccountsFromConfig(data = {}) {
  const hosted = data.hostedAccounts;
  if (Array.isArray(hosted) && hosted.length) {
    if (!accountStore.accounts.length) {
      return [...hosted].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    }
    const map = new Map(hosted.map((item) => [item.accountId, item]));
    return sortAccountsNewestFirst(accountStore.accounts).map((acc) => {
      const existing = map.get(acc.id);
      if (existing) {
        return {
          ...existing,
          accountName: existing.accountName || acc.name,
          isDefault: existing.isDefault ?? Boolean(acc.isDefault),
          createdAt: existing.createdAt || acc.createdAt || null,
          articleCount: existing.articleCount ?? 0,
          viewCount: existing.viewCount ?? 0,
          likeCount: existing.likeCount ?? 0,
          commentCount: existing.commentCount ?? 0,
          commission: existing.commission ?? null,
        };
      }
      return {
        accountId: acc.id,
        accountName: acc.name,
        isDefault: acc.isDefault,
        enabled: false,
        aiProfileId: null,
        selectedTokens: [],
        customTokens: [],
        marketSentiment: "auto",
        contentStyles: ["casual"],
        articleCount: 0,
        viewCount: 0,
        likeCount: 0,
        commentCount: 0,
        commission: null,
        createdAt: acc.createdAt || null,
      };
    });
  }
  return buildHostedAccountsFallback(data);
}

function normalizeAiConfigResponse(data) {
  if (!data) return data;
  const aiProfiles = normalizeAiProfilesFromConfig(data);
  const defaultAiProfileId = data.defaultAiProfileId || aiProfiles[0]?.id || null;
  const hostedAccounts = normalizeHostedAccountsFromConfig(data);
  const enabledAiProfileCount = aiProfiles.filter((item) => item.enabled && item.hasApiKey).length;
  const enabledHostedCount = hostedAccounts.filter((item) => item.enabled).length;
  return {
    ...data,
    aiProfiles,
    defaultAiProfileId,
    hostedAccounts,
    enabledAiProfileCount,
    enabledHostedCount,
    hasApiKey: data.hasApiKey || enabledAiProfileCount > 0,
  };
}

function getAiProviderFromCache(providerId) {
  return aiProvidersCache.find((item) => item.id === providerId) || aiProvidersCache[0] || null;
}

function renderAiProviderOptions(providers = [], selectedId = "zhipu", selectEl = null) {
  const select = selectEl || $("#aiProviderSelect");
  if (!select) return;
  if (providers.length) {
    aiProvidersCache = providers;
  }
  if (!aiProvidersCache.length) return;
  const value = aiProvidersCache.some((item) => item.id === selectedId) ? selectedId : aiProvidersCache[0].id;
  select.innerHTML = aiProvidersCache
    .map((item) => `<option value="${item.id}" ${item.id === value ? "selected" : ""}>${escapeHtml(item.label)}</option>`)
    .join("");
  select.value = value;
}

async function loadAiProvidersFallback() {
  if (aiProvidersCache.length) return aiProvidersCache;
  try {
    const res = await fetch("/ai-providers.json?v=1");
    if (res.ok) {
      const data = await res.json();
      if (data.providers?.length) {
        aiProvidersCache = data.providers;
        return aiProvidersCache;
      }
    }
  } catch {
    // ignore static fallback errors
  }
  return aiProvidersCache;
}

async function resolveAiProviders(apiProviders) {
  if (apiProviders?.length) return apiProviders;
  try {
    const res = await fetch("/api/ai/providers");
    if (res.ok) {
      const data = await res.json();
      if (data.providers?.length) {
        aiProvidersCache = data.providers;
        return aiProvidersCache;
      }
    }
  } catch {
    // ignore api fallback errors
  }
  return loadAiProvidersFallback();
}

function renderAiModelOptions(provider, selectedModel = "", selectEl = null) {
  const select = selectEl || $("#aiModelSelect");
  if (!select || !provider) return;
  if (!provider.models?.length) {
    select.innerHTML = `<option value="">请选择模型</option>`;
    return;
  }
  const fallback = provider.defaultModel || provider.models[0]?.id || "";
  const value = selectedModel && provider.models.some((item) => item.id === selectedModel) ? selectedModel : fallback;
  select.innerHTML = provider.models
    .map(
      (item) =>
        `<option value="${escapeHtml(item.id)}" ${item.id === value ? "selected" : ""}>${escapeHtml(item.label)}</option>`
    )
    .join("");
  select.value = value;
}

function updateAiProviderFields(provider, scope = "main") {
  if (!provider) return;

  const fieldMap = {
    main: {
      keyInput: "#aiApiKeyInput",
      keyLink: "#aiKeyHelpLink",
      baseUrlWrap: "#aiBaseUrlWrap",
      modelSelectWrap: "#aiModelSelectWrap",
      customModelWrap: "#aiCustomModelWrap",
    },
    profile: {
      keyInput: "#aiProfileApiKeyInput",
      keyLink: "#aiProfileKeyHelpLink",
      baseUrlWrap: "#aiProfileBaseUrlWrap",
      modelSelectWrap: "#aiProfileModelSelectWrap",
      customModelWrap: "#aiProfileCustomModelWrap",
    },
  };
  const fields = fieldMap[scope] || fieldMap.main;
  const keyInput = $(fields.keyInput);
  const keyLink = $(fields.keyLink);
  const baseUrlWrap = $(fields.baseUrlWrap);
  const modelSelectWrap = $(fields.modelSelectWrap);
  const customModelWrap = $(fields.customModelWrap);

  if (keyInput) {
    keyInput.placeholder =
      scope === "profile" && $("#aiProfileEditId")?.value
        ? `${provider.keyHint || "API Key"}（留空表示不修改）`
        : provider.keyHint || "API Key";
  }

  if (keyLink) {
    if (provider.keyUrl) {
      keyLink.href = provider.keyUrl;
      keyLink.textContent = `获取 ${provider.label} API Key`;
      keyLink.classList.remove("hidden");
    } else {
      keyLink.classList.add("hidden");
    }
  }

  baseUrlWrap?.classList.toggle("hidden", !provider.allowCustomBaseUrl);
  const isCustom = provider.id === "custom";
  modelSelectWrap?.classList.toggle("hidden", isCustom);
  customModelWrap?.classList.toggle("hidden", !isCustom);
}

function generateAiProfileId() {
  return `aip_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function getAiProfileModelFromUI() {
  const providerId = $("#aiProfileProviderSelect")?.value || "zhipu";
  if (providerId === "custom") {
    return $("#aiProfileCustomModelInput")?.value.trim() || "";
  }
  return $("#aiProfileModelSelect")?.value || "";
}

function onAiProfileProviderChange() {
  const provider = getAiProviderFromCache($("#aiProfileProviderSelect")?.value);
  if (!provider) return;
  renderAiModelOptions(provider, provider.defaultModel, $("#aiProfileModelSelect"));
  updateAiProviderFields(provider, "profile");
}

function buildAiProfileSelectOptions(selectedId, profiles = aiProfilesCache) {
  const enabled = profiles.filter((item) => item.enabled && item.hasApiKey);
  return `
    <option value="">默认 AI</option>
    ${enabled
      .map(
        (item) =>
          `<option value="${escapeHtml(item.id)}" ${item.id === selectedId ? "selected" : ""}>${escapeHtml(item.name)}</option>`,
      )
      .join("")}
  `;
}

function getAiProfileName(profileId) {
  if (!profileId) return "默认 AI";
  return aiProfilesCache.find((item) => item.id === profileId)?.name || "指定 AI";
}

function renderAiProfilesList(profiles = aiProfilesCache, defaultId = defaultAiProfileIdCache) {
  const container = $("#apiAiProfilesList");
  if (!container) return;

  if (!profiles.length) {
    container.innerHTML = `<div class="account-empty">尚未添加 AI API，点击「添加 AI API」开始配置</div>`;
    return;
  }

  container.innerHTML = profiles
    .map((profile) => {
      const isDefault = profile.id === defaultId;
      return `
      <div class="api-ai-profile-card ${profile.enabled ? "is-enabled" : ""} ${isDefault ? "is-default" : ""}" data-profile-id="${escapeHtml(profile.id)}">
        <div class="api-ai-profile-head">
          <div class="api-ai-profile-title">
            <strong>${escapeHtml(profile.name)}</strong>
            ${isDefault ? '<span class="badge badge-green account-default-badge">默认</span>' : ""}
            ${!profile.enabled ? '<span class="badge">已停用</span>' : ""}
          </div>
          <div class="api-ai-profile-actions">
            <button type="button" class="btn btn-ghost btn-sm" data-action="test" data-profile-id="${escapeHtml(profile.id)}">测试</button>
            <button type="button" class="btn btn-ghost btn-sm" data-action="edit" data-profile-id="${escapeHtml(profile.id)}">编辑</button>
            ${
              !isDefault
                ? `<button type="button" class="btn btn-ghost btn-sm" data-action="default" data-profile-id="${escapeHtml(profile.id)}">设为默认</button>`
                : ""
            }
            <button type="button" class="btn btn-ghost btn-sm" data-action="delete" data-profile-id="${escapeHtml(profile.id)}">删除</button>
          </div>
        </div>
        <div class="api-ai-profile-meta">
          <span>${escapeHtml(profile.providerLabel || profile.provider || "—")}</span>
          <span>${escapeHtml(profile.model || "—")}</span>
          <span>${profile.hasApiKey ? escapeHtml(profile.maskedKey) : "未配置 Key"}</span>
        </div>
      </div>`;
    })
    .join("");
}

function showAiProfileModalMessage(msg, type) {
  const el = $("#aiProfileModalMessage");
  if (!el) return;
  el.textContent = msg;
  el.className = msg ? `message ${type}` : "message";
}

async function openAiProfileModal(profileId = null) {
  const profile = profileId ? aiProfilesCache.find((item) => item.id === profileId) : null;
  const isEdit = Boolean(profile);
  const providers = await resolveAiProviders();

  if ($("#aiProfileModalTitle")) {
    $("#aiProfileModalTitle").textContent = isEdit ? "编辑 AI API" : "添加 AI API";
  }
  if ($("#aiProfileEditId")) $("#aiProfileEditId").value = profile?.id || "";
  if ($("#aiProfileNameInput")) {
    $("#aiProfileNameInput").value = profile?.name || "";
  }
  if ($("#aiProfileApiKeyInput")) {
    $("#aiProfileApiKeyInput").value = "";
    $("#aiProfileApiKeyInput").required = !isEdit;
  }
  if ($("#aiProfileKeyRequired")) $("#aiProfileKeyRequired").style.display = isEdit ? "none" : "";
  if ($("#aiProfileKeyHint")) $("#aiProfileKeyHint").classList.toggle("hidden", !isEdit);
  if ($("#aiProfileEnabledInput")) $("#aiProfileEnabledInput").checked = profile ? profile.enabled !== false : true;
  if ($("#aiProfileDefaultInput")) {
    $("#aiProfileDefaultInput").checked = profile
      ? profile.id === defaultAiProfileIdCache
      : !aiProfilesCache.length;
  }

  renderAiProviderOptions(providers, profile?.provider || "zhipu", $("#aiProfileProviderSelect"));
  const provider = getAiProviderFromCache(profile?.provider || "zhipu");
  if (provider) {
    renderAiModelOptions(provider, profile?.model || provider.defaultModel, $("#aiProfileModelSelect"));
    updateAiProviderFields(provider, "profile");
  }
  if ($("#aiProfileProviderSelect")) $("#aiProfileProviderSelect").value = profile?.provider || "zhipu";
  if ($("#aiProfileBaseUrlInput")) $("#aiProfileBaseUrlInput").value = profile?.baseUrl || "";
  if (profile?.provider === "custom") {
    if ($("#aiProfileCustomModelInput")) $("#aiProfileCustomModelInput").value = profile.model || "";
  } else if ($("#aiProfileModelSelect")) {
    $("#aiProfileModelSelect").value = profile?.model || provider?.defaultModel || "";
  }

  showAiProfileModalMessage("", "");
  openAppModal("aiProfileModal");
}

function collectAiProfileFromModal() {
  const id = $("#aiProfileEditId")?.value.trim() || generateAiProfileId();
  const existing = aiProfilesCache.find((item) => item.id === id);
  const providerId = $("#aiProfileProviderSelect")?.value || "zhipu";
  const provider = getAiProviderFromCache(providerId);
  const name = $("#aiProfileNameInput")?.value.trim() || provider?.label || "AI API";
  return {
    id,
    name,
    enabled: $("#aiProfileEnabledInput")?.checked !== false,
    provider: providerId,
    baseUrl: $("#aiProfileBaseUrlInput")?.value.trim() || "",
    apiKey: $("#aiProfileApiKeyInput")?.value.trim() || "",
    model: getAiProfileModelFromUI(),
    createdAt: existing?.createdAt || Date.now(),
  };
}

async function saveAiProfilesToServer(profiles, defaultAiProfileId, { silent = false, messageEl = null } = {}) {
  const showMsg = (msg, type) => {
    if (messageEl === "modal") showAiProfileModalMessage(msg, type);
    else if (messageEl === "api") showApiAiManageMessage(msg, type);
    else if (!silent) showAiMessage(msg, type);
  };

  if (!silent) showMsg("正在保存...", "info");
  try {
    const res = await fetch("/api/ai/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ aiProfiles: profiles, defaultAiProfileId }),
    });
    const raw = await res.json();
    if (!res.ok) {
      showMsg(raw.error || "保存失败", "err");
      return null;
    }
    const data = normalizeAiConfigResponse(raw);
    aiProfilesCache = data.aiProfiles || [];
    defaultAiProfileIdCache = data.defaultAiProfileId || null;
    renderAiProfilesList(aiProfilesCache, defaultAiProfileIdCache);
    updateApiAiStatusCard(data);
    if (activeView === "ai") await applyAiConfigToUI(data);
    if (!silent) showMsg("AI 配置已保存", "ok");
    return data;
  } catch {
    showMsg("无法连接本地服务", "err");
    return null;
  }
}

async function saveAiProfileFromModal(event) {
  event?.preventDefault();
  const profile = collectAiProfileFromModal();
  const isEdit = Boolean($("#aiProfileEditId")?.value);
  if (!profile.name) {
    showAiProfileModalMessage("请填写名称", "err");
    return;
  }
  if (!isEdit && !profile.apiKey) {
    showAiProfileModalMessage("请填写 API Key", "err");
    return;
  }

  const profiles = [...aiProfilesCache];
  const index = profiles.findIndex((item) => item.id === profile.id);
  if (index >= 0) {
    if (!profile.apiKey) profile.apiKey = profiles[index].apiKey || "";
    profiles[index] = { ...profiles[index], ...profile };
  } else {
    profiles.push(profile);
  }

  let defaultId = defaultAiProfileIdCache;
  if ($("#aiProfileDefaultInput")?.checked) defaultId = profile.id;
  else if (!defaultId && profiles.length === 1) defaultId = profile.id;

  const saved = await saveAiProfilesToServer(profiles, defaultId, { messageEl: "modal" });
  if (saved) {
    $("#aiProfileModal")?.close();
  }
}

async function testAiProfileFromModal() {
  const profile = collectAiProfileFromModal();
  const isEdit = Boolean($("#aiProfileEditId")?.value);
  if (!profile.apiKey && !isEdit) {
    showAiProfileModalMessage("请先填写 API Key", "err");
    return;
  }
  if (profile.provider === "custom" && !profile.baseUrl) {
    showAiProfileModalMessage("请填写 API Base URL", "err");
    return;
  }
  showAiProfileModalMessage(
    profile.model
      ? `正在测试 ${profile.model}，若不支持将自动匹配可用模型…`
      : "正在自动匹配该 Key 可用的模型…",
    "info",
  );
  try {
    const res = await fetch("/api/ai/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        aiProfileId: isEdit && !profile.apiKey ? profile.id : undefined,
        apiKey: profile.apiKey || undefined,
        provider: profile.provider,
        baseUrl: profile.baseUrl || undefined,
        model: profile.model || undefined,
        autoMatch: true,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      showAiProfileModalMessage(data.error || "测试失败", "err");
      return;
    }
    const matched = data.matchedModel || data.model || profile.model;
    if (matched) {
      if ($("#aiProfileCustomModelInput")) $("#aiProfileCustomModelInput").value = matched;
      if ($("#aiProfileModelSelect")) {
        const opt = [...($("#aiProfileModelSelect").options || [])].find((item) => item.value === matched);
        if (opt) $("#aiProfileModelSelect").value = matched;
      }
    }
    const switchHint = data.autoSwitched ? `（已自动切换为 ${matched}）` : "";
    showAiProfileModalMessage(`${data.message}${switchHint}：${data.preview || ""}`, "ok");
  } catch {
    showAiProfileModalMessage("无法连接本地服务", "err");
  }
}

async function testAiProfileById(profileId) {
  const profile = aiProfilesCache.find((item) => item.id === profileId);
  if (!profile?.hasApiKey) {
    showApiAiManageMessage("该 AI 尚未配置 API Key", "err");
    return;
  }
  showApiAiManageMessage("正在测试 AI 连接（不支持时将自动匹配模型）...", "info");
  try {
    const res = await fetch("/api/ai/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ aiProfileId: profileId, autoMatch: true }),
    });
    const data = await res.json();
    if (!res.ok) {
      showApiAiManageMessage(data.error || "测试失败", "err");
      return;
    }
    if (data.autoSwitched && data.matchedModel) {
      const nextProfiles = aiProfilesCache.map((item) =>
        item.id === profileId ? { ...item, model: data.matchedModel } : item,
      );
      await saveAiProfilesToServer(nextProfiles, defaultAiProfileIdCache, {
        silent: true,
        messageEl: "api",
      });
      showApiAiManageMessage(
        `${profile.name}：已自动切换到 ${data.matchedModel}，${data.message}`,
        "ok",
      );
    } else {
      showApiAiManageMessage(`${profile.name}：${data.message}`, "ok");
    }
    const statusEl = $("#apiAiStatusText");
    if (statusEl) {
      statusEl.textContent = "连接成功";
      statusEl.style.color = "var(--success)";
    }
  } catch {
    showApiAiManageMessage("无法连接本地服务", "err");
  }
}

async function deleteAiProfile(profileId) {
  const profile = aiProfilesCache.find((item) => item.id === profileId);
  if (!profile) return;
  if (!confirm(`确定删除 AI「${profile.name}」？托管账号若绑定了此 AI 将回退为默认 AI。`)) return;

  const profiles = aiProfilesCache.filter((item) => item.id !== profileId);
  let defaultId = defaultAiProfileIdCache;
  if (defaultId === profileId) {
    defaultId = profiles.find((item) => item.enabled && item.hasApiKey)?.id || profiles[0]?.id || null;
  }
  await saveAiProfilesToServer(profiles, defaultId, { messageEl: "api" });
}

async function setDefaultAiProfile(profileId) {
  if (!aiProfilesCache.some((item) => item.id === profileId)) return;
  await saveAiProfilesToServer(aiProfilesCache, profileId, { messageEl: "api" });
}

function onApiAiProfilesListClick(event) {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const profileId = button.dataset.profileId;
  if (!profileId) return;
  const action = button.dataset.action;
  if (action === "edit") openAiProfileModal(profileId);
  else if (action === "test") testAiProfileById(profileId);
  else if (action === "delete") deleteAiProfile(profileId);
  else if (action === "default") setDefaultAiProfile(profileId);
}

function updateApiAiStatusCard(data) {
  if (!data) return;
  const statusEl = $("#apiAiStatusText");
  const profiles = data.aiProfiles || [];
  const configuredCount = profiles.filter((item) => item.hasApiKey).length;
  const enabledCount = data.enabledAiProfileCount ?? profiles.filter((item) => item.enabled && item.hasApiKey).length;
  const defaultProfile = profiles.find((item) => item.id === data.defaultAiProfileId);

  if ($("#apiAiProfileCount")) $("#apiAiProfileCount").textContent = `${configuredCount} 个`;
  if ($("#apiAiEnabledCount")) $("#apiAiEnabledCount").textContent = `${enabledCount} 个`;
  if ($("#apiAiDefaultName")) {
    $("#apiAiDefaultName").textContent = defaultProfile?.name || (configuredCount ? "未设置" : "—");
  }
  if ($("#apiAiHostingText")) {
    const hostingEl = $("#apiAiHostingText");
    hostingEl.textContent = data.enabled ? "已开启" : "未开启";
    hostingEl.style.color = data.enabled ? "var(--success)" : "var(--text-muted)";
  }
  if ($("#apiAiHostedCount")) {
    const enabled = data.enabledHostedCount ?? (data.hostedAccounts || []).filter((item) => item.enabled).length;
    $("#apiAiHostedCount").textContent = `${enabled} 个`;
  }
  if (statusEl) {
    if (data.lastError && data.hasApiKey) {
      statusEl.textContent = "最近失败";
      statusEl.style.color = "var(--error)";
    } else if (data.hasApiKey) {
      statusEl.textContent = data.lastSuccessAt ? "已配置" : "待测试";
      statusEl.style.color = data.lastSuccessAt ? "var(--success)" : "var(--accent)";
    } else {
      statusEl.textContent = "未配置";
      statusEl.style.color = "var(--text-muted)";
    }
  }
}

async function refreshApiAiManagePanel() {
  try {
    const res = await fetch("/api/ai/config");
    const raw = await res.json();
    const data = normalizeAiConfigResponse(raw);
    aiProfilesCache = data.aiProfiles || [];
    defaultAiProfileIdCache = data.defaultAiProfileId || null;
    updateApiAiStatusCard(data);
    renderAiProfilesList(aiProfilesCache, defaultAiProfileIdCache);
  } catch {
    updateApiAiStatusCard(null);
    renderAiProfilesList([], null);
  }
}

function showApiAiManageMessage(msg, type) {
  const el = $("#apiAiManageMessage");
  if (!el) return;
  el.textContent = msg;
  el.className = msg ? `message ${type}` : "message";
}

function onAiProviderChange() {
  const provider = getAiProviderFromCache($("#aiProviderSelect")?.value);
  if (!provider) return;
  renderAiModelOptions(provider, provider.defaultModel);
  updateAiProviderFields(provider);
}

function getSelectedAiModelFromUI() {
  const providerId = $("#aiProviderSelect")?.value || "zhipu";
  if (providerId === "custom") {
    return $("#aiCustomModelInput")?.value.trim() || "";
  }
  return $("#aiModelSelect")?.value || "";
}

async function applyAiConfigToUI(data) {
  if (!data) return;
  data = normalizeAiConfigResponse(data);
  aiProfilesCache = data.aiProfiles || [];
  defaultAiProfileIdCache = data.defaultAiProfileId || null;
  const providers = await resolveAiProviders(data.providers);
  renderAiProviderOptions(providers, data.provider || "zhipu");
  const provider = getAiProviderFromCache(data.provider || "zhipu");
  if (provider) {
    renderAiModelOptions(provider, data.model || provider.defaultModel);
    updateAiProviderFields(provider);
  }
  if ($("#aiProviderSelect")) $("#aiProviderSelect").value = data.provider || "zhipu";
  if ($("#aiBaseUrlInput")) $("#aiBaseUrlInput").value = data.baseUrl || "";
  if (data.provider === "custom") {
    if ($("#aiCustomModelInput")) $("#aiCustomModelInput").value = data.model || "";
  } else if ($("#aiModelSelect")) {
    $("#aiModelSelect").value = data.model || provider?.defaultModel || "glm-4-flash";
  }

  if ($("#aiEnabled")) $("#aiEnabled").checked = Boolean(data.enabled);
  if ($("#aiIntervalInput")) $("#aiIntervalInput").value = data.intervalMinutes || 60;
  if ($("#aiPostsPerRunInput")) $("#aiPostsPerRunInput").value = data.postsPerRun || 1;
  if ($("#aiMaxPerDayInput")) $("#aiMaxPerDayInput").value = data.maxPostsPerDay || 10;
  if ($("#aiPublishDelayMinInput")) {
    $("#aiPublishDelayMinInput").value =
      data.publishDelayMinSeconds ?? data.publishIntervalSeconds ?? 3;
  }
  if ($("#aiPublishDelayMaxInput")) {
    $("#aiPublishDelayMaxInput").value =
      data.publishDelayMaxSeconds ?? data.publishIntervalSeconds ?? 8;
  }
  if ($("#aiAutoPublish")) $("#aiAutoPublish").checked = data.autoPublish !== false;
  if ($("#aiAttachImages")) $("#aiAttachImages").checked = data.attachRelatedImages !== false;
  if ($("#aiPreventDuplicate")) {
    $("#aiPreventDuplicate").checked = data.preventDuplicatePosts !== false;
  }
  if ($("#aiUseNews")) $("#aiUseNews").checked = data.useNews !== false;
  aiStyleReferencesCache = Array.isArray(data.styleReferences) ? data.styleReferences : [];
  renderAiStyleReferencesList();

  aiUiOptions = {
    contentStyleOptions: data.contentStyleOptions?.length ? data.contentStyleOptions : DEFAULT_CONTENT_STYLE_OPTIONS,
    marketSentimentOptions: data.marketSentimentOptions?.length ? data.marketSentimentOptions : DEFAULT_SENTIMENT_OPTIONS,
    availableTokens: data.availableTokens?.length ? data.availableTokens : DEFAULT_AVAILABLE_TOKENS,
  };
  renderHostedAccountsList(data);
  if ($("#aiStatusText")) renderAiStatus(data);
}

function formatHostedStyleLabel(host) {
  const styles = (host.contentStyles || [])
    .map((id) => aiUiOptions.contentStyleOptions.find((item) => item.id === id)?.label || id)
    .filter(Boolean);
  if (!styles.length) return "口语化分享";
  return styles.length > 2 ? `${styles.slice(0, 2).join("、")}…` : styles.join("、");
}

function formatHostedSentimentLabel(sentiment) {
  if (sentiment === "bullish") return "看多";
  if (sentiment === "bearish") return "看空";
  return "自动";
}

function formatMetric(value) {
  if (value == null || value === "") return "—";
  const num = Number(value);
  if (!Number.isFinite(num)) return "—";
  return num.toLocaleString("zh-CN");
}

function formatCommission(value) {
  if (value == null || value === "") return "—";
  const num = Number(value);
  if (!Number.isFinite(num)) return "—";
  return num.toFixed(2);
}

function renderHostedSummary(hosted = []) {
  const el = $("#aiHostedSummary");
  if (!el) return;
  const enabled = hosted.filter((item) => item.enabled).length;
  const articles = hosted.reduce((sum, item) => sum + (Number(item.articleCount) || 0), 0);
  const views = hosted.reduce((sum, item) => sum + (Number(item.viewCount) || 0), 0);
  el.innerHTML = `
    <div class="ai-hosted-stat"><div class="k">账号数</div><div class="v">${hosted.length}</div></div>
    <div class="ai-hosted-stat"><div class="k">已启用托管</div><div class="v">${enabled}</div></div>
    <div class="ai-hosted-stat"><div class="k">文章数量</div><div class="v">${formatMetric(articles)}</div></div>
    <div class="ai-hosted-stat"><div class="k">总浏览量</div><div class="v">${formatMetric(views)}</div></div>
  `;
}

function getHostedSearchQuery() {
  return ($("#aiHostedSearchInput")?.value || "").trim().toLowerCase();
}

function buildHostedStyleSelectOptions(selectedStyles = ["casual"]) {
  const selected = selectedStyles?.[0] || "casual";
  const list = aiUiOptions.contentStyleOptions?.length
    ? aiUiOptions.contentStyleOptions
    : DEFAULT_CONTENT_STYLE_OPTIONS;
  return list
    .map(
      (opt) =>
        `<option value="${escapeHtml(opt.id)}" ${opt.id === selected ? "selected" : ""}>${escapeHtml(opt.label)}</option>`,
    )
    .join("");
}

function buildHostedSentimentSelectOptions(selected = "auto") {
  const list = aiUiOptions.marketSentimentOptions?.length
    ? aiUiOptions.marketSentimentOptions
    : DEFAULT_SENTIMENT_OPTIONS;
  return list
    .map(
      (opt) =>
        `<option value="${escapeHtml(opt.id)}" ${opt.id === selected ? "selected" : ""}>${escapeHtml(opt.label)}</option>`,
    )
    .join("");
}

function renderHostedAccountsList(data) {
  const container = $("#aiHostedAccountsList");
  if (!container) return;

  data = normalizeAiConfigResponse(data || {});
  const hostedAll = sortAccountsNewestFirst(data.hostedAccounts || []);
  aiHostedAccountsCache = hostedAll;
  renderHostedSummary(hostedAll);

  if (!accountStore.accounts.length && !hostedAll.length) {
    container.innerHTML = `<div class="account-empty">请先在「账号管理」中添加账号</div>`;
    return;
  }

  if (!hostedAll.length) {
    container.innerHTML = `<div class="account-empty">暂无账号，请先在「账号管理」中添加</div>`;
    return;
  }

  const q = getHostedSearchQuery();
  const hosted = q
    ? hostedAll.filter((host) => String(host.accountName || getAccountName(host.accountId)).toLowerCase().includes(q))
    : hostedAll;

  if (!hosted.length) {
    container.innerHTML = `<div class="account-empty">未找到匹配账号</div>`;
    return;
  }

  container.innerHTML = `
    <div class="ai-report-wrap">
      <table class="ai-report-table">
        <thead>
          <tr>
            <th>序号</th>
            <th>托管</th>
            <th>账号</th>
            <th>风格</th>
            <th>AI</th>
            <th>观点</th>
            <th>文章数</th>
            <th>浏览量</th>
            <th>点赞</th>
            <th>评论</th>
            <th>佣金</th>
            <th>状态</th>
            <th class="col-actions">操作</th>
          </tr>
        </thead>
        <tbody>
          ${hosted
            .map((host, index) => {
              const id = host.accountId;
              const expanded = aiHostedExpanded.has(id);
              const name = host.accountName || getAccountName(id);
              return `
              <tr class="ai-hosted-account-card ${host.enabled ? "is-enabled" : ""}" data-account-id="${id}">
                <td class="num muted">${index + 1}</td>
                <td>
                  <input type="checkbox" class="ai-host-enabled" data-account-id="${id}" ${host.enabled ? "checked" : ""} title="启用托管" />
                </td>
                <td>
                  <strong>${escapeHtml(name)}</strong>
                  ${host.isDefault ? '<span class="badge badge-green account-default-badge">默认</span>' : ""}
                </td>
                <td>
                  <select class="ai-inline-select ai-host-style-select" data-account-id="${id}" title="文案风格">
                    ${buildHostedStyleSelectOptions(host.contentStyles || ["casual"])}
                  </select>
                </td>
                <td>
                  <select class="ai-inline-select ai-host-profile-select" data-account-id="${id}" title="使用 AI">
                    ${buildAiProfileSelectOptions(host.aiProfileId)}
                  </select>
                </td>
                <td>
                  <select class="ai-inline-select ai-host-sentiment-select" data-account-id="${id}" title="观点倾向">
                    ${buildHostedSentimentSelectOptions(host.marketSentiment || "auto")}
                  </select>
                </td>
                <td class="num">${formatMetric(host.articleCount)}</td>
                <td class="num">${formatMetric(host.viewCount)}</td>
                <td class="num">${formatMetric(host.likeCount)}</td>
                <td class="num">${formatMetric(host.commentCount)}</td>
                <td class="num muted" title="广场暂无统一佣金接口">${formatCommission(host.commission)}</td>
                <td class="ai-host-status-cell">${host.enabled ? '<span class="badge badge-green">托管中</span>' : '<span class="muted">未启用</span>'}</td>
                <td class="col-actions">
                  <button type="button" class="btn btn-ghost btn-sm ai-host-toggle-config" data-account-id="${id}">
                    ${expanded ? "收起代币" : "代币"}
                  </button>
                </td>
              </tr>
              <tr class="ai-hosted-config-row" data-account-id="${id}">
                <td colspan="13">
                  <div class="ai-hosted-account-body ${expanded ? "is-open" : ""}" id="aiHostBody-${id}">
                    <div class="ai-hosted-config-block">
                      <span class="ai-hosted-config-label">目标代币</span>
                      <p class="hint">不选则根据新闻自动轮换主流币。风格 / AI / 观点已可在上表直接修改。</p>
                      <div class="token-picker ai-host-token-picker" data-account-id="${id}"></div>
                      <div class="token-custom-add">
                        <input type="text" class="ai-host-custom-token-input" data-account-id="${id}" placeholder="自定义代币，如 PEPE" maxlength="10" autocomplete="off" />
                        <button type="button" class="btn btn-secondary btn-sm ai-host-add-token" data-account-id="${id}">添加</button>
                      </div>
                    </div>
                  </div>
                </td>
              </tr>`;
            })
            .join("")}
        </tbody>
      </table>
    </div>`;

  hosted.forEach((host) => {
    const id = host.accountId;
    aiHostedCustomTokens[id] = [...(host.customTokens || [])];
    renderTokenPickerIn(
      container.querySelector(`.ai-host-token-picker[data-account-id="${id}"]`),
      aiUiOptions.availableTokens,
      host.selectedTokens || [],
      aiHostedCustomTokens[id],
      { onUpdate: () => syncVisibleHostedRowsIntoCache() },
    );
  });

  container.querySelectorAll(".ai-host-enabled").forEach((input) => {
    input.addEventListener("change", () => {
      const row = input.closest("tr.ai-hosted-account-card");
      row?.classList.toggle("is-enabled", input.checked);
      const statusCell = row?.querySelector(".ai-host-status-cell");
      if (statusCell) {
        statusCell.innerHTML = input.checked
          ? '<span class="badge badge-green">托管中</span>'
          : '<span class="muted">未启用</span>';
      }
      syncVisibleHostedRowsIntoCache();
      renderHostedSummary(aiHostedAccountsCache);
    });
  });

  container.querySelectorAll(".ai-host-style-select, .ai-host-profile-select, .ai-host-sentiment-select").forEach((select) => {
    select.addEventListener("change", () => syncVisibleHostedRowsIntoCache());
  });

  container.querySelectorAll(".ai-host-toggle-config").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.accountId;
      const body = document.getElementById(`aiHostBody-${id}`);
      if (!body) return;
      const open = !body.classList.contains("is-open");
      body.classList.toggle("is-open", open);
      btn.textContent = open ? "收起代币" : "代币";
      if (open) {
        aiHostedExpanded.add(id);
        // 展开后滚到可视区，确保全部芯片可见
        requestAnimationFrame(() => {
          body.scrollIntoView({ block: "nearest", behavior: "smooth" });
        });
      } else {
        aiHostedExpanded.delete(id);
      }
    });
  });

  container.querySelectorAll(".ai-host-add-token").forEach((btn) => {
    btn.addEventListener("click", () => addHostedCustomToken(btn.dataset.accountId));
  });

  container.querySelectorAll(".ai-host-custom-token-input").forEach((input) => {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        addHostedCustomToken(input.dataset.accountId);
      }
    });
  });

  const searchInput = $("#aiHostedSearchInput");
  if (searchInput && !searchInput.dataset.bound) {
    searchInput.dataset.bound = "1";
    searchInput.addEventListener("input", () => {
      syncVisibleHostedRowsIntoCache();
      renderHostedAccountsList({ hostedAccounts: aiHostedAccountsCache });
    });
  }
}

function syncVisibleHostedRowsIntoCache() {
  const visible = [...$$("tr.ai-hosted-account-card")].map((card) => collectHostedAccountFromCard(card));
  if (!visible.length) return;
  const map = new Map(aiHostedAccountsCache.map((item) => [item.accountId, item]));
  for (const item of visible) {
    const prev = map.get(item.accountId) || {};
    map.set(item.accountId, {
      ...prev,
      ...item,
      accountName: prev.accountName || getAccountName(item.accountId),
    });
  }
  aiHostedAccountsCache = sortAccountsNewestFirst([...map.values()]);
}

function collectHostedAccountFromCard(card) {
  const accountId = card.dataset.accountId;
  const configRow = document.querySelector(`tr.ai-hosted-config-row[data-account-id="${accountId}"]`);
  const tokenPicker = configRow?.querySelector(".ai-host-token-picker");
  const styleSelect = card.querySelector(".ai-host-style-select");
  const profileSelect = card.querySelector(".ai-host-profile-select");
  const sentimentSelect = card.querySelector(".ai-host-sentiment-select");
  const styleId = styleSelect?.value || "casual";
  return {
    accountId,
    enabled: card.querySelector(".ai-host-enabled")?.checked || false,
    aiProfileId: profileSelect?.value || null,
    selectedTokens: collectSelectedTokensFromContainer(tokenPicker),
    customTokens: aiHostedCustomTokens[accountId] || [],
    marketSentiment: sentimentSelect?.value || "auto",
    contentStyles: styleId ? [styleId] : ["casual"],
  };
}

function collectHostedAccountsFromUI() {
  syncVisibleHostedRowsIntoCache();
  if (aiHostedAccountsCache.length) {
    return aiHostedAccountsCache.map((item) => ({
      accountId: item.accountId,
      enabled: Boolean(item.enabled),
      aiProfileId: item.aiProfileId || null,
      selectedTokens: item.selectedTokens || [],
      customTokens: item.customTokens || [],
      marketSentiment: item.marketSentiment || "auto",
      contentStyles: item.contentStyles?.length ? item.contentStyles : ["casual"],
    }));
  }
  return normalizeHostedAccountsFromConfig({});
}

function addHostedCustomToken(accountId) {
  const input = document.querySelector(`.ai-host-custom-token-input[data-account-id="${accountId}"]`);
  const configRow = document.querySelector(`tr.ai-hosted-config-row[data-account-id="${accountId}"]`);
  const tokenPicker = configRow?.querySelector(".ai-host-token-picker");
  if (!input || !tokenPicker) return;

  const symbol = parseTokenSymbol(input.value);
  if (!symbol || symbol.length < 2) {
    showAiMessage("请输入 2–10 位字母/数字组成的代币符号", "err");
    return;
  }

  if (!aiHostedCustomTokens[accountId]) aiHostedCustomTokens[accountId] = [];
  if (!aiHostedCustomTokens[accountId].includes(symbol)) aiHostedCustomTokens[accountId].push(symbol);

  const selected = collectSelectedTokensFromContainer(tokenPicker);
  if (!selected.includes(symbol)) selected.push(symbol);
  renderTokenPickerIn(tokenPicker, aiUiOptions.availableTokens, selected, aiHostedCustomTokens[accountId], {
    onUpdate: () => syncVisibleHostedRowsIntoCache(),
  });
  input.value = "";
  syncVisibleHostedRowsIntoCache();
}

function updateTokenSummary() {
  const el = $("#aiTokenSummary");
  if (!el) return;
  const selected = collectSelectedTokensFromUI();
  if (!selected.length) {
    el.textContent = "自动轮换";
    return;
  }
  const text = selected.map((symbol) => `$${symbol}`).join("、");
  el.textContent = selected.length > 3 ? `${selected.slice(0, 3).map((s) => `$${s}`).join("、")} 等${selected.length}个` : text;
}

function collectSelectedTokensFromContainer(container) {
  if (!container) return [];
  return [...container.querySelectorAll(".token-chip.active")].map((el) => el.dataset.token).filter(Boolean);
}

function renderTokenPickerIn(container, presetTokens = [], selected = [], customTokens = [], { onUpdate } = {}) {
  if (!container) return;
  const preset = presetTokens.length ? presetTokens : DEFAULT_AVAILABLE_TOKENS;
  const presetSet = new Set(preset);
  const normalizedSelected = [...new Set(selected.map(parseTokenSymbol).filter(Boolean))];
  const selectedSet = new Set(normalizedSelected);
  const customList = [...new Set(customTokens.map(parseTokenSymbol).filter(Boolean))];
  for (const symbol of normalizedSelected) {
    if (!presetSet.has(symbol) && !customList.includes(symbol)) customList.push(symbol);
  }

  const presetHtml = preset
    .map(
      (symbol) => `
      <button type="button" class="token-chip ${selectedSet.has(symbol) ? "active" : ""}" data-token="${symbol}">
        $${symbol}
      </button>`,
    )
    .join("");

  const customHtml = customList
    .map(
      (symbol) => `
      <button type="button" class="token-chip custom ${selectedSet.has(symbol) ? "active" : ""}" data-token="${symbol}" data-custom="1">
        <span class="token-chip-label">$${symbol}</span>
        <span class="token-chip-remove" data-action="remove-custom" data-token="${symbol}" title="删除">×</span>
      </button>`,
    )
    .join("");

  container.innerHTML = presetHtml + customHtml;
  container.querySelectorAll(".token-chip").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      if (e.target.closest('[data-action="remove-custom"]')) return;
      btn.classList.toggle("active");
      onUpdate?.();
    });
  });
  container.querySelectorAll('[data-action="remove-custom"]').forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const symbol = parseTokenSymbol(btn.dataset.token);
      const accountId =
        container.dataset.accountId ||
        container.closest("[data-account-id]")?.dataset.accountId;
      if (accountId && aiHostedCustomTokens[accountId]) {
        aiHostedCustomTokens[accountId] = aiHostedCustomTokens[accountId].filter((item) => item !== symbol);
      }
      btn.closest(".token-chip")?.remove();
      onUpdate?.();
    });
  });
}

function renderTokenPicker(presetTokens = [], selected = [], customTokens = []) {
  const container = $("#aiTokenPicker");
  if (!container) return;
  aiCustomTokens = [...new Set(customTokens.map(parseTokenSymbol).filter(Boolean))];
  renderTokenPickerIn(container, presetTokens, selected, aiCustomTokens, { onUpdate: updateTokenSummary });
  updateTokenSummary();
}

function initAiCollapseSections() {
  $$(".ai-collapse-trigger").forEach((btn) => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = "1";
    btn.addEventListener("click", () => {
      const body = document.getElementById(btn.dataset.target);
      if (!body) return;
      const expanded = btn.getAttribute("aria-expanded") === "true";
      btn.setAttribute("aria-expanded", expanded ? "false" : "true");
      body.classList.toggle("is-open", !expanded);
    });
  });
}

function updateSentimentSummary() {
  const el = $("#aiSentimentSummary");
  if (!el) return;
  const value = collectMarketSentimentFromUI();
  const option = DEFAULT_SENTIMENT_OPTIONS.find((item) => item.id === value);
  el.textContent = option?.label || "自动（跟随行情）";
}

function updateContentStyleSummary() {
  const el = $("#aiContentStyleSummary");
  if (!el) return;
  const labels = [...$$('input[name="aiContentStyle"]:checked')]
    .map((input) => input.closest(".content-style-option")?.querySelector("strong")?.textContent?.trim())
    .filter(Boolean);
  el.textContent = labels.length ? labels.join("、") : "口语化分享";
}

function parseTokenSymbol(raw = "") {
  return String(raw).replace(/^\$/, "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function removeCustomToken(symbol) {
  const normalized = parseTokenSymbol(symbol);
  if (!normalized) return;
  aiCustomTokens = aiCustomTokens.filter((item) => item !== normalized);
  const selected = collectSelectedTokensFromUI().filter((item) => item !== normalized);
  renderTokenPicker(DEFAULT_AVAILABLE_TOKENS, selected, aiCustomTokens);
  updateTokenSummary();
}

function addCustomTokenFromInput() {
  const input = $("#aiCustomTokenInput");
  if (!input) return;
  const symbol = parseTokenSymbol(input.value);
  if (!symbol || symbol.length < 2) {
    showAiMessage("请输入 2–10 位字母/数字组成的代币符号，如 PEPE", "err");
    return;
  }

  const preset = DEFAULT_AVAILABLE_TOKENS;
  const selected = collectSelectedTokensFromUI();
  if (!aiCustomTokens.includes(symbol)) aiCustomTokens.push(symbol);
  if (!selected.includes(symbol)) selected.push(symbol);
  renderTokenPicker(preset, selected, aiCustomTokens);

  input.value = "";
  updateTokenSummary();
  showAiMessage(`已添加自定义代币 $${symbol}，记得点击「保存 AI 配置」`, "ok");
}

function collectSelectedTokensFromUI() {
  return [...$$("#aiTokenPicker .token-chip.active")].map((el) => el.dataset.token).filter(Boolean);
}

function renderSentimentPickerIn(container, options = [], selected = "auto", accountId = "") {
  if (!container) return;
  const list = options.length ? options : DEFAULT_SENTIMENT_OPTIONS;
  const name = accountId ? `aiMarketSentiment-${accountId}` : "aiMarketSentiment";
  container.innerHTML = list
    .map(
      (opt) => `
      <label class="sentiment-option ${opt.id === "bullish" ? "bullish" : opt.id === "bearish" ? "bearish" : ""}">
        <input type="radio" name="${name}" value="${opt.id}" ${opt.id === selected ? "checked" : ""} />
        <span>${opt.label}</span>
      </label>`,
    )
    .join("");
  container.querySelectorAll(`input[name="${name}"]`).forEach((input) => {
    input.addEventListener("change", () => syncVisibleHostedRowsIntoCache());
  });
}

function renderSentimentPicker(options = [], selected = "auto") {
  renderSentimentPickerIn($("#aiSentimentPicker"), options, selected);
  updateSentimentSummary();
}

function renderContentStyleOptionsIn(container, options, selected = ["casual"], accountId = "") {
  if (!container) return;
  const list = options?.length ? options : DEFAULT_CONTENT_STYLE_OPTIONS;
  const selectedSet = new Set(selected);
  const name = accountId ? `aiContentStyle-${accountId}` : "aiContentStyle";
  container.innerHTML = list
    .map(
      (opt) => `
      <label class="content-style-option">
        <input type="checkbox" name="${name}" value="${opt.id}" ${selectedSet.has(opt.id) ? "checked" : ""} />
        <span>
          <strong>${opt.label}</strong>
          <small>${opt.hint}</small>
        </span>
      </label>`,
    )
    .join("");
  container.querySelectorAll(`input[name="${name}"]`).forEach((input) => {
    input.addEventListener("change", () => syncVisibleHostedRowsIntoCache());
  });
}

function renderContentStyleOptions(options, selected = ["casual"]) {
  renderContentStyleOptionsIn($("#aiContentStyles"), options, selected);
  updateContentStyleSummary();
}

function collectMarketSentimentFromUI() {
  const checked = document.querySelector('input[name="aiMarketSentiment"]:checked');
  return checked?.value || "auto";
}

function collectContentStylesFromUI() {
  return [...$$('input[name="aiContentStyle"]:checked')].map((el) => el.value);
}

function updateAiHostingButtons(data) {
  const btn = $("#btnAiRunNow");
  const cancelBtn = $("#btnAiCancelHosting");
  if (!btn || aiRunning) return;
  if (data?.enabled) {
    btn.textContent = "立即发一条（可选）";
    btn.title = "后台已自动托管，刷新或重启后仍会按计划发帖。此按钮仅用于立即额外发一条";
    btn.classList.remove("btn-accent");
    btn.classList.add("btn-secondary");
    if (cancelBtn) cancelBtn.classList.remove("hidden");
  } else {
    btn.textContent = "开启并立即托管";
    btn.title = "开启自动托管并立即发布一条，之后将按间隔自动发帖";
    btn.classList.remove("btn-secondary");
    btn.classList.add("btn-accent");
    if (cancelBtn) cancelBtn.classList.add("hidden");
  }
}

async function stopAiHosting() {
  const current = await fetch("/api/ai/config").then((r) => r.json()).catch(() => ({}));
  if (!current.enabled) {
    showAiMessage("当前未开启托管", "info");
    return;
  }
  const saved = await saveAiConfig({ enabled: false }, { silent: true });
  if (!saved) return;
  showAiMessage("已取消 AI 自动托管，后台将不再自动发帖。", "ok");
}

function renderAiStatus(data) {
  const el = $("#aiStatusText");
  const hint = $("#aiHostingHint");
  if (!el || !data) return;

  const parts = [
    data.providerLabel ? `服务商: ${data.providerLabel}` : "",
    data.model ? `模型: ${data.model}` : "",
    data.hasApiKey ? `AI Key: ${data.maskedKey}` : "AI Key: 未配置",
    data.enabled ? "托管: 已开启" : "托管: 未开启",
    `今日已发 ${data.todayPublished || 0}/${data.maxPostsPerDay || 10} 条`,
    `上次运行 ${formatTime(data.lastRunAt)}`,
  ];
  const enabledHosted = (data.hostedAccounts || []).filter((item) => item.enabled);
  if (enabledHosted.length) {
    parts.push(`托管账号: ${enabledHosted.length} 个（${enabledHosted.map((item) => item.accountName).join("、")}）`);
  } else {
    parts.push("托管账号: 未启用");
  }
  if (data.enabled && data.nextRunAt) {
    const nextLabel = data.nextRunAt <= Date.now() ? "即将自动发帖" : formatTime(data.nextRunAt);
    parts.push(`下次发帖: ${nextLabel}`);
  }
  if (data.lastError) parts.push(`最近错误: ${data.lastError}`);
  el.textContent = parts.filter(Boolean).join(" · ");
  el.className = data.lastError ? "message err" : "message info";

  if (hint) {
    if (data.enabled && data.hasApiKey) {
      hint.textContent =
        "自动托管已保存。关闭或重启软件后仍会按计划发帖，无需重复开启。";
      hint.classList.remove("hidden");
      hint.className = "message ok";
    } else {
      hint.textContent = "";
      hint.classList.add("hidden");
    }
  }
  updateAiHostingButtons(data);
}

async function loadAiConfig() {
  try {
    const res = await fetch("/api/ai/config");
    const raw = await res.json();
    await applyAiConfigToUI(normalizeAiConfigResponse(raw));
  } catch {
    showAiMessage("无法加载 AI 配置", "err");
    await loadAiProvidersFallback();
    await applyAiConfigToUI({
      provider: "zhipu",
      model: "glm-4-flash",
      providers: aiProvidersCache,
      hostedAccounts: accountStore.accounts.map((acc) => ({
        accountId: acc.id,
        accountName: acc.name,
        isDefault: acc.isDefault,
        enabled: acc.isDefault,
        selectedTokens: [],
        customTokens: [],
        marketSentiment: "auto",
        contentStyles: ["casual"],
      })),
    });
  }
}

function setAiStyleRefMessage(text, type = "") {
  const el = $("#aiStyleRefMessage");
  if (!el) return;
  el.textContent = text || "";
  el.className = `message${type ? ` ${type}` : ""}`;
}

function showAiSettingsMessage(msg, type) {
  const el = $("#aiSettingsMessage");
  if (!el) return;
  el.textContent = msg || "";
  el.className = msg ? `message ${type}` : "message";
}

function collectAiProviderSettingsFromUI() {
  const out = { styleReferences: aiStyleReferencesCache };
  if ($("#aiProviderSelect")) out.provider = $("#aiProviderSelect").value || "zhipu";
  if ($("#aiBaseUrlInput")) out.baseUrl = $("#aiBaseUrlInput").value.trim() || "";
  if ($("#aiApiKeyInput")) {
    const key = $("#aiApiKeyInput").value.trim();
    if (key) out.apiKey = key;
  }
  if ($("#aiModelSelect") || $("#aiCustomModelInput")) {
    out.model = getSelectedAiModelFromUI();
  }
  if ($("#aiUseNews")) out.useNews = $("#aiUseNews").checked;
  return out;
}

function collectAiHostingSettingsFromUI() {
  const hostedAccounts = collectHostedAccountsFromUI();
  const firstEnabled = hostedAccounts.find((item) => item.enabled);
  const out = {};
  if ($("#aiEnabled")) out.enabled = $("#aiEnabled").checked;
  if (hostedAccounts.length || $("#aiHostedAccountsList")) {
    out.hostedAccounts = hostedAccounts;
    out.accountId = firstEnabled?.accountId || getDefaultAccountId();
  }
  if ($("#aiIntervalInput")) out.intervalMinutes = parseInt($("#aiIntervalInput").value, 10) || 60;
  if ($("#aiPostsPerRunInput")) out.postsPerRun = parseInt($("#aiPostsPerRunInput").value, 10) || 1;
  if ($("#aiMaxPerDayInput")) out.maxPostsPerDay = parseInt($("#aiMaxPerDayInput").value, 10) || 10;
  if ($("#aiPublishDelayMinInput")) {
    out.publishDelayMinSeconds = parseInt($("#aiPublishDelayMinInput").value, 10) || 3;
  }
  if ($("#aiPublishDelayMaxInput")) {
    out.publishDelayMaxSeconds = parseInt($("#aiPublishDelayMaxInput").value, 10) || out.publishDelayMinSeconds || 3;
  }
  if ($("#aiAutoPublish")) out.autoPublish = $("#aiAutoPublish").checked;
  if ($("#aiAttachImages")) out.attachRelatedImages = $("#aiAttachImages").checked;
  if ($("#aiPreventDuplicate")) out.preventDuplicatePosts = $("#aiPreventDuplicate").checked;
  return out;
}

function buildStyleOptionsFromReferences(refs = aiStyleReferencesCache) {
  return [
    ...DEFAULT_CONTENT_STYLE_OPTIONS,
    ...(refs || []).map((item) => ({
      id: `ref:${item.id}`,
      label: `参考·${item.name}`,
      hint: "模仿上传范文",
    })),
  ];
}

function renderAiStyleReferencesList() {
  const el = $("#aiStyleRefList");
  if (!el) return;
  if (!aiStyleReferencesCache.length) {
    el.innerHTML =
      `<div class="hint">暂无自定义风格。添加后可在「AI 托管」页账号的「风格」中选择「参考·xxx」。</div>`;
    return;
  }
  el.innerHTML = aiStyleReferencesCache
    .map((item) => {
      const preview = String(item.sampleText || "").replace(/\s+/g, " ").slice(0, 120);
      return `
        <div class="ai-style-ref-item" data-id="${escapeHtml(item.id)}">
          <div>
            <strong>${escapeHtml(item.name)}</strong>
            <div class="preview">${escapeHtml(preview)}${(item.sampleText || "").length > 120 ? "…" : ""}</div>
          </div>
          <div class="ai-style-ref-item-actions">
            <button type="button" class="btn btn-ghost btn-sm" data-action="preview-style-ref">预览</button>
            <button type="button" class="btn btn-ghost btn-sm btn-danger" data-action="delete-style-ref">删除</button>
          </div>
        </div>`;
    })
    .join("");
}

async function previewAiStyleReference(sampleTextOverride, label = "") {
  const sampleText = String(sampleTextOverride ?? $("#aiStyleRefTextInput")?.value ?? "").trim();
  if (sampleText.length < 20) {
    setAiStyleRefMessage("参考文章至少 20 字才能预览", "err");
    return;
  }
  const btn = $("#btnPreviewAiStyleRef");
  const previewBox = $("#aiStyleRefPreview");
  const previewText = $("#aiStyleRefPreviewText");
  const prevLabel = btn?.textContent || "预览生成";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "生成中…";
  }
  setAiStyleRefMessage(
    label ? `正在按「${label}」风格生成预览…` : "正在根据范文生成 AI 模拟预览…",
    "info",
  );
  previewBox?.classList.add("hidden");

  const providerCfg = collectAiProviderSettingsFromUI();
  const host =
    aiHostedAccountsCache.find((item) => item.enabled) ||
    aiHostedAccountsCache[0] ||
    null;

  const payload = {
    sampleText,
    useNews: providerCfg.useNews,
    selectedTokens:
      Array.isArray(host?.selectedTokens) && host.selectedTokens.length
        ? host.selectedTokens
        : ["BTC", "ETH"],
    marketSentiment: host?.marketSentiment || "auto",
  };
  const profileId = host?.aiProfileId || defaultAiProfileIdCache;
  if (profileId) {
    payload.aiProfileId = profileId;
  } else {
    payload.provider = providerCfg.provider;
    payload.baseUrl = providerCfg.baseUrl || undefined;
    payload.apiKey = providerCfg.apiKey || undefined;
    payload.model = providerCfg.model;
  }

  try {
    const res = await fetch("/api/ai/preview-style", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "预览生成失败");
    if (previewText) previewText.textContent = data.text || "";
    previewBox?.classList.remove("hidden");
    setAiStyleRefMessage(
      `预览已生成${data.contentStyleLabel ? `（${data.contentStyleLabel}）` : ""}，见下方模拟正文`,
      "ok",
    );
    previewBox?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (err) {
    setAiStyleRefMessage(err.message || "预览生成失败", "err");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = prevLabel;
    }
  }
}

function refreshHostedStyleOptionsFromReferences() {
  syncVisibleHostedRowsIntoCache();
  aiUiOptions.contentStyleOptions = buildStyleOptionsFromReferences();
  renderHostedAccountsList({
    hostedAccounts: aiHostedAccountsCache,
    aiProfiles: aiProfilesCache,
  });
}

async function addAiStyleReferenceFromUi() {
  const name = ($("#aiStyleRefNameInput")?.value || "").trim();
  const sampleText = ($("#aiStyleRefTextInput")?.value || "").trim();
  if (!name) {
    setAiStyleRefMessage("请填写风格名称", "err");
    return;
  }
  if (sampleText.length < 20) {
    setAiStyleRefMessage("参考文章至少 20 字", "err");
    return;
  }
  if (aiStyleReferencesCache.length >= 20) {
    setAiStyleRefMessage("最多保存 20 个参考风格", "err");
    return;
  }
  const id = `sref_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  aiStyleReferencesCache = [
    {
      id,
      name: name.slice(0, 40),
      sampleText: sampleText.slice(0, 4000),
      createdAt: Date.now(),
    },
    ...aiStyleReferencesCache,
  ];
  if ($("#aiStyleRefNameInput")) $("#aiStyleRefNameInput").value = "";
  if ($("#aiStyleRefTextInput")) $("#aiStyleRefTextInput").value = "";
  renderAiStyleReferencesList();
  refreshHostedStyleOptionsFromReferences();
  setAiStyleRefMessage(`已添加「${name}」，正在保存…`, "info");
  const saved = await saveAiSettingsOnly({ silent: true });
  if (saved) setAiStyleRefMessage(`已添加并保存「${name}」，可在「AI 托管」页选择「参考·${name}」`, "ok");
  else setAiStyleRefMessage(`已添加「${name}」，但自动保存失败，请点「保存 AI 设置」`, "err");
}

function onAiStyleRefListClick(e) {
  const previewBtn = e.target.closest('[data-action="preview-style-ref"]');
  if (previewBtn) {
    const id = previewBtn.closest(".ai-style-ref-item")?.dataset.id;
    const ref = aiStyleReferencesCache.find((item) => item.id === id);
    if (ref) previewAiStyleReference(ref.sampleText, ref.name);
    return;
  }
  const btn = e.target.closest('[data-action="delete-style-ref"]');
  if (!btn) return;
  const id = btn.closest(".ai-style-ref-item")?.dataset.id;
  if (!id) return;
  if (!confirm("确定删除该参考风格？")) return;
  aiStyleReferencesCache = aiStyleReferencesCache.filter((item) => item.id !== id);
  renderAiStyleReferencesList();
  refreshHostedStyleOptionsFromReferences();
  setAiStyleRefMessage("已删除，正在保存…", "info");
  saveAiSettingsOnly({ silent: true }).then((saved) => {
    if (saved) setAiStyleRefMessage("已删除并保存", "ok");
    else setAiStyleRefMessage("已删除，但自动保存失败，请点「保存 AI 设置」", "err");
  });
}

async function onAiStyleRefFileSelected(e) {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  try {
    const text = await file.text();
    if ($("#aiStyleRefTextInput")) $("#aiStyleRefTextInput").value = text.slice(0, 4000);
    if (!$("#aiStyleRefNameInput")?.value.trim()) {
      const base = String(file.name || "").replace(/\.[^.]+$/, "").trim();
      if (base && $("#aiStyleRefNameInput")) $("#aiStyleRefNameInput").value = base.slice(0, 40);
    }
    setAiStyleRefMessage(`已载入文件「${file.name}」，可点「预览生成」或「添加为风格」`, "ok");
  } catch {
    setAiStyleRefMessage("读取文件失败", "err");
  }
}

function collectAiConfigFromUI() {
  return {
    ...collectAiProviderSettingsFromUI(),
    ...collectAiHostingSettingsFromUI(),
  };
}

/** 仅保存「文案风格设置」页：参考风格列表（不影响托管开关与节奏） */
async function saveAiSettingsOnly(overrides = {}, { silent = false } = {}) {
  const payload = { styleReferences: aiStyleReferencesCache, ...overrides };
  if (!silent) showAiSettingsMessage("正在保存风格设置…", "info");
  try {
    const res = await fetch("/api/ai/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const raw = await res.json();
    if (!res.ok) {
      if (!silent) showAiSettingsMessage(raw.error || "保存失败", "err");
      return null;
    }
    const data = normalizeAiConfigResponse(raw);
    await applyAiConfigToUI(data);
    if (!silent) showAiSettingsMessage("风格设置已保存", "ok");
    return data;
  } catch {
    if (!silent) showAiSettingsMessage("无法连接本地服务", "err");
    return null;
  }
}

async function saveAiConfig(overrides = {}, { silent = false } = {}) {
  const payload = { ...collectAiConfigFromUI(), ...overrides };
  if (payload.enabled && !payload.hostedAccounts?.some((item) => item.enabled)) {
    if (!silent) showAiMessage("请至少勾选一个托管账号", "err");
    return null;
  }
  if (payload.enabled && !aiProfilesCache.some((item) => item.enabled && item.hasApiKey)) {
    if (!silent) showAiMessage("请先在「API 管理」中配置至少一个启用的 AI", "err");
    return null;
  }
  if (!payload.apiKey) delete payload.apiKey;
  if (!silent) showAiMessage("正在保存...", "info");
  try {
    const res = await fetch("/api/ai/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const raw = await res.json();
    if (!res.ok) {
      if (!silent) showAiMessage(raw.error || "保存失败", "err");
      return null;
    }
    const data = normalizeAiConfigResponse(raw);
    aiProfilesCache = data.aiProfiles || [];
    defaultAiProfileIdCache = data.defaultAiProfileId || null;
    $("#aiApiKeyInput").value = "";
    await applyAiConfigToUI(data);
    if (activeView === "api") refreshApiAiManagePanel();
    if (!silent) {
      showAiMessage(
        data.enabled
          ? "AI 配置已保存。自动托管已开启，刷新或重启后无需再点，后台会按间隔自动发帖。"
          : "AI 配置已保存",
        "ok",
      );
    }
    return data;
  } catch {
    if (!silent) showAiMessage("无法连接本地服务", "err");
    return null;
  }
}

async function testAiApi() {
  const config = collectAiConfigFromUI();
  const apiKey = config.apiKey;
  showAiSettingsMessage(
    config.model
      ? `正在测试 ${config.model}，若不支持将自动匹配…`
      : "正在自动匹配可用模型…",
    "info",
  );
  try {
    const res = await fetch("/api/ai/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey: apiKey || undefined,
        provider: config.provider,
        baseUrl: config.baseUrl || undefined,
        model: config.model || undefined,
        autoMatch: true,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      showAiSettingsMessage(data.error || "测试失败", "err");
      return;
    }
    const matched = data.matchedModel || data.model || config.model;
    if (matched && $("#aiCustomModelInput")) $("#aiCustomModelInput").value = matched;
    if (matched && $("#aiModelSelect")) {
      const opt = [...($("#aiModelSelect").options || [])].find((item) => item.value === matched);
      if (opt) $("#aiModelSelect").value = matched;
    }
    const switchHint = data.autoSwitched ? `（已自动切换为 ${matched}）` : "";
    showAiSettingsMessage(`${data.message}${switchHint}：${data.preview || ""}`, "ok");
  } catch {
    showAiSettingsMessage("无法连接本地服务", "err");
  }
}

function addDraftsFromAiPosts(generatedPosts, { accountId, accountName } = {}) {
  generatedPosts.forEach((item) => {
    const resolvedAccountId = item.accountId || accountId || getDefaultAccountId();
    const resolvedAccountName = getAccountName(resolvedAccountId) || accountName || "默认账号";
    posts.push({
      id: generateId(),
      text: item.text,
      title: "",
      imagePaths: [],
      accountId: resolvedAccountId,
      accountName: resolvedAccountName,
      selected: true,
      publishState: "draft",
      result: null,
      error: null,
      publishedAt: null,
      createdAt: Date.now(),
    });
  });
  saveDrafts();
  renderPosts();
  updatePublishBtn();
}

async function aiRun({ publish = false } = {}) {
  if (aiRunning) return;
  const config = collectAiConfigFromUI();
  const current = await fetch("/api/ai/config").then((r) => r.json()).catch(() => ({}));
  const hasConfiguredAi =
    current.hasApiKey ||
    (current.aiProfiles || []).some((item) => item.enabled && item.hasApiKey) ||
    aiProfilesCache.some((item) => item.enabled && item.hasApiKey);
  if (!config.apiKey && !hasConfiguredAi) {
    showAiMessage("请先在「API 管理」中配置至少一个 AI", "err");
    return;
  }

  const enabledCount = config.hostedAccounts.filter((item) => item.enabled).length;
  if (!enabledCount) {
    showAiMessage("请至少勾选一个托管账号", "err");
    return;
  }

  const savedConfig = await saveAiConfig(
    publish ? { enabled: true, autoPublish: true } : {},
    { silent: true },
  );
  if (!savedConfig) return;

  const actionText = publish ? "生成并发布" : "生成草稿";
  const btn = publish ? $("#btnAiRunNow") : $("#btnAiGenerateDraft");
  aiRunning = true;
  if (btn) {
    btn.disabled = true;
    btn.dataset.prevText = btn.textContent;
    btn.textContent = "运行中...";
  }
  showAiMessage(`正在${actionText}...`, "info");
  try {
    const res = await fetch("/api/ai/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        publish,
        count: publish ? 1 : config.postsPerRun,
        manual: true,
        allAccounts: !publish,
        provider: config.provider,
        baseUrl: config.baseUrl || undefined,
        model: config.model,
        topic: config.topic,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      showAiMessage(data.error || `${actionText}失败`, "err");
      await refreshAiRuntimeStatus();
      return;
    }

    if (!publish && data.generated?.length) {
      addDraftsFromAiPosts(data.generated, {
        accountId: config.accountId,
        accountName: getAccountName(config.accountId),
      });
    }

    if (publish && data.published?.length) {
      data.published.forEach((item) => {
        const accountId = item.accountId || config.accountId;
        posts.push({
          id: generateId(),
          text: item.text,
          title: "",
          imagePaths: [],
          accountId,
          accountName: getAccountName(accountId),
          selected: false,
          publishState: "published",
          result: item.result,
          error: null,
          publishedAt: Date.now(),
          createdAt: Date.now(),
        });
      });
      saveDrafts();
      renderPosts();
      syncAllLocalPublishedToCache();
    }

    const baseMsg = data.message || `${actionText}完成`;
    if (publish && savedConfig?.enabled) {
      showAiMessage(
        `${baseMsg}。自动托管已开启，后台将每 ${savedConfig.intervalMinutes} 分钟发帖，刷新或重启后无需再点。`,
        "ok",
      );
    } else {
      showAiMessage(baseMsg, "ok");
    }
    await refreshAiRuntimeStatus();
  } catch {
    showAiMessage("无法连接本地服务", "err");
  } finally {
    aiRunning = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = btn.dataset.prevText || btn.textContent;
    }
    const latest = await fetch("/api/ai/config").then((r) => r.json()).catch(() => null);
    if (latest) updateAiHostingButtons(latest);
  }
}

async function aiFillPostModal() {
  const config = collectAiConfigFromUI();
  const hostConfig = config.hostedAccounts.find((item) => item.enabled) || config.hostedAccounts[0];
  const btn = $("#btnAiFillPost");
  const oldText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "生成中...";
  try {
    const payload = {
      count: 1,
      contentStyles: hostConfig?.contentStyles,
      selectedTokens: hostConfig?.selectedTokens,
      marketSentiment: hostConfig?.marketSentiment,
    };
    const profileId = hostConfig?.aiProfileId || defaultAiProfileIdCache;
    if (profileId) {
      payload.aiProfileId = profileId;
    } else {
      payload.apiKey = config.apiKey || undefined;
      payload.provider = config.provider;
      payload.baseUrl = config.baseUrl || undefined;
      payload.model = config.model;
    }
    const res = await fetch("/api/ai/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || "AI 生成失败");
      return;
    }
    const text = data.posts?.[0]?.text;
    if (!text) {
      alert("AI 未返回内容");
      return;
    }
    $("#postText").value = text;
    $("#charCount").textContent = text.length;
  } catch {
    alert("无法连接本地服务");
  } finally {
    btn.disabled = false;
    btn.textContent = oldText;
  }
}

function updatePublishBtn() {
  const selected = getSelectedPosts();
  const selectedCount = selected.length;
  const deletableCount = selected.filter((p) => p.publishState === "draft" || p.publishState === "failed").length;

  const publishBtn = $("#btnPublish");
  publishBtn.disabled = publishing || selectedCount === 0 || !apiConfigured;
  publishBtn.textContent = selectedCount > 0 ? `▶ 发布选中 (${selectedCount})` : "▶ 发布选中";

  const deleteBtn = $("#btnDeleteSelected");
  if (deleteBtn) {
    deleteBtn.disabled = publishing || deletableCount === 0;
    deleteBtn.textContent = deletableCount > 0 ? `删除选中 (${deletableCount})` : "删除选中";
  }
}

function updateDraftStats() {
  const draftCount = countByState("draft") + countByState("failed");
  const publishedCount = countByState("published");
  $("#draftStats").textContent = `${draftCount} 条待发布 · ${publishedCount} 条已发布`;
}

function updateSelectAllCheckbox() {
  const visible = getFilteredPosts().filter((p) => p.publishState !== "publishing");
  const allSelected = visible.length > 0 && visible.every((p) => p.selected);
  const someSelected = visible.some((p) => p.selected);
  const checkbox = $("#selectAllCheckbox");
  checkbox.checked = allSelected;
  checkbox.indeterminate = someSelected && !allSelected;
}

function stateLabel(post) {
  switch (post.publishState) {
    case "published":
      return "已发布";
    case "failed":
      return "发布失败";
    case "publishing":
      return "发布中";
    default:
      return "草稿";
  }
}

function stateClass(post) {
  switch (post.publishState) {
    case "published":
      return "state-published";
    case "failed":
      return "state-failed";
    case "publishing":
      return "state-publishing";
    default:
      return "state-draft";
  }
}

function getPostRef(post) {
  return post.result?.id || post.result?.shareLink || null;
}

function renderCommentsButton(post) {
  const countLabel = post.stats?.commentCount ?? 0;
  return `<button type="button" class="stat-item stat-comments-btn" data-action="toggle-comments" data-id="${post.id}" title="点击查看评论">💬 ${countLabel}${post.commentsExpanded ? " ▾" : ""}</button>`;
}

function renderCommentsPanel(post) {
  if (!post.commentsExpanded || !(post.stats?.commentCount > 0)) return "";

  if (post.commentsLoading) {
    return `<div class="comments-panel loading">正在加载评论...</div>`;
  }

  if (post.commentsError) {
    return `<div class="comments-panel error"><span>${escapeHtml(post.commentsError)}</span> <button type="button" class="btn btn-ghost btn-sm" data-action="reload-comments" data-id="${post.id}">重试</button></div>`;
  }

  const list = post.commentsList || post.stats?.recentComments || [];
  const listHtml =
    list.length > 0
      ? `<div class="recent-comments">${list
          .map(
            (c) =>
              `<div class="comment-item"><span class="comment-author">${escapeHtml(c.author)}</span>${c.time ? `<span class="comment-time">${formatTime(c.time, true)}</span>` : ""}<span class="comment-text">${escapeHtml(c.text)}</span>${c.likeCount != null ? `<span class="comment-like">👍 ${c.likeCount}</span>` : ""}</div>`,
          )
          .join("")}</div>`
      : `<div class="comment-more">${escapeHtml(post.commentsHint || "暂无评论内容")}${post.result?.shareLink ? ` · <a href="${post.result.shareLink}" target="_blank" rel="noopener">在币安查看</a>` : ""}</div>`;

  return `<div class="comments-panel">${listHtml}<button type="button" class="btn btn-ghost btn-sm comments-refresh" data-action="reload-comments" data-id="${post.id}">刷新评论</button></div>`;
}

function renderStatsBlock(post) {
  if (post.publishState !== "published" || !getPostRef(post)) return "";

  if (post.statsLoading) {
    return `<div class="post-stats loading">正在获取互动数据...</div>`;
  }

  if (post.statsError) {
    return `<div class="post-stats error"><span>${escapeHtml(post.statsError)}</span> <button class="btn btn-ghost btn-sm" data-action="refresh-stats" data-id="${post.id}">重试</button></div>`;
  }

  if (!post.stats) {
    return `<div class="post-stats empty"><button class="btn btn-ghost btn-sm" data-action="refresh-stats" data-id="${post.id}">获取浏览/点赞数据</button></div>`;
  }

  const s = post.stats;
  const viewDelta =
    s.viewDelta > 0 ? `<span class="stat-delta">+${s.viewDelta}</span>` : s.viewDelta < 0 ? `<span class="stat-delta">${s.viewDelta}</span>` : "";
  const inlineComments =
    !s.commentCount && s.recentComments?.length > 0
      ? `<div class="recent-comments">${s.recentComments
          .map(
            (c) =>
              `<div class="comment-item"><span class="comment-author">${escapeHtml(c.author)}</span><span class="comment-text">${escapeHtml(c.text)}</span></div>`,
          )
          .join("")}</div>`
      : "";

  return `
    <div class="post-stats">
      <div class="stats-row">
        <span class="stat-item" title="浏览量">👁 ${s.viewCount ?? "-"}${viewDelta}</span>
        <span class="stat-item" title="点赞数">👍 ${s.likeCount ?? "-"}</span>
        ${s.commentCount > 0 ? renderCommentsButton(post) : `<span class="stat-item" title="评论数">💬 ${s.commentCount ?? "-"}</span>`}
        <span class="stat-item" title="分享数">↗ ${s.shareCount ?? "-"}</span>
        <button class="btn btn-ghost btn-sm" data-action="refresh-stats" data-id="${post.id}" ${publishing ? "disabled" : ""}>刷新</button>
      </div>
      ${s.fetchedAt ? `<div class="stats-time">更新于 ${formatTime(s.fetchedAt, true)}</div>` : ""}
      ${renderCommentsPanel(post)}
      ${inlineComments}
    </div>`;
}

function isReviewPendingError(message) {
  return /20012|under review|审核/i.test(message || "");
}

function formatStatsError(message) {
  if (isReviewPendingError(message)) return "内容审核中，互动数据稍后可用";
  return message;
}

async function refreshPostStats(postId, { silent = false, checkAlert = true } = {}) {
  const post = posts.find((p) => p.id === postId);
  if (!post) return false;
  const ref = getPostRef(post);
  if (!ref) {
    if (!silent) alert("该帖子没有可用的链接或 ID");
    return false;
  }

  const prevView = post.stats?.viewCount ?? null;
  post.statsLoading = true;
  post.statsError = null;
  renderPosts();

  try {
    const res = await fetch("/api/post/stats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        shareLink: ref,
        accountId: post.accountId || getDefaultAccountId(),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "获取失败");

    const newStats = data.stats;
    const viewDelta = prevView != null && newStats.viewCount != null ? newStats.viewCount - prevView : 0;
    post.stats = { ...newStats, prevViewCount: prevView, viewDelta };
    post.statsError = null;

    if (checkAlert && prevView != null && viewDelta >= loadMonitorSettings().viewAlertThreshold) {
      addViewAlert(post, prevView, newStats.viewCount, viewDelta);
    }
    return true;
  } catch (err) {
    post.statsError = formatStatsError(err.message);
    const reviewPending = isReviewPendingError(err.message);
    if (!silent && !reviewPending) alert(err.message);
    return false;
  } finally {
    post.statsLoading = false;
    saveDrafts();
    renderPosts();
  }
}

async function loadPostComments(postId, { force = false } = {}) {
  const post = posts.find((p) => p.id === postId);
  if (!post) return false;
  const ref = getPostRef(post);
  if (!ref) {
    post.commentsError = "该帖子没有可用的链接或 ID";
    return false;
  }

  if (!force && post.commentsList?.length) return true;

  post.commentsLoading = true;
  post.commentsError = null;
  renderPosts();

  try {
    const res = await fetch("/api/post/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shareLink: ref, accountId: post.accountId || getDefaultAccountId() }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "加载评论失败");

    post.commentsList = data.comments || [];
    post.commentsHint = data.hint || null;
    post.commentsError = null;

    if (!post.commentsList.length && data.needsLogin) {
      post.commentsHint = data.hint || "请在设置中配置币安 Cookie 后查看评论";
    }
    return true;
  } catch (err) {
    post.commentsError = err.message;
    return false;
  } finally {
    post.commentsLoading = false;
    saveDrafts();
    renderPosts();
  }
}

async function toggleComments(postId) {
  const post = posts.find((p) => p.id === postId);
  if (!post) return;

  if (post.commentsExpanded) {
    post.commentsExpanded = false;
    saveDrafts();
    renderPosts();
    return;
  }

  post.commentsExpanded = true;
  saveDrafts();
  renderPosts();
  await loadPostComments(postId);
}

async function refreshAllStats({ silent = false } = {}) {
  const published = getPublishedPostsForMonitor().filter((p) => getPostRef(p));
  if (!published.length) {
    if (!silent) {
      const accountId = getSelectedMonitorAccountId();
      alert(
        accountId
          ? `账号「${getAccountName(accountId)}」暂无已发布且可查询的帖子`
          : "没有已发布且可查询的帖子",
      );
    }
    return;
  }

  $("#btnRefreshAllStats").disabled = true;
  for (const post of published) {
    await refreshPostStats(post.id, { silent: true, checkAlert: true });
    await new Promise((r) => setTimeout(r, 400));
  }
  $("#btnRefreshAllStats").disabled = false;
  if (!silent) renderAlerts();
}

function postPreview(text, max = 40) {
  const value = (text || "").replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function addViewAlert(post, from, to, delta) {
  const alert = {
    id: generateId(),
    type: "view",
    postId: post.id,
    preview: postPreview(post.text),
    from,
    to,
    delta,
    shareLink: post.result?.shareLink || "",
    time: Date.now(),
  };
  alerts.unshift(alert);
  alerts = alerts.slice(0, MAX_ALERTS);
  saveAlerts();
  renderAlerts();

  const settings = loadMonitorSettings();
  if (settings.notifyBrowser && "Notification" in window && Notification.permission === "granted") {
    new Notification("浏览量上涨提醒", {
      body: `「${alert.preview}」浏览 +${delta}（${from} → ${to}）`,
    });
  }
}

function getFilteredAlerts() {
  const accountId = getSelectedMonitorAccountId();
  if (!accountId) return alerts;
  return alerts.filter((a) => {
    const post = posts.find((p) => p.id === a.postId);
    return post && getPostAccountId(post) === accountId;
  });
}

function renderAlerts() {
  const panel = $("#alertPanel");
  const list = $("#alertList");
  const visible = getFilteredAlerts();
  if (!visible.length) {
    panel.classList.add("hidden");
    list.innerHTML = "";
    return;
  }

  panel.classList.remove("hidden");
  list.innerHTML = visible
    .map(
      (a) => `
    <div class="alert-item">
      <div>📈 <strong>浏览 +${a.delta}</strong>：${escapeHtml(a.preview)}（${a.from} → ${a.to}）
      ${a.shareLink ? `<a href="${a.shareLink}" target="_blank" rel="noopener">查看</a>` : ""}</div>
      <div class="alert-time">${formatTime(a.time, true)}</div>
    </div>`,
    )
    .join("");
}

function clearAlerts() {
  alerts = [];
  saveAlerts();
  renderAlerts();
}

function csvCell(value) {
  const text = value == null ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function exportToExcel() {
  if (!posts.length) return alert("没有可导出的数据");

  const headers = [
    "内容摘要",
    "状态",
    "发布账号",
    "标题",
    "发布时间",
    "帖子链接",
    "帖子ID",
    "浏览量",
    "浏览增量",
    "点赞数",
    "评论数",
    "分享数",
    "数据更新时间",
  ];

  const rows = posts.map((p) => [
    postPreview(p.text, 120),
    stateLabel(p),
    p.accountName || getAccountName(p.accountId),
    p.title || "",
    p.publishedAt ? formatTime(p.publishedAt, true) : "",
    p.result?.shareLink || "",
    p.result?.id || "",
    p.stats?.viewCount ?? "",
    p.stats?.viewDelta ?? "",
    p.stats?.likeCount ?? "",
    p.stats?.commentCount ?? "",
    p.stats?.shareCount ?? "",
    p.stats?.fetchedAt ? formatTime(p.stats.fetchedAt, true) : "",
  ]);

  const csv = [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  a.href = url;
  a.download = `币安广场数据-${stamp}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function buildPostCardHtml(p, index, { selectable = true } = {}) {
  const cardClass = p.publishState === "publishing" ? "status-publishing" : `status-${p.publishState}`;
  const canSelect = selectable && p.publishState !== "publishing";
  return `
    <div class="post-card ${cardClass}" data-id="${p.id}">
      ${
        selectable
          ? `<label class="post-check" title="${canSelect ? "选择发布" : "发布中"}">
        <input type="checkbox" class="post-select" data-id="${p.id}" ${p.selected ? "checked" : ""} ${canSelect ? "" : "disabled"} />
      </label>`
          : ""
      }
      <div class="post-index">${index + 1}</div>
      <div class="post-body">
        ${buildPostAccountBlock(p, { editable: selectable })}
        <div class="post-text">${escapeHtml(p.text)}</div>
        <div class="post-meta">
          <span class="state-badge ${stateClass(p)}">${stateLabel(p)}</span>
          ${p.title ? `<span class="tag">文章: ${escapeHtml(p.title)}</span>` : "<span>短帖</span>"}
          ${p.imagePaths?.length ? `<span>${p.imagePaths.length} 张图片</span>` : ""}
          ${p.publishedAt ? `<span>发布于 ${formatTime(p.publishedAt, true)}</span>` : ""}
          ${p.result?.shareLink ? `<a href="${p.result.shareLink}" target="_blank" rel="noopener">查看链接</a>` : ""}
          ${p.error ? `<span class="error-text">${escapeHtml(p.error)}</span>` : ""}
        </div>
        ${renderStatsBlock(p)}
      </div>
      <div class="post-actions">
        <button class="btn btn-ghost btn-sm" data-action="edit" data-id="${p.id}" ${publishing ? "disabled" : ""}>编辑</button>
        ${p.publishState === "published" && getPostRef(p) ? `<button class="btn btn-ghost btn-sm" data-action="refresh-stats" data-id="${p.id}" ${publishing ? "disabled" : ""}>数据</button>` : ""}
        <button class="btn btn-ghost btn-sm btn-danger" data-action="delete" data-id="${p.id}" ${publishing ? "disabled" : ""}>删除</button>
      </div>
    </div>`;
}

function renderPostListContainer(container, visible, { selectable = true, emptyText = "暂无帖子" } = {}) {
  if (!container) return;
  if (!visible.length) {
    container.innerHTML = `<div class="empty-state"><p>${emptyText}</p></div>`;
    return;
  }
  container.innerHTML = visible.map((p, i) => buildPostCardHtml(p, i, { selectable })).join("");
  container.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      if (btn.dataset.action === "edit") openPostModal(id);
      if (btn.dataset.action === "delete") deletePost(id);
      if (btn.dataset.action === "refresh-stats") refreshPostStats(id);
      if (btn.dataset.action === "toggle-comments") toggleComments(id);
      if (btn.dataset.action === "reload-comments") loadPostComments(id, { force: true });
    });
  });
}

function renderPosts() {
  const draftPosts = getDraftPosts();
  const publishedPosts = getPublishedPosts();
  const monitorPosts = getPublishedPostsForMonitor();
  updateDraftStats();
  updateSelectAllCheckbox();
  updatePublishBtn();
  updateDraftBulkAccountBar();
  updateMonitorSectionHint();

  const draftEmpty =
    posts.length === 0
      ? "暂无帖子，点击「添加帖子」或「导入」开始"
      : currentFilter === "draft"
        ? "暂无草稿"
        : currentFilter === "failed"
          ? "暂无失败帖子"
          : "暂无待发帖子";

  const monitorAccountId = getSelectedMonitorAccountId();
  const monitorQuery = getMonitorSearchQuery();
  const monitorAllForAccount = (accountId) => {
    const published = getPublishedPosts();
    return accountId ? published.filter((p) => getPostAccountId(p) === accountId) : published;
  };
  let monitorEmpty = "暂无已发布帖子，发布后可在此查看互动数据";
  if (monitorAccountId && monitorQuery) {
    monitorEmpty =
      monitorAllForAccount(monitorAccountId).length === 0
        ? `账号「${getAccountName(monitorAccountId)}」暂无已发布帖子`
        : `账号「${getAccountName(monitorAccountId)}」下未找到包含「${monitorQuery}」的帖子`;
  } else if (monitorAccountId) {
    monitorEmpty = `账号「${getAccountName(monitorAccountId)}」暂无已发布帖子`;
  } else if (monitorQuery) {
    monitorEmpty =
      monitorAllForAccount("").length === 0
        ? "暂无已发布帖子，发布后可在此查看互动数据"
        : `未找到包含「${monitorQuery}」的帖子`;
  }

  renderPostListContainer($("#postList"), draftPosts, { selectable: true, emptyText: draftEmpty });
  renderPostListContainer($("#monitorPostList"), monitorPosts, {
    selectable: false,
    emptyText: monitorEmpty,
  });
  renderPostListContainer($("#publishedPostList"), publishedPosts, {
    selectable: false,
    emptyText: "暂无已发布帖子，可点击「拉取广场历史帖子」同步",
  });
  const homePublished = publishedPosts.slice(0, 12);
  renderPostListContainer($("#homePublishedList"), homePublished, {
    selectable: false,
    emptyText: "暂无已发布帖子，去草稿箱发布或拉取广场历史帖子",
  });
  if (activeView === "home") renderHomeDashboard();
}

const TOKEN_PAGE_SIZE = 50;
/** @type {{tokens:Array, chainOptions:Array, sourceOptions:Array, quotes:Map<string, any>, query:string, loading:boolean, settings:object, refreshTimer:any, page:number, seedCount:number}} */
let tokenRegistryState = {
  tokens: [],
  chainOptions: [],
  sourceOptions: [],
  quotes: new Map(),
  query: "",
  loading: false,
  settings: { refreshIntervalSec: 60 },
  refreshTimer: null,
  page: 1,
  seedCount: 20,
};

function setTokenRegistryMessage(text, type = "") {
  const el = $("#tokenRegistryMessage");
  if (!el) return;
  el.textContent = text || "";
  el.className = `message${type ? ` ${type}` : ""}`;
}

function setTokenModalMessage(text, type = "") {
  const el = $("#tokenModalMessage");
  if (!el) return;
  el.textContent = text || "";
  el.className = `message${type ? ` ${type}` : ""}`;
}

function fillTokenSelectOptions() {
  const chainSelect = $("#tokenChainSelect");
  const sourceSelect = $("#tokenSourceSelect");
  if (chainSelect) {
    chainSelect.innerHTML = (tokenRegistryState.chainOptions || [])
      .map((opt) => `<option value="${escapeHtml(opt.id)}">${escapeHtml(opt.label)}</option>`)
      .join("");
  }
  if (sourceSelect) {
    sourceSelect.innerHTML = (tokenRegistryState.sourceOptions || [])
      .map((opt) => `<option value="${escapeHtml(opt.id)}">${escapeHtml(opt.label)}</option>`)
      .join("");
  }
}

function formatTokenChange(changePercent) {
  const n = Number(changePercent);
  if (!Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

function getFilteredTokenRows() {
  const q = String(tokenRegistryState.query || "").trim().toLowerCase();
  return (tokenRegistryState.tokens || []).filter((token) => {
    if (!q) return true;
    return [token.symbol, token.name, token.binanceSymbol, token.contractAddress, token.contractNetwork, token.chain]
      .join(" ")
      .toLowerCase()
      .includes(q);
  });
}

function renderTokenTypeBadge(token) {
  const isAlpha = token.listingType === "alpha" || token.chain === "binance-alpha";
  if (isAlpha) {
    return `<span class="token-type-badge is-alpha" title="币安 Alpha / 合约代币">合约</span>`;
  }
  return `<span class="token-type-badge is-spot" title="币安现货">现货</span>`;
}

function renderTokenRegistryPagination(totalFiltered) {
  const el = $("#tokenRegistryPagination");
  const countEl = $("#tokenRegistryCountText");
  const totalPages = Math.max(1, Math.ceil(totalFiltered / TOKEN_PAGE_SIZE) || 1);
  if (tokenRegistryState.page > totalPages) tokenRegistryState.page = totalPages;
  if (countEl) {
    const withContract = (tokenRegistryState.tokens || []).filter((t) => t.contractAddress).length;
    countEl.textContent = `共 ${tokenRegistryState.tokens.length} 个代币（合约 ${withContract}）· 当前筛选 ${totalFiltered} · 第 ${tokenRegistryState.page}/${totalPages} 页`;
  }
  if (!el) return;
  if (totalPages <= 1) {
    el.innerHTML = "";
    el.classList.add("hidden");
    return;
  }
  el.classList.remove("hidden");
  const page = tokenRegistryState.page;
  el.innerHTML = `
    <button type="button" class="btn btn-ghost btn-sm" data-token-page="1" ${page <= 1 ? "disabled" : ""}>首页</button>
    <button type="button" class="btn btn-ghost btn-sm" data-token-page="${page - 1}" ${page <= 1 ? "disabled" : ""}>上一页</button>
    <span class="muted">${page} / ${totalPages}</span>
    <button type="button" class="btn btn-ghost btn-sm" data-token-page="${page + 1}" ${page >= totalPages ? "disabled" : ""}>下一页</button>
    <button type="button" class="btn btn-ghost btn-sm" data-token-page="${totalPages}" ${page >= totalPages ? "disabled" : ""}>末页</button>
  `;
}

function renderTokenRegistryTable() {
  const body = $("#tokenRegistryBody");
  if (!body) return;
  const rows = getFilteredTokenRows();
  renderTokenRegistryPagination(rows.length);

  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="10" class="muted">${tokenRegistryState.loading ? "加载中…" : "暂无代币，请点「从币安同步全部」"}</td></tr>`;
    return;
  }

  const start = (tokenRegistryState.page - 1) * TOKEN_PAGE_SIZE;
  const pageRows = rows.slice(start, start + TOKEN_PAGE_SIZE);

  body.innerHTML = pageRows
    .map((token) => {
      const quote = tokenRegistryState.quotes.get(String(token.symbol || "").toUpperCase());
      const price = quote ? `$${escapeHtml(String(quote.priceFormatted || quote.price || ""))}` : "—";
      const change = quote ? formatTokenChange(quote.changePercent) : "—";
      const changeClass =
        Number(quote?.changePercent) > 0 ? "ok" : Number(quote?.changePercent) < 0 ? "err" : "muted";
      const contractShort = token.contractAddress
        ? token.contractAddress.length > 16
          ? `${token.contractAddress.slice(0, 8)}…${token.contractAddress.slice(-6)}`
          : token.contractAddress
        : "—";
      const lockMark = token.contractUserEdited
        ? `<span class="token-lock-mark" title="用户已改过，同步不会覆盖">锁</span>`
        : "";
      return `
        <tr class="${token.enabled === false ? "is-disabled" : ""}" data-token-id="${escapeHtml(token.id)}">
          <td><input type="checkbox" data-action="toggle-enabled" ${token.enabled === false ? "" : "checked"} title="启用" /></td>
          <td>${renderTokenTypeBadge(token)}</td>
          <td><strong>$${escapeHtml(token.symbol)}</strong></td>
          <td>${escapeHtml(token.name || token.symbol)}</td>
          <td>${escapeHtml(token.binanceSymbol || `${token.symbol}USDT`)}</td>
          <td title="${escapeHtml(token.contractAddress || "")}"><code class="token-addr">${escapeHtml(contractShort)}</code>${lockMark}</td>
          <td class="muted">${escapeHtml(token.contractNetwork || "—")}</td>
          <td class="num">${price}</td>
          <td class="num ${changeClass}">${change}</td>
          <td class="col-actions">
            <button type="button" class="btn btn-ghost btn-sm" data-action="edit">编辑</button>
            <button type="button" class="btn btn-ghost btn-sm btn-danger" data-action="delete">删除</button>
          </td>
        </tr>`;
    })
    .join("");
}

function stopTokenQuotesAutoRefresh() {
  if (tokenRegistryState.refreshTimer) {
    clearInterval(tokenRegistryState.refreshTimer);
    tokenRegistryState.refreshTimer = null;
  }
}

function applyTokenRefreshIntervalToUi() {
  const input = $("#tokenRefreshIntervalInput");
  if (input) input.value = String(tokenRegistryState.settings?.refreshIntervalSec ?? 60);
}

function startTokenQuotesAutoRefresh() {
  stopTokenQuotesAutoRefresh();
  if (activeView !== "tokens") return;
  const sec = Number(tokenRegistryState.settings?.refreshIntervalSec);
  if (!Number.isFinite(sec) || sec <= 0) return;
  const ms = Math.max(15, sec) * 1000;
  tokenRegistryState.refreshTimer = setInterval(() => {
    if (activeView !== "tokens") {
      stopTokenQuotesAutoRefresh();
      return;
    }
    refreshTokenQuotes(false);
  }, ms);
}

function describeTokenRefreshHint() {
  const sec = Number(tokenRegistryState.settings?.refreshIntervalSec);
  if (!Number.isFinite(sec) || sec <= 0) return "自动刷新已关闭";
  return `每 ${sec} 秒自动从币安公开 API 刷新报价`;
}

async function loadTokenRegistry({ autoSyncIfSeed = true } = {}) {
  tokenRegistryState.loading = true;
  setTokenRegistryMessage("加载代币列表…", "info");
  renderTokenRegistryTable();
  try {
    const res = await fetch("/api/token-registry");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "加载失败");
    tokenRegistryState.tokens = data.tokens || [];
    tokenRegistryState.chainOptions = data.chainOptions || [];
    tokenRegistryState.sourceOptions = data.sourceOptions || [];
    tokenRegistryState.settings = data.settings || { refreshIntervalSec: 60 };
    tokenRegistryState.seedCount = Number(data.seedCount) || 20;
    applyTokenRefreshIntervalToUi();
    fillTokenSelectOptions();
    renderTokenRegistryTable();
    setTokenRegistryMessage(
      `共 ${tokenRegistryState.tokens.length} 个代币。${describeTokenRefreshHint()}。`,
      "info",
    );

    const seedOnly =
      autoSyncIfSeed &&
      tokenRegistryState.tokens.length <= (tokenRegistryState.seedCount || 20) &&
      tokenRegistryState.tokens.every((t) =>
        DEFAULT_AVAILABLE_TOKENS.includes(String(t.symbol || "").toUpperCase()),
      );
    if (seedOnly) {
      setTokenRegistryMessage("检测到仅有默认代币，正在自动从币安同步全部列表…", "info");
      await syncBinanceTokensFromUi({ silentConfirm: true });
      return;
    }

    await refreshTokenQuotes(false);
    startTokenQuotesAutoRefresh();
  } catch (err) {
    setTokenRegistryMessage(err.message || "加载失败", "err");
  } finally {
    tokenRegistryState.loading = false;
  }
}

async function saveTokenRefreshSettings() {
  const sec = Number($("#tokenRefreshIntervalInput")?.value);
  try {
    const res = await fetch("/api/token-registry/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshIntervalSec: sec }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "保存失败");
    tokenRegistryState.settings = data.settings || { refreshIntervalSec: sec };
    applyTokenRefreshIntervalToUi();
    startTokenQuotesAutoRefresh();
    setTokenRegistryMessage(`刷新设置已保存。${describeTokenRefreshHint()}。`, "ok");
  } catch (err) {
    setTokenRegistryMessage(err.message || "保存失败", "err");
  }
}

async function syncBinanceTokensFromUi({ silentConfirm = false } = {}) {
  if (
    !silentConfirm &&
    !confirm(
      "从币安同步全部现货 + Alpha？\n会自动填写合约地址；只有你手动改过的合约不会被覆盖。\n大约需要 10–30 秒，请稍候。",
    )
  ) {
    return;
  }
  const btn = $("#btnSyncBinanceTokens");
  if (btn) btn.disabled = true;
  setTokenRegistryMessage("正在同步：拉取现货列表与合约地址（约 10–30 秒）…", "info");
  try {
    const res = await fetch("/api/token-registry/sync", { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "同步失败");
    if (data.settings) tokenRegistryState.settings = data.settings;
    applyTokenRefreshIntervalToUi();
    setTokenRegistryMessage(
      `同步完成：新增 ${data.added || 0}，回填合约 ${data.contractFilled || 0}，更新合约 ${data.contractUpdated || 0}，共 ${data.total || 0}（现货 ${data.spotPairs || 0} / Alpha ${data.alphaOnly || 0}）。正在刷新列表…`,
      "ok",
    );
    await loadTokenRegistry({ autoSyncIfSeed: false });
  } catch (err) {
    setTokenRegistryMessage(err.message || "同步失败", "err");
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function refreshTokenQuotes(showBusy = true) {
  const requestId = (tokenRegistryState.quoteRequestId = (tokenRegistryState.quoteRequestId || 0) + 1);
  if (showBusy) setTokenRegistryMessage("正在从币安公开 API 刷新报价…", "info");
  try {
    // 优先刷新当前筛选后这一页，避免全量 1000+ 代币卡顿
    const filtered = getFilteredTokenRows();
    const start = (tokenRegistryState.page - 1) * TOKEN_PAGE_SIZE;
    const pageSymbols = filtered.slice(start, start + TOKEN_PAGE_SIZE).map((t) => t.symbol);
    const qs = pageSymbols.length
      ? `?symbols=${encodeURIComponent(pageSymbols.join(","))}`
      : "";
    const res = await fetch(`/api/token-registry/quotes${qs}`);
    const data = await res.json();
    if (requestId !== tokenRegistryState.quoteRequestId) return;
    if (!res.ok) throw new Error(data.error || "刷新报价失败");
    const map = new Map(tokenRegistryState.quotes || []);
    for (const ticker of data.tickers || []) {
      const sym = String(ticker.symbol || "").toUpperCase();
      map.set(sym, {
        ...ticker,
        priceFormatted: formatClientUsdPrice(ticker.price),
      });
    }
    tokenRegistryState.quotes = map;
    renderTokenRegistryTable();
    const missing = (data.missing || []).length;
    const time = new Date().toLocaleTimeString();
    setTokenRegistryMessage(
      missing
        ? `[${time}] 本页报价已刷新（${(data.tickers || []).length}）；${missing} 个暂无数据。${describeTokenRefreshHint()}`
        : `[${time}] 本页报价已刷新（${(data.tickers || []).length}）。${describeTokenRefreshHint()}`,
      missing ? "info" : "ok",
    );
  } catch (err) {
    if (requestId !== tokenRegistryState.quoteRequestId) return;
    setTokenRegistryMessage(err.message || "刷新报价失败", "err");
  }
}

function formatClientUsdPrice(price) {
  const num = Number(price);
  if (!Number.isFinite(num)) return String(price || "");
  if (num >= 1000) return num.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (num >= 1) return num.toFixed(4).replace(/\.?0+$/, "");
  if (num >= 0.01) return num.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  return num.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

function openTokenModal(token = null) {
  fillTokenSelectOptions();
  $("#tokenEditId").value = token?.id || "";
  $("#tokenModalTitle").textContent = token ? `编辑 ${token.symbol}` : "添加代币";
  $("#tokenSymbolInput").value = token?.symbol || "";
  $("#tokenNameInput").value = token?.name || "";
  $("#tokenBinanceSymbolInput").value = token?.binanceSymbol || "";
  $("#tokenContractInput").value = token?.contractAddress || "";
  $("#tokenNotesInput").value = token?.notes || "";
  $("#tokenEnabledInput").checked = token?.enabled !== false;
  if ($("#tokenChainSelect")) $("#tokenChainSelect").value = token?.chain || "binance-spot";
  if ($("#tokenSourceSelect")) $("#tokenSourceSelect").value = token?.source || "auto";
  setTokenModalMessage("");
  openAppModal("tokenModal");
  $("#tokenSymbolInput")?.focus();
}

async function saveTokenFromModal(e) {
  e.preventDefault();
  const id = $("#tokenEditId")?.value || "";
  const payload = {
    id: id || undefined,
    symbol: $("#tokenSymbolInput")?.value || "",
    name: $("#tokenNameInput")?.value || "",
    binanceSymbol: $("#tokenBinanceSymbolInput")?.value || "",
    contractAddress: $("#tokenContractInput")?.value || "",
    chain: $("#tokenChainSelect")?.value || "",
    source: $("#tokenSourceSelect")?.value || "auto",
    notes: $("#tokenNotesInput")?.value || "",
    enabled: Boolean($("#tokenEnabledInput")?.checked),
  };
  setTokenModalMessage("保存中…", "info");
  try {
    const res = await fetch(id ? `/api/token-registry/${encodeURIComponent(id)}` : "/api/token-registry", {
      method: id ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "保存失败");
    $("#tokenModal")?.close();
    await loadTokenRegistry({ autoSyncIfSeed: false });
    setTokenRegistryMessage(`已保存 $${data.token?.symbol || payload.symbol}`, "ok");
  } catch (err) {
    setTokenModalMessage(err.message || "保存失败", "err");
  }
}

async function onTokenRegistryClick(e) {
  const btn = e.target.closest("[data-action]");
  if (!btn || btn.tagName === "INPUT") return;
  const row = btn.closest("tr[data-token-id]");
  const id = row?.dataset.tokenId;
  if (!id) return;
  const token = tokenRegistryState.tokens.find((t) => t.id === id);
  if (!token) return;

  if (btn.dataset.action === "edit") {
    openTokenModal(token);
    return;
  }
  if (btn.dataset.action === "delete") {
    if (!confirm(`确定删除 $${token.symbol}？`)) return;
    try {
      const res = await fetch(`/api/token-registry/${encodeURIComponent(id)}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "删除失败");
      await loadTokenRegistry({ autoSyncIfSeed: false });
      setTokenRegistryMessage(`已删除 $${token.symbol}`, "ok");
    } catch (err) {
      setTokenRegistryMessage(err.message || "删除失败", "err");
    }
  }
}

async function onTokenRegistryChange(e) {
  const input = e.target.closest('input[data-action="toggle-enabled"]');
  if (!input) return;
  const row = input.closest("tr[data-token-id]");
  const id = row?.dataset.tokenId;
  if (!id) return;
  try {
    const res = await fetch(`/api/token-registry/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: input.checked }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "更新失败");
    const idx = tokenRegistryState.tokens.findIndex((t) => t.id === id);
    if (idx >= 0) tokenRegistryState.tokens[idx] = data.token;
    renderTokenRegistryTable();
  } catch (err) {
    input.checked = !input.checked;
    setTokenRegistryMessage(err.message || "更新失败", "err");
  }
}

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str || "";
  return d.innerHTML;
}

function deletePost(id) {
  const post = posts.find((p) => p.id === id);
  if (!post) return;
  const label = post.publishState === "published" ? "已发布帖子" : "帖子";
  if (!confirm(`确定删除这条${label}？`)) return;
  posts = posts.filter((p) => p.id !== id);
  saveDrafts();
  renderPosts();
}

function clearDrafts() {
  const draftPosts = posts.filter((p) => p.publishState === "draft" || p.publishState === "failed");
  if (!draftPosts.length) return alert("没有可清空的草稿");
  if (!confirm(`确定清空 ${draftPosts.length} 条草稿/失败帖子？已发布的帖子会保留。`)) return;
  posts = posts.filter((p) => p.publishState === "published" || p.publishState === "publishing");
  saveDrafts();
  renderPosts();
}

function deleteSelectedDrafts() {
  const selected = getSelectedPosts().filter((p) => p.publishState === "draft" || p.publishState === "failed");
  if (!selected.length) return alert("请先勾选要删除的草稿或失败帖子");
  if (!confirm(`确定删除选中的 ${selected.length} 条帖子？此操作不可恢复。`)) return;
  const ids = new Set(selected.map((p) => p.id));
  posts = posts.filter((p) => !ids.has(p.id));
  saveDrafts();
  renderPosts();
  showAppToast(`已删除 ${selected.length} 条帖子`, "ok");
}

function clearPublished() {
  const publishedPosts = posts.filter((p) => p.publishState === "published");
  if (!publishedPosts.length) return alert("没有已发布的帖子");
  if (!confirm(`确定清空 ${publishedPosts.length} 条已发布记录？草稿会保留。`)) return;
  posts = posts.filter((p) => p.publishState !== "published");
  saveDrafts();
  renderPosts();
}

function selectDraftsOnly() {
  posts.forEach((p) => {
    p.selected = p.publishState === "draft" || p.publishState === "failed";
  });
  saveDrafts();
  renderPosts();
}

function selectNone() {
  posts.forEach((p) => {
    p.selected = false;
  });
  saveDrafts();
  renderPosts();
}

function toggleSelectAll(checked) {
  getFilteredPosts().forEach((p) => {
    if (p.publishState !== "publishing") p.selected = checked;
  });
  saveDrafts();
  renderPosts();
}

function openPostModal(id) {
  $("#editIndex").value = id || "";
  $("#modalTitle").textContent = id ? "编辑帖子" : "添加帖子";
  currentImages = [];
  renderAccountSelectOptions($("#postAccountSelect"), id ? posts.find((p) => p.id === id)?.accountId : getDefaultAccountId());

  if (id) {
    const p = posts.find((post) => post.id === id);
    if (!p) return;
    $("#postText").value = p.text;
    $("#postTitle").value = p.title || "";
    $("#postAccountSelect").value = p.accountId || getDefaultAccountId() || "";
    currentImages = [...(p.imagePaths || [])];
    $("#imagePreview").innerHTML = currentImages.map((imgId) => `<img src="/uploads/${imgId}" alt="preview" />`).join("");
  } else {
    $("#postText").value = "";
    $("#postTitle").value = "";
    $("#postImages").value = "";
    $("#imagePreview").innerHTML = "";
    renderAccountSelectOptions($("#postAccountSelect"), getDefaultAccountId());
  }

  $("#charCount").textContent = $("#postText").value.length;
  openAppModal("postModal");
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ name: file.name, data: reader.result });
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function handleImageSelect(e) {
  const files = Array.from(e.target.files);
  if (!files.length) return;

  try {
    const encoded = await Promise.all(files.map(fileToBase64));
    const res = await fetch("/api/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files: encoded }),
    });
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || "图片上传失败");
      return;
    }

    for (const f of data.files) {
      currentImages.push(f.id);
    }
    renderImagePreview(data.files.map((f) => f.url));
    alert(`图片上传成功（${data.files.length} 张）`);
  } catch (err) {
    alert(`图片上传失败: ${err.message}`);
  }
  e.target.value = "";
}

function renderImagePreview(urls) {
  const container = $("#imagePreview");
  const existing = container.innerHTML;
  const newImgs = urls.map((u) => `<img src="${u}" alt="preview" />`).join("");
  container.innerHTML = existing + newImgs;
}

async function savePostFromModal() {
  const text = $("#postText").value.trim();
  const title = $("#postTitle").value.trim();
  const editId = $("#editIndex").value;
  const accountId = $("#postAccountSelect").value || getDefaultAccountId();
  const accountName = getAccountName(accountId);

  if (!text) return alert("请输入帖子内容");
  if (!accountId) return alert("请先添加并选择发布账号");

  if (editId) {
    const post = posts.find((p) => p.id === editId);
    if (!post) return;
    post.text = text;
    post.title = title;
    post.imagePaths = [...currentImages];
    post.accountId = accountId;
    post.accountName = accountName;
    post.publishState = "draft";
    post.selected = true;
    post.result = null;
    post.error = null;
    post.publishedAt = null;
    post.stats = null;
    post.statsError = null;
  } else {
    posts.push({
      id: generateId(),
      text,
      title,
      imagePaths: [...currentImages],
      accountId,
      accountName,
      selected: true,
      publishState: "draft",
      result: null,
      error: null,
      publishedAt: null,
      createdAt: Date.now(),
    });
  }

  saveDrafts();
  $("#postModal").close();
  renderPosts();
}

async function confirmImport() {
  const activeTab = document.querySelector(".tab.active").dataset.tab;
  const text = activeTab === "json" ? $("#importJson").value : $("#importText").value;
  const format = activeTab === "json" ? "json" : "text";

  const res = await fetch("/api/parse-import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, format }),
  });
  const data = await res.json();
  if (!res.ok) return alert(data.error);

  const defaultAccountId = getDefaultAccountId();
  const defaultAccountName = getAccountName(defaultAccountId);

  for (const item of data.posts) {
    posts.push({
      id: generateId(),
      text: item.text,
      title: item.title || "",
      imagePaths: item.imagePaths || [],
      accountId: defaultAccountId,
      accountName: defaultAccountName,
      selected: true,
      publishState: "draft",
      result: null,
      error: null,
      publishedAt: null,
      createdAt: Date.now(),
    });
  }

  saveDrafts();
  $("#importModal").close();
  renderPosts();
}

async function startBatchPublish() {
  const selected = getSelectedPosts();
  if (publishing || selected.length === 0) return;
  if (!confirm(`确定发布选中的 ${selected.length} 条帖子？`)) return;

  const publishQueue = selected.map((post) => ({
    post,
    payload: {
      text: post.text,
      title: post.title,
      imagePaths: post.imagePaths,
      accountId: post.accountId || getDefaultAccountId(),
    },
  }));

  publishing = true;
  updatePublishBtn();
  switchView("logs");
  $("#progressBar").style.width = "0%";
  $("#progressLog").innerHTML = "";
  log("开始批量发布...", "info");
  appendSystemLog(`开始批量发布 ${selected.length} 条帖子`, "info");
  log("正在校验帖子...", "info");

  publishQueue.forEach(({ post }) => {
    post.publishState = "publishing";
    post.error = null;
  });
  saveDrafts();
  renderPosts();

  const intervalSeconds = parseInt($("#intervalInput").value, 10) || 3;
  const batchPosts = publishQueue.map((item) => item.payload);

  try {
    const validateRes = await fetch("/api/validate-posts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ posts: batchPosts }),
    });
    const validateData = await validateRes.json();
    if (!validateData.ok) {
      publishQueue.forEach(({ post }) => {
        post.publishState = "failed";
        post.error = validateData.errors[0]?.error || validateData.error || "帖子校验失败";
      });
      saveDrafts();
      log(`✗ ${validateData.errors[0]?.error || validateData.error || "帖子校验失败"}`, "err");
      $("#progressText").textContent = "发布失败：请重新上传图片";
      publishing = false;
      renderPosts();
      updatePublishBtn();
      return;
    }

    const res = await fetch("/api/publish/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ posts: batchPosts, intervalSeconds }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      publishQueue.forEach(({ post }) => {
        post.publishState = "failed";
        post.error = err.error || "未知错误";
      });
      saveDrafts();
      log(`✗ 发布失败: ${err.error || "未知错误"}`, "err");
      publishing = false;
      renderPosts();
      updatePublishBtn();
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() || "";

      for (const part of parts) {
        if (!part.trim()) continue;
        const lines = part.split("\n");
        let event = "message";
        let data = "";
        for (const line of lines) {
          if (line.startsWith("event: ")) event = line.slice(7);
          if (line.startsWith("data: ")) data = line.slice(6);
        }
        if (data) handleSSE(event, JSON.parse(data), publishQueue);
      }
    }
  } catch (err) {
    publishQueue.forEach(({ post }) => {
      if (post.publishState === "publishing") {
        post.publishState = "failed";
        post.error = err.message;
      }
    });
    saveDrafts();
    log(`✗ 请求失败: ${err.message}`, "err");
    $("#progressText").textContent = "发布失败，请刷新页面后重试";
    renderPosts();
  }

  publishing = false;
  saveDrafts();
  updatePublishBtn();
}

function handleSSE(event, data, publishQueue) {
  switch (event) {
    case "start":
      $("#progressText").textContent = `共 ${data.total} 条，间隔 ${data.intervalSeconds} 秒`;
      break;

    case "progress":
      if (publishQueue[data.index]) {
        publishQueue[data.index].post.publishState = "publishing";
        saveDrafts();
        renderPosts();
      }
      $("#progressText").textContent = data.message || `正在发布第 ${data.index + 1}/${data.total} 条...`;
      $("#progressBar").style.width = `${(data.index / data.total) * 100}%`;
      if (data.message) log(data.message, "info");
      break;

    case "waiting":
      log(`等待 ${data.seconds} 秒后发布下一条...`, "info");
      break;

    case "result": {
      const item = publishQueue[data.index];
      if (!item) break;
      const post = item.post;
      if (data.ok) {
        post.publishState = "published";
        post.result = data.result;
        post.error = null;
        post.publishedAt = Date.now();
        post.selected = false;
        if (data.accountId) {
          post.accountId = data.accountId;
          post.accountName = getAccountName(data.accountId);
        }
        log(`✓ 第 ${data.index + 1} 条发布成功 ${data.result.shareLink || ""}`, "ok");
        refreshPostStats(post.id, { silent: true });

        const postRef = data.result?.id || data.result?.shareLink;
        const accountId = post.accountId || getDefaultAccountId();
        if (accountId && data.result?.id) {
          syncPublishedPostsToServerCache(accountId, [
            {
              id: data.result.id,
              text: post.text,
              title: post.title || "",
              shareLink: data.result.shareLink,
              publishedAt: Date.now(),
              source: "publish",
            },
          ]);
        }
        if (postRef && accountId) {
          discoverAccountFromPost(accountId, postRef)
            .then(async (discovered) => {
              if (discovered) {
                log(
                  `已识别账号 ${discovered.username ? `@${discovered.username}` : ""}，正在拉取历史已发布帖子...`,
                  "info",
                );
                await showPublishedPostsModal(accountId, { postRef });
              }
            })
            .catch(() => {
              log("发布成功。点击「拉取广场历史帖子」可获取该账号的历史帖子", "info");
            });
        }
      } else {
        post.publishState = "failed";
        post.error = data.error;
        post.selected = true;
        log(`✗ 第 ${data.index + 1} 条失败: ${data.error}`, "err");
      }
      saveDrafts();
      renderPosts();
      break;
    }

    case "error":
      log(`⚠ ${data.message}`, "err");
      break;

    case "done":
      $("#progressBar").style.width = "100%";
      $("#progressText").textContent = `完成！成功 ${data.succeeded} 条，失败 ${data.failed} 条`;
      log(`批量发布完成: 成功 ${data.succeeded} / 失败 ${data.failed}`, "info");
      saveDrafts();
      break;
  }
}

function log(msg, type) {
  const el = document.createElement("div");
  el.className = `log-line ${type}`;
  el.textContent = msg;
  $("#progressLog")?.appendChild(el);
  if ($("#progressLog")) $("#progressLog").scrollTop = $("#progressLog").scrollHeight;
  appendSystemLog(msg, type);
}

init();
