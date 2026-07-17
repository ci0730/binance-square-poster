import fs from "fs";
import os from "os";
import path from "path";

/** 需要从旧目录带入新软件的用户配置 / 缓存文件 */
export const USER_DATA_FILE_NAMES = [
  "accounts.json",
  "settings.json",
  "ai-settings.json",
  "published-posts-cache.json",
  "token-registry.json",
  "openapi-key",
  "device-binding.json",
];

const MARKER_NAME = ".migrated-config-import-v2";

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
}

function fileMtimeMs(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function accountRichness(store) {
  if (!store || !Array.isArray(store.accounts)) return 0;
  return store.accounts.reduce((score, account) => {
    if (!account || typeof account !== "object") return score;
    let item = 1;
    if (String(account.apiKey || "").trim()) item += 3;
    if (String(account.cookie || "").trim()) item += 2;
    if (String(account.proxy || "").trim() || account.proxyConfig) item += 1;
    return score + item;
  }, 0);
}

function aiSettingsRichness(settings) {
  if (!settings || typeof settings !== "object") return 0;
  let score = 0;
  const profiles = Array.isArray(settings.aiProfiles) ? settings.aiProfiles : [];
  score += profiles.length * 2;
  for (const profile of profiles) {
    if (String(profile?.apiKey || "").trim()) score += 3;
  }
  if (String(settings.apiKey || "").trim()) score += 3;
  const hosted = Array.isArray(settings.hostedAccounts) ? settings.hostedAccounts : [];
  score += hosted.length * 2;
  if (Array.isArray(settings.styleReferences)) score += settings.styleReferences.length;
  if (settings.totalPublished) score += Math.min(Number(settings.totalPublished) || 0, 20);
  return score;
}

function settingsRichness(settings) {
  if (!settings || typeof settings !== "object") return 0;
  let score = 0;
  if (String(settings.proxy || "").trim()) score += 2;
  if (settings.proxyConfig && typeof settings.proxyConfig === "object") score += 1;
  if (String(settings.binanceCookie || "").trim()) score += 3;
  if (String(settings.browserPath || "").trim()) score += 1;
  return score;
}

function mergeAccountsJson(srcPath, destPath) {
  const src = readJson(srcPath);
  if (!src || !Array.isArray(src.accounts) || !src.accounts.length) return false;

  const dest = readJson(destPath);
  const destAccounts = Array.isArray(dest?.accounts) ? dest.accounts : [];
  if (!destAccounts.length) {
    writeJson(destPath, src);
    return true;
  }

  const byId = new Map();
  for (const account of destAccounts) {
    if (account?.id) byId.set(String(account.id), account);
  }

  let changed = false;
  for (const account of src.accounts) {
    if (!account?.id) continue;
    const id = String(account.id);
    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, account);
      changed = true;
      continue;
    }
    const next = { ...existing };
    for (const key of ["name", "apiKey", "cookie", "username", "proxy", "proxyConfig", "squareUid", "anchorPostId"]) {
      const srcVal = account[key];
      const destVal = existing[key];
      const srcEmpty =
        srcVal == null ||
        (typeof srcVal === "string" && !srcVal.trim()) ||
        (typeof srcVal === "object" && !Object.keys(srcVal || {}).length);
      const destEmpty =
        destVal == null ||
        (typeof destVal === "string" && !destVal.trim()) ||
        (typeof destVal === "object" && !Object.keys(destVal || {}).length);
      if (!srcEmpty && destEmpty) {
        next[key] = srcVal;
        changed = true;
      }
    }
    byId.set(id, next);
  }

  // 目标几乎是空壳、源明显更完整时，整体采用更完整的一方，避免只合并出残缺默认账号
  if (accountRichness(src) > accountRichness({ accounts: [...byId.values()] }) * 1.5) {
    writeJson(destPath, src);
    return true;
  }

  if (!changed) return false;

  const accounts = [...byId.values()];
  let defaultAccountId = dest?.defaultAccountId || src.defaultAccountId || null;
  if (defaultAccountId && !accounts.some((item) => item.id === defaultAccountId)) {
    defaultAccountId = accounts[0]?.id || null;
  }
  if (!defaultAccountId && accounts.length) defaultAccountId = accounts[0].id;
  writeJson(destPath, { defaultAccountId, accounts });
  return true;
}

function preferProfileName(existingName, incomingName) {
  const existing = String(existingName || "").trim();
  const incoming = String(incomingName || "").trim();
  if (existing && !incoming) return existing;
  if (incoming && !existing) return incoming;
  if (!existing && !incoming) return "";
  const existingIsDefault = /（默认）$/.test(existing) || /\(default\)$/i.test(existing);
  const incomingIsDefault = /（默认）$/.test(incoming) || /\(default\)$/i.test(incoming);
  // 保留用户自定义备注，避免被「某某（默认）」盖掉
  if (!existingIsDefault && incomingIsDefault) return existing;
  if (existingIsDefault && !incomingIsDefault) return incoming;
  return existing || incoming;
}

