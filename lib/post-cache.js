import fs from "fs";
import path from "path";
import { getConfigDir } from "./app-paths.js";

const cacheFile = () => path.join(getConfigDir(), "published-posts-cache.json");
const lockFile = () => `${cacheFile()}.lock`;

function emptyStore() {
  return { accounts: {} };
}

function readStoreRaw() {
  if (!fs.existsSync(cacheFile())) return null;
  try {
    return JSON.parse(fs.readFileSync(cacheFile(), "utf8"));
  } catch {
    return null;
  }
}

function readStore() {
  const raw = readStoreRaw();
  if (!raw || typeof raw.accounts !== "object") return emptyStore();
  return { accounts: raw.accounts };
}

function writeStore(store) {
  fs.mkdirSync(getConfigDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(cacheFile(), JSON.stringify(store, null, 2), { mode: 0o600 });
}

/**
 * 同步文件锁：所有缓存写入共用，避免并行刷新/发帖/本地 sync 互相覆盖。
 * Windows 下用 'wx' 独占创建锁文件。
 */
function withCacheFileLock(fn) {
  const lockPath = lockFile();
  const dir = path.dirname(lockPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const started = Date.now();
  let fd = null;
  while (fd == null) {
    try {
      fd = fs.openSync(lockPath, "wx");
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      // 锁超时：可能是进程崩溃残留
      if (Date.now() - started > 8000) {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // ignore
        }
        if (Date.now() - started > 12000) {
          throw new Error("帖子缓存繁忙，请稍后重试");
        }
      }
      // 短睡等待锁释放（同步）
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }

  try {
    return fn();
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // ignore
    }
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // ignore
    }
  }
}

/** 在锁内 read → mutate → write，保证并行安全 */
function mutateStore(mutator) {
  return withCacheFileLock(() => {
    const store = readStore();
    const result = mutator(store);
    writeStore(store);
    return result;
  });
}

function extractPostId(ref) {
  if (!ref) return null;
  const value = String(ref).trim();
  if (/^\d+$/.test(value)) return value;
  const patterns = [/\/post\/(\d+)/i, /\/cpos\/(\d+)/i, /contentId=(\d+)/i];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function normalizePost(post) {
  const rawId = post?.id != null ? String(post.id) : extractPostId(post?.shareLink || post?.webLink);
  if (!rawId) return null;
  // 禁止 assumed_ 占位进入已发布缓存（否则历史拉取会混入假 ID，无法点「数据」）
  if (/^assumed_/i.test(rawId)) return null;
  const realId = /^\d+$/.test(rawId) ? rawId : extractPostId(rawId);
  if (!realId) return null;
  const incomingLink = String(post.shareLink || post.webLink || "").trim();
  const safeLink =
    incomingLink && extractPostId(incomingLink)
      ? incomingLink
      : `https://www.binance.com/zh-CN/square/post/${realId}`;
  return {
    id: realId,
    text: String(post.text || post.bodyTextOnly || "").trim() || "(无正文)",
    title: String(post.title || "").trim(),
    shareLink: safeLink,
    contentType: post.contentType ?? null,
    viewCount: post.viewCount ?? null,
    likeCount: post.likeCount ?? null,
    commentCount: post.commentCount ?? null,
    shareCount: post.shareCount ?? null,
    publishedAt: post.publishedAt || post.createTime || Date.now(),
    cachedAt: post.cachedAt || Date.now(),
    source: post.source || "local",
  };
}

/** 合并帖子时：新数据里互动为 null/undefined 时保留缓存里已拉取的浏览量等 */
function mergePostRecord(existing, incoming) {
  if (!existing) return { ...incoming, cachedAt: Date.now() };
  const next = { ...existing, ...incoming, cachedAt: Date.now() };
  for (const key of ["viewCount", "likeCount", "commentCount", "shareCount"]) {
    if (incoming[key] == null && existing[key] != null) {
      next[key] = existing[key];
    }
  }
  // 正文为空占位时不要盖掉已有正文
  if ((!incoming.text || incoming.text === "(无正文)") && existing.text) {
    next.text = existing.text;
  }
  return next;
}

function accountBucket(store, accountId) {
  if (!store.accounts[accountId]) {
    store.accounts[accountId] = { posts: [], updatedAt: Date.now() };
  }
  return store.accounts[accountId];
}

export function getCachedPosts(accountId, { limit = 50 } = {}) {
  const store = readStore();
  const bucket = store.accounts[accountId];
  if (!bucket?.posts?.length) return [];
  return bucket.posts
    .filter((p) => /^\d+$/.test(String(p?.id || "")))
    .slice()
    .sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0))
    .slice(0, limit);
}

