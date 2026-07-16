import fs from "fs";
import path from "path";
import { URL } from "url";
import { transportFetch, isTransientNetworkError } from "./http-transport.js";
import { toChineseError } from "./error-zh.js";
import { getConfigDir } from "./app-paths.js";
import {
  normalizeProxyConfig,
  buildProxyUrl,
  getProxyDisplayLabel,
  maskProxyPassword,
  isCustomProxyConfig,
  isBlankProxyPassword,
} from "./proxy-config.js";
import {
  getWindowsSystemProxyUrl,
  getWindowsSystemProxyPublic,
  clearWindowsSystemProxyCache,
} from "./system-proxy.js";

const BASE_URL_V1 = "https://www.binance.com/bapi/composite/v1/public/pgc/openApi";
const BASE_URL_V2 = "https://www.binance.com/bapi/composite/v2/public/pgc/openApi";
const OPENAPI_PRIVATE_BASE = "https://www.binance.com/bapi/composite/v1/private/pgc/openApi";
const POLL_INTERVAL_MS = 1200;
const MAX_POLL_RETRIES = 12;
const CONFIG_FILE = () => path.join(getConfigDir(), "openapi-key");
const SETTINGS_FILE = () => path.join(getConfigDir(), "settings.json");
const PROXY_GUIDE_DISMISSED_FILE = () => path.join(getConfigDir(), ".proxy-guide-dismissed");

const CONTENT_TYPE_MAP = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  mp4: "video/mp4",
  mov: "video/quicktime",
  avi: "video/x-msvideo",
  webm: "video/webm",
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function readSettings() {
  if (!fs.existsSync(SETTINGS_FILE())) {
    return { proxy: "", proxyConfig: null, binanceCookie: "", browserPath: "" };
  }
  try {
    const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE(), "utf8"));
    return {
      proxy: settings.proxy || "",
      proxyConfig: settings.proxyConfig || null,
      binanceCookie: settings.binanceCookie || "",
      browserPath: settings.browserPath || "",
    };
  } catch {
    return { proxy: "", proxyConfig: null, binanceCookie: "", browserPath: "" };
  }
}

export function saveSettings(settings) {
  fs.mkdirSync(getConfigDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(settings, null, 2), { mode: 0o600 });
}

export function mergeGlobalProxyCredentials(config) {
  const normalized = normalizeProxyConfig(config);
  if (!isCustomProxyConfig(normalized)) return normalized;
  if (!isBlankProxyPassword(normalized.password)) return normalized;
  const stored = getGlobalProxyConfig();
  if (!isBlankProxyPassword(stored.password)) {
    return { ...normalized, password: stored.password };
  }
  return normalized;
}

export function getGlobalProxyConfig() {
  const settings = readSettings();
  let config = normalizeProxyConfig(settings.proxyConfig, settings.proxy);
  if (config.type === "global" && settings.proxy) {
    config = normalizeProxyConfig(null, settings.proxy);
  }
  if (config.type === "global") {
    return { type: "http", host: "", port: "", username: "", password: "" };
  }
  return config;
}

export function isProxyExplicitlyConfigured() {
  const settings = readSettings();
  const config = normalizeProxyConfig(settings.proxyConfig, settings.proxy);
  if (config.type === "direct") return true;
  if (isCustomProxyConfig(config) && config.host && config.port) return true;
  return false;
}

export function needsProxySetup() {
  if (isProxyExplicitlyConfigured()) return false;
  if (getWindowsSystemProxyUrl()) return false;
  if (fs.existsSync(PROXY_GUIDE_DISMISSED_FILE())) return false;
  return true;
}

export function dismissProxyGuide() {
  fs.mkdirSync(getConfigDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    PROXY_GUIDE_DISMISSED_FILE(),
    `dismissedAt=${new Date().toISOString()}\n`,
    { mode: 0o600 },
  );
}

export function applySystemProxyConfig() {
  const systemProxy = getWindowsSystemProxyPublic();
  if (!systemProxy) throw new Error("未检测到 Windows 系统代理，请手动填写");
  return saveProxyConfig({
    type: systemProxy.type,
    host: systemProxy.host,
    port: systemProxy.port,
    username: "",
    password: "",
  });
}