function mergeAiProfileRecord(existing, incoming) {
  if (!existing) return incoming;
  if (!incoming) return existing;
  const merged = {
    ...existing,
    ...incoming,
    apiKey: String(existing.apiKey || "").trim() || String(incoming.apiKey || "").trim(),
    name: preferProfileName(existing.name, incoming.name),
  };
  if (!String(merged.baseUrl || "").trim() && String(existing.baseUrl || "").trim()) {
    merged.baseUrl = existing.baseUrl;
  }
  if (!String(merged.model || "").trim() && String(existing.model || "").trim()) {
    merged.model = existing.model;
  }
  return merged;
}

function mergeAiSettingsJson(srcPath, destPath) {
  const src = readJson(srcPath);
  if (!src || typeof src !== "object") return false;

  if (!fs.existsSync(destPath)) {
    writeJson(destPath, src);
    return true;
  }

  const dest = readJson(destPath);
  if (!dest || typeof dest !== "object") {
    writeJson(destPath, src);
    return true;
  }

  if (aiSettingsRichness(src) <= aiSettingsRichness(dest)) {
    // 仍合并缺失的 AI profile
    const destProfiles = Array.isArray(dest.aiProfiles) ? [...dest.aiProfiles] : [];
    const byId = new Map(destProfiles.filter((p) => p?.id).map((p) => [String(p.id), p]));
    let changed = false;
    for (const profile of Array.isArray(src.aiProfiles) ? src.aiProfiles : []) {
      if (!profile?.id) continue;
      const id = String(profile.id);
      if (!byId.has(id)) {
        byId.set(id, profile);
        changed = true;
      } else {
        const before = byId.get(id);
        const next = mergeAiProfileRecord(before, profile);
        if (JSON.stringify(before) !== JSON.stringify(next)) {
          byId.set(id, next);
          changed = true;
        }
      }
    }
    if (!changed) return false;
    dest.aiProfiles = [...byId.values()];
    if (!dest.defaultAiProfileId && src.defaultAiProfileId) {
      dest.defaultAiProfileId = src.defaultAiProfileId;
    }
    writeJson(destPath, dest);
    return true;
  }

  // 源更完整：以源为底，补上目标里源没有的 profile
  const merged = { ...dest, ...src };
  const byId = new Map();
  for (const profile of Array.isArray(dest.aiProfiles) ? dest.aiProfiles : []) {
    if (profile?.id) byId.set(String(profile.id), profile);
  }
  for (const profile of Array.isArray(src.aiProfiles) ? src.aiProfiles : []) {
    if (!profile?.id) continue;
    const id = String(profile.id);
    byId.set(id, mergeAiProfileRecord(byId.get(id), profile));
  }
  merged.aiProfiles = [...byId.values()];
  if (!merged.defaultAiProfileId) {
    merged.defaultAiProfileId = src.defaultAiProfileId || dest.defaultAiProfileId || merged.aiProfiles[0]?.id || null;
  }
  writeJson(destPath, merged);
  return true;
}

function mergeSettingsJson(srcPath, destPath) {
  const src = readJson(srcPath);
  if (!src || typeof src !== "object") return false;

  if (!fs.existsSync(destPath)) {
    writeJson(destPath, src);
    return true;
  }

  const dest = readJson(destPath) || {};
  if (settingsRichness(src) <= settingsRichness(dest)) {
    let changed = false;
    const next = { ...dest };
    for (const key of ["proxy", "binanceCookie", "browserPath"]) {
      if (!String(next[key] || "").trim() && String(src[key] || "").trim()) {
        next[key] = src[key];
        changed = true;
      }
    }
    if ((!next.proxyConfig || !next.proxyConfig.host) && src.proxyConfig?.host) {
      next.proxyConfig = src.proxyConfig;
      changed = true;
    }
    if (!changed) return false;
    writeJson(destPath, next);
    return true;
  }

  writeJson(destPath, { ...dest, ...src });
  return true;
}

function preferRicherOrNewerFile(srcPath, destPath) {
  if (!fs.existsSync(srcPath)) return false;
  if (!fs.existsSync(destPath)) {
    ensureDir(path.dirname(destPath));
    fs.copyFileSync(srcPath, destPath);
    return true;
  }

  const srcSize = fileSize(srcPath);
  const destSize = fileSize(destPath);
  if (srcSize <= 0) return false;
  if (destSize <= 0 && srcSize > 0) {
    fs.copyFileSync(srcPath, destPath);
    return true;
  }
  // 明显更大，或同量级但更新
  if (srcSize > destSize * 1.2 || (srcSize >= destSize && fileMtimeMs(srcPath) > fileMtimeMs(destPath))) {
    fs.copyFileSync(srcPath, destPath);
    return true;
  }
  return false;
}

