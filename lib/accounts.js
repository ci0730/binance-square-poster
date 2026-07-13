import fs from "fs";
import path from "path";
import { readSavedApiKey, readSettings, getProxyUrl } from "./square-api.js";
import { getConfigDir } from "./app-paths.js";
import {
  normalizeProxyConfig,
  buildProxyUrl,
  getProxyDisplayLabel,
  maskProxyPassword,
  isCustomProxyConfig,
} from "./proxy-config.js";

const accountsFile = () => path.join(getConfigDir(), "accounts.json");
const legacyConfigFile = () => path.join(getConfigDir(), "openapi-key");

function maskApiKey(apiKey) {
  if (!apiKey) return "";
  if (apiKey.length <= 9) return `${apiKey.slice(0, 2)}...`;
  return `${apiKey.slice(0, 5)}...${apiKey.slice(-4)}`;
}

function generateAccountId() {
  return `acc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function emptyStore() {
  return { defaultAccountId: null, accounts: [] };
}

function readStoreRaw() {
  if (!fs.existsSync(accountsFile())) return null;
  try {
    return JSON.parse(fs.readFileSync(accountsFile(), "utf8"));
  } catch {
    return null;
  }
}

function writeStore(store) {
  fs.mkdirSync(getConfigDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(accountsFile(), JSON.stringify(store, null, 2), { mode: 0o600 });
}

function migrateLegacyIfNeeded() {
  if (readStoreRaw()) return;

  const legacyKey = fs.existsSync(legacyConfigFile())
    ? fs.readFileSync(legacyConfigFile(), "utf8").trim()
    : readSavedApiKey();
  const settings = readSettings();
  const legacyCookie = settings.binanceCookie || "";

  if (!legacyKey && !legacyCookie) {
    writeStore(emptyStore());
    return;
  }

  const id = generateAccountId();
  writeStore({
    defaultAccountId: id,
    accounts: [
      {
        id,
        name: "默认账号",
        apiKey: legacyKey,
        cookie: legacyCookie,
        createdAt: Date.now(),
      },
    ],
  });
}

function maybeUpgradeDirectAccountProxy(account) {
  const config = normalizeProxyConfig(account.proxyConfig, account.proxy);
  if (config.type !== "direct" || isCustomProxyConfig(config)) return config;
  if (!getProxyUrl()) return config;

  const upgraded = { type: "global", host: "", port: "", username: "", password: "" };
  account.proxyConfig = upgraded;
  account.proxy = "";
  return upgraded;
}

function readStore() {
  migrateLegacyIfNeeded();
  const raw = readStoreRaw();
  if (!raw || !Array.isArray(raw.accounts)) return emptyStore();

  let storeChanged = false;
  const accounts = raw.accounts
    .filter((a) => a && a.id)
    .map((a) => {
      const account = {
        id: String(a.id),
        name: String(a.name || "未命名账号").trim() || "未命名账号",
        apiKey: String(a.apiKey || "").trim(),
        cookie: String(a.cookie || "").trim(),
        username: String(a.username || "").trim(),
        proxy: String(a.proxy || "").trim(),
        proxyConfig: normalizeProxyConfig(a.proxyConfig, a.proxy),
        squareUid: String(a.squareUid || "").trim(),
        anchorPostId: String(a.anchorPostId || "").trim(),
        createdAt: a.createdAt || Date.now(),
      };
      const beforeType = account.proxyConfig.type;
      account.proxyConfig = maybeUpgradeDirectAccountProxy(account);
      if (beforeType === "direct" && account.proxyConfig.type === "global") {
        storeChanged = true;
      }
      return account;
    });

  let defaultAccountId = raw.defaultAccountId || null;
  if (defaultAccountId && !accounts.some((a) => a.id === defaultAccountId)) {
    defaultAccountId = accounts[0]?.id || null;
  }
  if (!defaultAccountId && accounts.length) defaultAccountId = accounts[0].id;

  const store = { defaultAccountId, accounts };
  if (storeChanged) saveStore(store);
  return store;
}

export function describeAccountProxyNetworkHint(accountId, message = "") {
  if (!/无法连接|ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|超时|fetch failed|socket hang up/i.test(message)) {
    return "";
  }
  const config = getAccountProxyConfig(accountId);
  if (config.type !== "direct") return "";
  if (!getProxyUrl()) return "";
  return " 当前账号为「直连」模式，不会使用设置页的全局代理。请在「账号管理」→ 编辑账号 → 将代理方式改为「使用全局代理」。";
}

function saveStore(store) {
  writeStore(store);
}

export function listAccountsPublic() {
  const store = readStore();
  return {
    defaultAccountId: store.defaultAccountId,
    accounts: store.accounts.map((a) => {
      const proxyConfig = normalizeProxyConfig(a.proxyConfig, a.proxy);
      return {
        id: a.id,
        name: a.name,
        maskedKey: a.apiKey ? maskApiKey(a.apiKey) : "",
        hasApiKey: Boolean(a.apiKey),
        hasCookie: Boolean(a.cookie),
        proxy: buildProxyUrl(proxyConfig) || a.proxy || "",
        proxyConfig: maskProxyPassword(proxyConfig),
        proxyLabel: getProxyDisplayLabel(proxyConfig),
        hasProxy: proxyConfig.type === "direct" || isCustomProxyConfig(proxyConfig),
        isDirectProxy: proxyConfig.type === "direct",
        username: a.username || "",
        hasSquareUid: Boolean(a.squareUid),
        hasAnchorPost: Boolean(a.anchorPostId),
        createdAt: a.createdAt,
        isDefault: a.id === store.defaultAccountId,
      };
    }),
  };
}

export function getAccount(accountId) {
  const store = readStore();
  return store.accounts.find((a) => a.id === accountId) || null;
}

export function getDefaultAccountId() {
  return readStore().defaultAccountId;
}

export function getDefaultAccountApiKey() {
  const store = readStore();
  const account = store.accounts.find((a) => a.id === store.defaultAccountId);
  return account?.apiKey || "";
}

export function resolveAccountApiKey(accountId) {
  const store = readStore();
  const id = accountId || store.defaultAccountId;
  if (!id) throw new Error("未配置账号，请先在设置中添加账号");

  const account = store.accounts.find((a) => a.id === id);
  if (!account) throw new Error("账号不存在");
  if (!account.apiKey) throw new Error(`账号「${account.name}」未配置 API Key`);
  return account.apiKey;
}

export function getAccountCookie(accountId) {
  const store = readStore();
  const id = accountId || store.defaultAccountId;
  if (!id) return "";
  return store.accounts.find((a) => a.id === id)?.cookie || "";
}

export function hasAnyAccountConfigured() {
  const store = readStore();
  return store.accounts.some((a) => a.apiKey);
}

export function getAccountProxyConfig(accountId) {
  const account = getAccount(accountId);
  return normalizeProxyConfig(account?.proxyConfig, account?.proxy);
}

function normalizeAccountProxyConfig(config) {
  const next = normalizeProxyConfig(config);
  if (next.type === "global" || next.type === "direct") {
    next.host = "";
    next.port = "";
    next.username = "";
    if (next.type === "global") next.password = "";
  }
  return next;
}

export function resolveAccountProxy(accountId) {
  const store = readStore();
  const id = accountId || store.defaultAccountId;
  if (!id) return getProxyUrl();
  const account = store.accounts.find((a) => a.id === id);
  const config = normalizeProxyConfig(account?.proxyConfig, account?.proxy);
  if (config.type === "direct") return "";
  if (config.type === "global") return getProxyUrl();
  const built = buildProxyUrl(config);
  return built || getProxyUrl();
}

export function mergeAccountProxyCredentials(accountId, config) {
  const normalized = normalizeProxyConfig(config);
  if (!accountId || normalized.password || !isCustomProxyConfig(normalized)) {
    return normalized;
  }
  const account = getAccount(accountId);
  if (!account?.proxyConfig?.password) return normalized;
  return { ...normalized, password: account.proxyConfig.password };
}

export function resolveProxyUrlFromBody(body = {}) {
  if (!body?.proxyConfig) {
    if (body?.accountId) return resolveAccountProxy(body.accountId);
    return getProxyUrl();
  }

  let config = normalizeProxyConfig(body.proxyConfig, body.proxy);
  if (body.accountId) {
    config = mergeAccountProxyCredentials(body.accountId, config);
  }

  if (config.type === "direct") return "";
  if (config.type === "global") return getProxyUrl();
  if (isCustomProxyConfig(config)) {
    const url = buildProxyUrl(config);
    if (!url) throw new Error("请填写完整的代理主机和端口");
    return url;
  }
  return getProxyUrl();
}

function assertValidProxyConfig(config) {
  if (isCustomProxyConfig(config) && (!config.host || !config.port)) {
    throw new Error("自定义代理需填写主机和端口");
  }
}

export function createAccount({ name, apiKey, cookie = "", username = "", proxy = "", proxyConfig = null }) {
  const key = String(apiKey || "").trim();
  if (!key) throw new Error("API Key 不能为空");

  const store = readStore();
  const normalizedProxy = normalizeAccountProxyConfig(normalizeProxyConfig(proxyConfig, proxy));
  assertValidProxyConfig(normalizedProxy);
  const account = {
    id: generateAccountId(),
    name: String(name || `账号 ${store.accounts.length + 1}`).trim() || `账号 ${store.accounts.length + 1}`,
    apiKey: key,
    cookie: String(cookie || "").trim(),
    username: String(username || "").trim(),
    proxy: buildProxyUrl(normalizedProxy),
    proxyConfig: normalizedProxy,
    squareUid: "",
    anchorPostId: "",
    createdAt: Date.now(),
  };
  store.accounts.push(account);
  if (!store.defaultAccountId) store.defaultAccountId = account.id;
  saveStore(store);
  return account;
}

export function updateAccount(accountId, patch) {
  const store = readStore();
  const account = store.accounts.find((a) => a.id === accountId);
  if (!account) throw new Error("账号不存在");

  if (patch.name != null) {
    account.name = String(patch.name).trim() || account.name;
  }
  if (patch.apiKey != null) {
    const key = String(patch.apiKey).trim();
    if (!key) throw new Error("API Key 不能为空");
    account.apiKey = key;
  }
  if (patch.cookie != null) {
    account.cookie = String(patch.cookie).trim();
  }
  if (patch.username != null) {
    account.username = String(patch.username).trim();
  }
  if (patch.proxyConfig != null) {
    const next = normalizeAccountProxyConfig(normalizeProxyConfig(patch.proxyConfig, patch.proxy ?? account.proxy));
    if (next.password === "******") {
      next.password = account.proxyConfig?.password || "";
    }
    if (!next.password && account.proxyConfig?.password) {
      next.password = account.proxyConfig.password;
    }
    assertValidProxyConfig(next);
    account.proxyConfig = next;
    account.proxy = buildProxyUrl(account.proxyConfig);
  } else if (patch.proxy != null) {
    account.proxy = String(patch.proxy).trim();
    account.proxyConfig = normalizeProxyConfig(account.proxyConfig, account.proxy);
    account.proxy = buildProxyUrl(account.proxyConfig) || account.proxy;
  }
  if (patch.squareUid != null) {
    account.squareUid = String(patch.squareUid).trim();
  }
  if (patch.anchorPostId != null) {
    account.anchorPostId = String(patch.anchorPostId).trim();
  }

  saveStore(store);
  return account;
}

export function deleteAccount(accountId) {
  const store = readStore();
  const index = store.accounts.findIndex((a) => a.id === accountId);
  if (index < 0) throw new Error("账号不存在");
  if (store.accounts.length <= 1) throw new Error("至少保留一个账号");

  store.accounts.splice(index, 1);
  if (store.defaultAccountId === accountId) {
    store.defaultAccountId = store.accounts[0]?.id || null;
  }
  saveStore(store);
  return { defaultAccountId: store.defaultAccountId };
}

export function setDefaultAccount(accountId) {
  const store = readStore();
  if (!store.accounts.some((a) => a.id === accountId)) throw new Error("账号不存在");
  store.defaultAccountId = accountId;
  saveStore(store);
  return accountId;
}

export function getAccountName(accountId) {
  const account = getAccount(accountId);
  return account?.name || "未知账号";
}