function resolveProxySource(config, proxyUrl) {
  if (config.type === "direct") return "direct";
  if (isCustomProxyConfig(config) && config.host && config.port) return "configured";
  if (proxyUrl && getWindowsSystemProxyUrl() === proxyUrl) return "system";
  if (proxyUrl && (process.env.HTTPS_PROXY || process.env.HTTP_PROXY)) return "env";
  return proxyUrl ? "system" : "none";
}

export function getGlobalProxyConfigPublic() {
  const config = getGlobalProxyConfig();
  const proxyUrl = getProxyUrl();
  const systemProxy = getWindowsSystemProxyPublic();
  const explicitLabel = getProxyDisplayLabel(config);
  let proxyLabel = explicitLabel;

  if (!isCustomProxyConfig(config) || !config.host || !config.port) {
    if (config.type !== "direct" && systemProxy) proxyLabel = systemProxy.proxyLabel;
    else if (config.type !== "direct" && !proxyUrl) proxyLabel = "未配置";
  }

  return {
    ...maskProxyPassword(config),
    proxyLabel,
    proxyUrl: proxyUrl || null,
    proxySource: resolveProxySource(config, proxyUrl),
    systemProxy,
    needsProxySetup: needsProxySetup(),
  };
}

export function getProxyUrl() {
  const config = getGlobalProxyConfig();
  if (config.type === "direct") return "";
  const built = buildProxyUrl(config);
  if (built) return built;

  const envProxy = (process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "").trim();
  if (envProxy) return envProxy;

  return getWindowsSystemProxyUrl();
}

export function resolveRequestProxy(proxyUrl) {
  if (proxyUrl === undefined || proxyUrl === null) {
    return getProxyUrl();
  }
  return proxyUrl;
}

export function resolveEffectiveProxy(proxyUrl) {
  if (proxyUrl === undefined || proxyUrl === null) {
    return getProxyUrl();
  }
  if (proxyUrl === "__direct__") return "";
  return proxyUrl;
}

export function saveProxyConfig(proxyConfig = {}) {
  const settings = readSettings();
  const current = getGlobalProxyConfig();
  const next = normalizeProxyConfig(proxyConfig, "");
  if (next.type === "global") next.type = "http";
  if (!next.password && current.password) next.password = current.password;
  settings.proxyConfig = next;
  settings.proxy = buildProxyUrl(next);
  saveSettings(settings);
  clearWindowsSystemProxyCache();
  return getGlobalProxyConfigPublic();
}

export function saveProxy(proxy) {
  const legacy = String(proxy || "").trim();
  if (!legacy) {
    return saveProxyConfig({ type: "direct", host: "", port: "", username: "", password: "" });
  }
  return saveProxyConfig(normalizeProxyConfig(null, legacy));
}

export function getBinanceCookie() {
  return (readSettings().binanceCookie || "").trim();
}

export function saveBinanceCookie(cookie) {
  const settings = readSettings();
  settings.binanceCookie = cookie.trim();
  saveSettings(settings);
}

export function getBrowserPath() {
  return (readSettings().browserPath || "").trim();
}

export function saveBrowserPath(browserPath) {
  const settings = readSettings();
  settings.browserPath = String(browserPath || "").trim();
  saveSettings(settings);
  return settings.browserPath;
}

export function hasBinanceCookie() {
  return Boolean(getBinanceCookie());
}

function requestDirect(url, options) {
  return transportFetch(url, { ...options, proxyUrl: "" });
}

function requestViaProxy(url, options, proxyUrl) {
  return transportFetch(url, { ...options, proxyUrl });
}

async function httpFetch(url, options = {}) {
  const target = new URL(url);
  const isBinance = target.hostname.includes("binance.com");
  const proxy =
    options.proxyUrl !== undefined ? options.proxyUrl : isBinance ? getProxyUrl() : "";
  const { proxyUrl: _proxyUrl, ...fetchOptions } = options;
  try {
    return await transportFetch(url, { ...fetchOptions, proxyUrl: proxy });
  } catch (err) {
    const msg = toChineseError(err);
    if (isTransientNetworkError(err.message || "") || isTransientNetworkError(msg)) {
      // 已是带排查步骤的完整说明时直接抛出，避免再叠一层「无法连接…」
      if (/请检查|请换|换一个节点|Socks5 代理拒绝|代理类型可能选错|未授权|访问被拒绝/.test(msg)) {
        const next = new Error(msg);
        next.code = err?.code;
        next.cause = err;
        throw next;
      }
      const proxyHint = proxy
        ? `当前走代理访问币安失败。请检查：① 代理是否开启；② IP/端口/账号密码；③ VPN 换节点后重试。原始原因：${msg}`
        : "国内网络通常无法直连币安。请在设置中配置代理，或开启梯子后使用系统代理，再重试。";
      const next = new Error(proxy ? proxyHint : `无法连接币安 API：${proxyHint}`);
      next.code = err?.code;
      next.cause = err;
      throw next;
    }
    const next = new Error(msg);
    next.code = err?.code;
    next.cause = err;
    throw next;
  }
}