function copyMissingTree(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) return 0;
  ensureDir(destDir);
  let count = 0;
  for (const name of fs.readdirSync(srcDir)) {
    const src = path.join(srcDir, name);
    const dest = path.join(destDir, name);
    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
      count += copyMissingTree(src, dest);
      continue;
    }
    if (!fs.existsSync(dest)) {
      fs.copyFileSync(src, dest);
      count += 1;
    }
  }
  return count;
}

function importOneFile(name, srcDir, destDir) {
  const srcPath = path.join(srcDir, name);
  const destPath = path.join(destDir, name);
  if (!fs.existsSync(srcPath)) return false;

  if (name === "accounts.json") return mergeAccountsJson(srcPath, destPath);
  if (name === "ai-settings.json") return mergeAiSettingsJson(srcPath, destPath);
  if (name === "settings.json") return mergeSettingsJson(srcPath, destPath);
  if (name === "openapi-key" || name === "device-binding.json") {
    if (!fs.existsSync(destPath) || fileSize(destPath) === 0) {
      ensureDir(destDir);
      fs.copyFileSync(srcPath, destPath);
      return true;
    }
    return false;
  }
  return preferRicherOrNewerFile(srcPath, destPath);
}

/**
 * 从旧数据目录把用户配置合并进当前目录。
 * 可重复执行：已有更完整数据时不会用空壳覆盖。
 */
export function importUserConfigFromDir(fromDir, toDir) {
  const from = path.resolve(fromDir || "");
  const to = path.resolve(toDir || "");
  if (!from || !to || from === to) return { migrated: false, files: 0, details: [] };
  if (!fs.existsSync(from)) return { migrated: false, files: 0, details: [] };

  ensureDir(to);
  const details = [];

  for (const name of USER_DATA_FILE_NAMES) {
    try {
      if (importOneFile(name, from, to)) details.push(name);
    } catch {
      // 单文件失败不阻断其余迁移
    }
  }

  try {
    const uploadsCopied = copyMissingTree(path.join(from, "uploads"), path.join(to, "uploads"));
    if (uploadsCopied > 0) details.push(`uploads(${uploadsCopied})`);
  } catch {
    // ignore
  }

  return { migrated: details.length > 0, files: details.length, details };
}

export function listDefaultLegacyDataDirs({ installDataDir = null } = {}) {
  const dirs = [];
  const legacyHome = path.join(os.homedir(), ".config", "binance-square");
  if (installDataDir) dirs.push(installDataDir);
  dirs.push(legacyHome);

  const extra = String(process.env.BINANCE_SQUARE_LEGACY_DATA_DIRS || "")
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
  dirs.push(...extra);

  const seen = new Set();
  return dirs.filter((dir) => {
    const resolved = path.resolve(dir);
    if (seen.has(resolved)) return false;
    seen.add(resolved);
    return true;
  });
}

/**
 * 启动时把已知旧目录配置带入当前数据目录。
 * 使用 v2 标记保证升级用户会再跑一遍智能合并；之后若目标账号仍为空也会继续补齐。
 */
export function migrateUserConfigIntoDataDir(targetDir, { installDataDir = null, sourceDirs = null } = {}) {
  const to = path.resolve(targetDir || "");
  if (!to) return { migrated: false, files: 0, sources: [] };

  ensureDir(to);
  const marker = path.join(to, MARKER_NAME);
  const alreadyMarked = fs.existsSync(marker);

  const sources = (Array.isArray(sourceDirs) ? sourceDirs : listDefaultLegacyDataDirs({ installDataDir }))
    .map((dir) => path.resolve(dir))
    .filter((resolved, index, arr) => {
      if (!resolved || resolved === to) return false;
      if (!fs.existsSync(resolved)) return false;
      return arr.indexOf(resolved) === index;
    });

  const needForceEmptyAccountsRescue = (() => {
    const accounts = readJson(path.join(to, "accounts.json"));
    const count = Array.isArray(accounts?.accounts) ? accounts.accounts.length : 0;
    return count === 0;
  })();

  // 已完成 v2 且本地已有账号时，不再反复扫描（避免每次启动读盘）
  if (alreadyMarked && !needForceEmptyAccountsRescue) {
    return { migrated: false, files: 0, sources: [] };
  }

  const importedFrom = [];
  let files = 0;
  for (const source of sources) {
    const result = importUserConfigFromDir(source, to);
    if (result.migrated) {
      files += result.files;
      importedFrom.push({ dir: source, details: result.details });
    }
  }

  if (!alreadyMarked || importedFrom.length) {
    const lines = [
      `migratedAt=${new Date().toISOString()}`,
      `files=${files}`,
      ...importedFrom.map((item) => `from=${item.dir};details=${item.details.join(",")}`),
    ];
    fs.writeFileSync(marker, `${lines.join("\n")}\n`, "utf8");
  }

  return { migrated: importedFrom.length > 0, files, sources: importedFrom };
}
