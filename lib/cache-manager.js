/**
 * 设置页「清理缓存」：统计与清理软件产生的缓存数据。
 * 账号配置 / AI 配置单独展示，不通过此处删除。
 */
import fs from "fs";
import path from "path";
import { getConfigDir, getUploadsDir } from "./app-paths.js";
import { listAccountsPublic } from "./accounts.js";
import { getAiSettingsPublic } from "./ai-settings.js";
import { listTokenRegistryPublic } from "./token-registry.js";
import { listSystemLogs, clearSystemLogs } from "./system-log.js";
import { clearMarketAndNewsCaches, getRuntimeCacheStats } from "./crypto-context.js";
import { clearScreenshotMemoryCache } from "./site-screenshots.js";

function fileSize(filePath) {
  try {
    if (!fs.existsSync(filePath)) return 0;
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function dirStats(dirPath) {
  let bytes = 0;
  let files = 0;
  if (!dirPath || !fs.existsSync(dirPath)) return { bytes, files };
  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      try {
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (entry.isFile()) {
          files += 1;
          bytes += fs.statSync(full).size;
        }
      } catch {
        // ignore locked/missing
      }
    }
  };
  walk(dirPath);
  return { bytes, files };
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function countPublishedPosts(store) {
  if (!store?.accounts || typeof store.accounts !== "object") return 0;
  return Object.values(store.accounts).reduce((sum, bucket) => {
    const posts = Array.isArray(bucket?.posts) ? bucket.posts.length : 0;
    return sum + posts;
  }, 0);
}

function removeFileIfExists(filePath) {
  if (!fs.existsSync(filePath)) return false;
  fs.rmSync(filePath, { force: true });
  return true;
}

function clearDirectoryContents(dirPath) {
  if (!dirPath || !fs.existsSync(dirPath)) return 0;
  let removed = 0;
  for (const name of fs.readdirSync(dirPath)) {
    const full = path.join(dirPath, name);
    try {
      fs.rmSync(full, { recursive: true, force: true });
      removed += 1;
    } catch {
      // skip locked
    }
  }
  return removed;
}

export function getCacheOverview(appRoot = "") {
  const configDir = getConfigDir();
  const uploadsDir = getUploadsDir(appRoot);
  const accounts = listAccountsPublic();
  const ai = getAiSettingsPublic();
  const tokens = listTokenRegistryPublic();
  const postsFile = path.join(configDir, "published-posts-cache.json");
  const postsStore = readJsonSafe(postsFile);
  const postsCount = countPublishedPosts(postsStore);
  const uploads = dirStats(uploadsDir);
  const tokenFile = path.join(configDir, "token-registry.json");
  const accountsFile = path.join(configDir, "accounts.json");
  const aiFile = path.join(configDir, "ai-settings.json");
  const runtime = getRuntimeCacheStats();
  const logs = listSystemLogs({ sinceId: 0, limit: 300 });

  const protectedItems = [
    {
      id: "accounts",
      label: "账号配置",
      description: "账号 API Key、Cookie、代理等，请到「账号管理」修改；此处仅展示占用，不会清理",
      detail: `${accounts.accounts?.length || 0} 个账号`,
      bytes: fileSize(accountsFile) + fileSize(path.join(configDir, "openapi-key")),
      sizeLabel: formatBytes(fileSize(accountsFile) + fileSize(path.join(configDir, "openapi-key"))),
      clearable: false,
    },
    {
      id: "ai",
      label: "AI 配置",
      description: "AI 服务商、模型、托管与文案风格，请到「AI 托管」修改；此处仅展示占用，不会清理",
      detail: `${ai.aiProfiles?.length || 0} 个配置档 · 托管账号 ${
        (ai.hostedAccounts || []).filter((a) => a.enabled).length
      } 个`,
      bytes: fileSize(aiFile),
      sizeLabel: formatBytes(fileSize(aiFile)),
      clearable: false,
    },
  ];

  const cacheItems = [
    {
      id: "posts",
      label: "已发布帖子缓存",
      description: "各账号广场历史帖本地缓存，清理后需重新拉取",
      detail: `${postsCount} 条`,
      bytes: fileSize(postsFile),
      sizeLabel: formatBytes(fileSize(postsFile)),
      clearable: true,
      checked: true,
    },
    {
      id: "uploads",
      label: "上传图片 / 自动配图",
      description: "草稿附图、新闻图、网站截图等本地文件",
      detail: `${uploads.files} 个文件`,
      bytes: uploads.bytes,
      sizeLabel: formatBytes(uploads.bytes),
      clearable: true,
      checked: true,
    },
    {
      id: "tokens",
      label: "代币地址列表",
      description: "代币注册表本地数据，清理后需重新添加或同步",
      detail: `${tokens.tokens?.length || tokens.items?.length || 0} 条`,
      bytes: fileSize(tokenFile),
      sizeLabel: formatBytes(fileSize(tokenFile)),
      clearable: true,
      checked: false,
    },
    {
      id: "runtime",
      label: "运行时行情 / 资讯缓存",
      description: "内存中的新闻、行情与截图短缓存，清理后下次会重新拉取",
      detail: runtime.detail,
      bytes: 0,
      sizeLabel: "内存",
      clearable: true,
      checked: true,
    },
    {
      id: "logs",
      label: "运行日志",
      description: "内存中的系统/托管日志，不影响账号与 AI 配置",
      detail: `${logs.length} 条`,
      bytes: 0,
      sizeLabel: "内存",
      clearable: true,
      checked: true,
    },
  ];

  const clearableBytes = cacheItems.reduce((sum, item) => sum + (item.bytes || 0), 0);

  return {
    dataDir: configDir,
    uploadsDir,
    protectedItems,
    cacheItems,
    totalClearableBytes: clearableBytes,
    totalClearableLabel: formatBytes(clearableBytes),
  };
}

/**
 * @param {string[]} ids
 * @param {string} appRoot
 */
export function clearCacheItems(ids = [], appRoot = "") {
  const wanted = new Set((ids || []).map((id) => String(id || "").trim()).filter(Boolean));
  // 明确拒绝清理账号 / AI 配置
  wanted.delete("accounts");
  wanted.delete("ai");

  const configDir = getConfigDir();
  const uploadsDir = getUploadsDir(appRoot);
  const cleared = [];
  const skipped = [];

  if (wanted.has("posts")) {
    const file = path.join(configDir, "published-posts-cache.json");
    if (removeFileIfExists(file)) cleared.push("posts");
    else skipped.push({ id: "posts", reason: "无缓存文件" });
  }

  if (wanted.has("uploads")) {
    const n = clearDirectoryContents(uploadsDir);
    cleared.push("uploads");
    if (!n) skipped.push({ id: "uploads", reason: "目录已空" });
  }

  if (wanted.has("tokens")) {
    const file = path.join(configDir, "token-registry.json");
    if (removeFileIfExists(file)) cleared.push("tokens");
    else skipped.push({ id: "tokens", reason: "无缓存文件" });
  }

  if (wanted.has("runtime")) {
    clearMarketAndNewsCaches();
    clearScreenshotMemoryCache();
    cleared.push("runtime");
  }

  if (wanted.has("logs")) {
    clearSystemLogs();
    cleared.push("logs");
  }

  return {
    ok: true,
    cleared: [...new Set(cleared)],
    skipped,
    overview: getCacheOverview(appRoot),
  };
}