export async function binanceFetch(url, options = {}) {
  return httpFetch(url, options);
}

export function getContentType(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return CONTENT_TYPE_MAP[ext] || "application/octet-stream";
}

export function maskApiKey(apiKey) {
  if (!apiKey) return "";
  if (apiKey.length <= 9) return `${apiKey.slice(0, 2)}...`;
  return `${apiKey.slice(0, 5)}...${apiKey.slice(-4)}`;
}

export function readSavedApiKey() {
  if (!fs.existsSync(CONFIG_FILE())) return "";
  return fs.readFileSync(CONFIG_FILE(), "utf8").trim();
}

export function saveApiKey(apiKey) {
  const key = apiKey.trim();
  if (!key) throw new Error("API Key 不能为空");

  fs.mkdirSync(getConfigDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_FILE(), `${key}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(CONFIG_FILE(), 0o600);
  } catch {
    // Windows may not support chmod
  }
  return CONFIG_FILE();
}

export function resolveApiKey(overrideKey) {
  if (overrideKey?.trim()) return overrideKey.trim();
  const envKey = process.env.BINANCE_SQUARE_OPENAPI_KEY;
  if (envKey?.trim()) return envKey.trim();
  const savedKey = readSavedApiKey();
  if (savedKey) return savedKey;
  throw new Error("未配置 API Key，请先在设置中添加账号");
}

async function parseOpenApiResponse(res, raw, endpoint = "") {
  if (endpoint === "/content/add" && res.status === 504) {
    return { id: null, shareLink: null, publishStatus: "success_without_post_id" };
  }

  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`API 返回非 JSON 响应: ${res.status} ${res.statusText}`);
  }
  if (json.code !== "000000") {
    throw new Error(`[${json.code}] ${json.message || "请求失败"}`);
  }
  return json.data;
}

async function api(endpoint, apiKey, body, baseUrl = BASE_URL_V2, proxyUrl = "", fetchOpts = {}) {
  const res = await httpFetch(`${baseUrl}${endpoint}`, {
    method: "POST",
    headers: {
      "X-Square-OpenAPI-Key": apiKey,
      "Content-Type": "application/json",
      clienttype: "binanceSkill",
    },
    body: JSON.stringify(body),
    proxyUrl,
    retryUnsafe: endpoint !== "/content/add",
    ...fetchOpts,
  });
  const raw = await res.text();
  return parseOpenApiResponse(res, raw, endpoint);
}

export async function openApiPrivateRequest(apiKey, endpoint, body = {}, cookie = "", proxyUrl = "") {
  const headers = {
    "X-Square-OpenAPI-Key": apiKey,
    "Content-Type": "application/json",
    clienttype: "binanceSkill",
  };
  if (cookie) headers.Cookie = cookie;

  const res = await httpFetch(`${OPENAPI_PRIVATE_BASE}${endpoint}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    proxyUrl,
    retryUnsafe: true,
  });
  const raw = await res.text();
  return parseOpenApiResponse(res, raw, endpoint);
}

function pickIdentity(data) {
  if (!data || typeof data !== "object") return null;
  const squareUid = data.squareUid || data.squareAuthorId || null;
  const username = data.username || null;
  const displayName = data.displayName || data.nickname || data.name || null;
  if (!squareUid && !username && !displayName) return null;
  return { squareUid, username, displayName };
}