/** 清理缓存里历史遗留的 assumed_ 假 ID */
export function scrubAssumedCachedPosts() {
  return mutateStore((store) => {
    let removed = 0;
    for (const bucket of Object.values(store.accounts || {})) {
      if (!bucket?.posts?.length) continue;
      const before = bucket.posts.length;
      bucket.posts = bucket.posts.filter((p) => /^\d+$/.test(String(p?.id || "")));
      removed += before - bucket.posts.length;
      bucket.updatedAt = Date.now();
    }
    return removed;
  });
}

export function cachePublishedPost(accountId, post) {
  if (!accountId) return null;
  const normalized = normalizePost(post);
  if (!normalized) return null;

  return mutateStore((store) => {
    const bucket = accountBucket(store, accountId);
    const index = bucket.posts.findIndex((p) => p.id === normalized.id);
    if (index >= 0) {
      bucket.posts[index] = mergePostRecord(bucket.posts[index], normalized);
    } else {
      bucket.posts.unshift(normalized);
    }
    bucket.updatedAt = Date.now();
    return bucket.posts.find((p) => p.id === normalized.id) || normalized;
  });
}

export function mergeCachedPosts(accountId, posts) {
  if (!accountId || !Array.isArray(posts) || !posts.length) return getCachedPosts(accountId);
  return mutateStore((store) => {
    const bucket = accountBucket(store, accountId);
    const byId = new Map(bucket.posts.map((p) => [p.id, p]));

    for (const raw of posts) {
      const normalized = normalizePost(raw);
      if (!normalized) continue;
      const existing = byId.get(normalized.id);
      byId.set(normalized.id, mergePostRecord(existing, normalized));
    }

    bucket.posts = [...byId.values()].sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0));
    bucket.updatedAt = Date.now();
    return bucket.posts;
  });
}

/** 与 mergeCachedPosts 相同（已全局文件锁）；保留 Safe 名称兼容调用方 */
export async function mergeCachedPostsSafe(accountId, posts) {
  return mergeCachedPosts(accountId, posts);
}

export function syncCachedPosts(accountId, posts) {
  if (!accountId || !Array.isArray(posts)) return [];
  return mutateStore((store) => {
    const bucket = accountBucket(store, accountId);
    const byId = new Map(bucket.posts.map((p) => [p.id, p]));

    for (const raw of posts) {
      const normalized = normalizePost(raw);
      if (!normalized) continue;
      const existing = byId.get(normalized.id);
      byId.set(normalized.id, mergePostRecord(existing, normalized));
    }

    bucket.posts = [...byId.values()].sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0));
    bucket.updatedAt = Date.now();
    return bucket.posts;
  });
}

/** 从账号缓存中移除指定真实帖子 ID（本地删除后同步） */
export function removeCachedPosts(accountId, postIds = []) {
  if (!accountId || !Array.isArray(postIds) || !postIds.length) return 0;
  const idSet = new Set(postIds.map((id) => String(id)).filter((id) => /^\d+$/.test(id)));
  if (!idSet.size) return 0;
  return mutateStore((store) => {
    const bucket = accountBucket(store, accountId);
    const before = bucket.posts.length;
    bucket.posts = bucket.posts.filter((p) => !idSet.has(String(p?.id || "")));
    bucket.updatedAt = Date.now();
    return before - bucket.posts.length;
  });
}

/** 汇总某账号缓存帖子的文章数 / 浏览 / 互动指标（仅统计真实帖子 ID，排除 assumed_ 占位） */
export function getAccountPostMetrics(accountId) {
  const posts = getCachedPosts(accountId, { limit: 500 }).filter((post) =>
    /^\d+$/.test(String(post?.id || "")),
  );
  let viewCount = 0;
  let likeCount = 0;
  let commentCount = 0;
  let shareCount = 0;
  let postsWithViews = 0;
  for (const post of posts) {
    if (post.viewCount != null && Number.isFinite(Number(post.viewCount))) {
      viewCount += Number(post.viewCount) || 0;
      postsWithViews += 1;
    }
    likeCount += Number(post.likeCount) || 0;
    commentCount += Number(post.commentCount) || 0;
    shareCount += Number(post.shareCount) || 0;
  }
  return {
    articleCount: posts.length,
    viewCount,
    likeCount,
    commentCount,
    shareCount,
    postsWithViews,
    // 广场暂无统一佣金字段，前端显示为 —
    commission: null,
    lastPublishedAt: posts[0]?.publishedAt || null,
  };
}

export function getAccountsPostMetricsMap(accountIds = []) {
  const map = {};
  for (const id of accountIds) {
    if (!id) continue;
    map[id] = getAccountPostMetrics(id);
  }
  return map;
}