export async function resolveCreatorFromOpenApiKey(apiKey, cookie = "", proxyUrl = "") {
  if (!apiKey) throw new Error("API Key 不能为空");

  const attempts = [
    ["/user/info", {}],
    ["/user/client", {}],
    ["/creator/info", {}],
    ["/openapi/getUserInfo", {}],
    ["/account/getOpenApiUser", {}],
  ];

  let lastError = null;
  for (const [endpoint, body] of attempts) {
    try {
      const data = await openApiPrivateRequest(apiKey, endpoint, body, cookie, proxyUrl);
      const identity = pickIdentity(data);
      if (identity) return identity;
    } catch (err) {
      lastError = err;
    }
  }

  if (!cookie) {
    throw new Error(
      "无法仅凭 API Key 识别账号。请在同一账号下同时配置币安 Cookie（与 API Key 属于同一币安登录账号），系统会自动识别用户名并拉取已发布帖子。",
    );
  }
  throw lastError || new Error("无法从 API Key 识别账号信息，请确认 Cookie 与 API Key 属于同一账号");
}

function extractPostItems(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  return data.contents || data.list || data.records || data.items || data.vos || [];
}

export async function fetchPublishedPostsFromOpenApi(apiKey, { cookie = "", limit = 20, proxyUrl = "" } = {}) {
  const pageSize = Math.max(1, Math.min(limit, 50));
  const attempts = [
    ["/content/list", { pageIndex: 1, pageSize, filterType: "ALL" }],
    ["/content/queryList", { pageIndex: 1, pageSize }],
    ["/content/page", { pageIndex: 1, pageSize }],
  ];

  let lastError = null;
  for (const [endpoint, body] of attempts) {
    try {
      const data = await openApiPrivateRequest(apiKey, endpoint, body, cookie, proxyUrl);
      const items = extractPostItems(data);
      if (items.length) return items;
    } catch (err) {
      lastError = err;
    }
  }

  if (lastError) throw lastError;
  return [];
}

async function uploadToS3(presignedUrl, filePath, contentType) {
  const fileBuffer = fs.readFileSync(filePath);
  // S3 预签名 URL 直连上传，不走代理
  const res = await requestDirect(presignedUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: fileBuffer,
  });
  if (!res.ok) {
    throw new Error(`图片上传失败: ${res.status} ${res.statusText}`);
  }
}

async function pollImageStatus(apiKey, fileTicket, proxyUrl = "") {
  for (let i = 0; i < MAX_POLL_RETRIES; i++) {
    const data = await api("/image/imageStatus", apiKey, { fileTicket }, BASE_URL_V2, proxyUrl);
    if (data.status === 1) return data;
    if (data.status === 2) throw new Error(`图片处理失败: ${data.failedReason}`);
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`图片处理超时（${MAX_POLL_RETRIES} 次轮询）`);
}

async function uploadImage(apiKey, imgPath, proxyUrl = "") {
  const imageName = path.basename(imgPath);
  const contentTypeHeader = getContentType(imgPath);
  const { presignedUrl, fileTicket } = await api("/image/presignedUrl", apiKey, { imageName }, BASE_URL_V2, proxyUrl);
  await uploadToS3(presignedUrl, imgPath, contentTypeHeader);
  const imageStatus = await pollImageStatus(apiKey, fileTicket, proxyUrl);
  return imageStatus.imageUrl;
}

export function isDefinitelyUnsentPublishError(err) {
  const codes = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "EPROTO"]);
  let current = err;
  const messages = [];
  for (let depth = 0; current && depth < 5; depth++) {
    if (codes.has(String(current.code || "").toUpperCase())) return true;
    messages.push(String(current.message || ""));
    current = current.cause;
  }
  return /代理连接失败|代理拒绝连接|无法解析域名|连接被拒绝|代理未开启|端口错误|账号密码可能错误|TLS 握手失败|证书校验失败|协议错误/.test(
    messages.join(" "),
  );
}

async function publish(apiKey, body, proxyUrl = "") {
  try {
    // 发帖属于不可幂等操作。连接中断时不盲目重发，避免同一内容被发布两次。
    return await api("/content/add", apiKey, body, BASE_URL_V1, proxyUrl, {
      retries: false,
      retryUnsafe: false,
    });
  } catch (err) {
    const message = String(err?.message || err || "");
    if (isDefinitelyUnsentPublishError(err)) throw err;
    if (isTransientNetworkError(message) || /超时|连接|代理|TLS|socket|重置|中断/i.test(message)) {
      const uncertain = new Error(
        "帖子已提交，但连接在收到确认前中断。为避免重复发帖，软件没有自动重发；请先到「已发布帖子」拉取广场记录确认结果。",
      );
      uncertain.code = "PUBLISH_CONFIRMATION_UNKNOWN";
      uncertain.cause = err;
      throw uncertain;
    }
    throw err;
  }
}

function resolveImagePath(imgPath, uploadsDir) {
  if (path.isAbsolute(imgPath)) return imgPath;
  const inUploads = path.join(uploadsDir, path.basename(imgPath));
  if (fs.existsSync(inUploads)) return inUploads;
  if (fs.existsSync(imgPath)) return imgPath;
  throw new Error(`图片文件不存在: ${path.basename(imgPath)}，请重新上传图片`);
}

export async function publishPost(apiKey, post, uploadsDir, onProgress, options = {}) {
  const proxyUrl = options.proxyUrl || "";
  const { text, title, imagePaths = [] } = post;
  if (!text?.trim()) throw new Error("帖子内容不能为空");

  const contentType = title ? 2 : 1;
  const body = { contentType, bodyTextOnly: text.trim() };

  if (title) {
    body.title = title.trim();
    if (imagePaths.length === 0) throw new Error("长文章需要封面图片");
    if (imagePaths.length > 1) throw new Error("长文章仅支持 1 张封面图");
    onProgress?.({ stage: "uploading_image", message: "正在上传封面图片..." });
    body.cover = await uploadImage(apiKey, resolveImagePath(imagePaths[0], uploadsDir), proxyUrl);
  } else if (imagePaths.length > 0) {
    if (imagePaths.length > 4) throw new Error("最多 4 张图片");
    const uploaded = [];
    for (let i = 0; i < imagePaths.length; i++) {
      onProgress?.({ stage: "uploading_image", message: `正在上传图片 ${i + 1}/${imagePaths.length}...` });
      uploaded.push(await uploadImage(apiKey, resolveImagePath(imagePaths[i], uploadsDir), proxyUrl));
    }
    body.imageList = uploaded;
  }

  onProgress?.({ stage: "publishing", message: "正在提交帖子..." });
  const result = await publish(apiKey, body, proxyUrl);
  return {
    id: result.id ?? null,
    shareLink: result.shareLink ?? null,
    publishStatus: result.publishStatus ?? "success",
  };
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function testApiKey(apiKey, { proxyUrl = "" } = {}) {
  const key = String(apiKey || "").trim();
  if (!key) throw new Error("API Key 不能为空");

  // 经代理访问币安常有偶发抖动：短暂重试，避免“同一节点有时成功有时失败”
  const maxAttempts = proxyUrl ? 3 : 2;
  const timeoutMs = proxyUrl ? 15000 : 12000;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const data = await api(
        "/image/presignedUrl",
        key,
        { imageName: "test.png" },
        BASE_URL_V2,
        proxyUrl,
        { timeoutMs, retries: false },
      );
      return data ?? true;
    } catch (err) {
      lastError = err;
      const msg = err?.message || String(err || "");
      // 业务错误（Key 无效等）不要重试；网络抖动才重试
      if (/\[\d{6}\]/.test(msg) && !/超时|连接|代理|TLS|socket/i.test(msg)) {
        throw err;
      }
      if (/未授权|Unauthorized|无效|非法/.test(msg) && !/超时|连接|代理|TLS|socket/i.test(msg)) {
        throw err;
      }
      if (!isTransientNetworkError(msg) && !/超时|连接被|代理|TLS|socket|重置|中断/i.test(msg)) {
        throw err;
      }
      if (attempt < maxAttempts) await sleepMs(400 * attempt);
    }
  }

  const reason = toChineseError(lastError);
  if (/超时|连接|代理|TLS|socket|重置|中断/i.test(reason)) {
    throw new Error(
      `${reason}（同一代理地区也可能偶发，已自动重试 ${maxAttempts} 次仍失败。一般不是 Key 丢了，可稍后再点「验证 Key」，或换节点后重试）`,
    );
  }
  throw lastError || new Error("API Key 验证失败");
}

export async function testNetwork({ proxyUrl } = {}) {
  const effectiveProxy = proxyUrl !== undefined ? proxyUrl : getProxyUrl();
  const res = await httpFetch(`${BASE_URL_V2}/image/presignedUrl`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      clienttype: "binanceSkill",
      "X-Square-OpenAPI-Key": "network-test",
    },
    body: JSON.stringify({ imageName: "test.png" }),
    proxyUrl: effectiveProxy,
    timeoutMs: 12000,
    retries: false,
  });
  await res.text();
  return true;
}
