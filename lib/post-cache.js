import fs from "fs";
import path from "path";
import { getConfigDir } from "./app-paths.js";

const cacheFile = () => path.join(getConfigDir(), "published-posts-cache.json");

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
  const id = post?.id != null ? String(post.id) : extractPostId(post?.shareLink || post?.webLink);
  if (!id) return null;
  return {
    id,
    text: String(post.text || post.bodyTextOnly || "").trim() || "(无正文)",
    title: String(post.title || "").trim(),
    shareLink:
      post.shareLink ||
      post.webLink ||
      `https://www.binance.com/zh-CN/square/post/${id}`,
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
    .slice()
    .sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0))
    .slice(0, limit);
}

export function cachePublishedPost(accountId, post) {
  if (!accountId) return null;
  const normalized = normalizePost(post);
  if (!normalized) return null;

  const store = readStore();
  const bucket = accountBucket(store, accountId);
  const index = bucket.posts.findIndex((p) => p.id === normalized.id);
  if (index >= 0) {
    bucket.posts[index] = { ...bucket.posts[index], ...normalized, cachedAt: Date.now() };
  } else {
    bucket.posts.unshift(normalized);
  }
  bucket.updatedAt = Date.now();
  writeStore(store);
  return normalized;
}

export function mergeCachedPosts(accountId, posts) {
  if (!accountId || !Array.isArray(posts) || !posts.length) return getCachedPosts(accountId);
  const store = readStore();
  const bucket = accountBucket(store, accountId);
  const byId = new Map(bucket.posts.map((p) => [p.id, p]));

  for (const raw of posts) {
    const normalized = normalizePost(raw);
    if (!normalized) continue;
    const existing = byId.get(normalized.id);
    byId.set(normalized.id, existing ? { ...existing, ...normalized, cachedAt: Date.now() } : normalized);
  }

  bucket.posts = [...byId.values()].sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0));
  bucket.updatedAt = Date.now();
  writeStore(store);
  return bucket.posts;
}

export function syncCachedPosts(accountId, posts) {
  if (!accountId || !Array.isArray(posts)) return [];
  const store = readStore();
  const bucket = accountBucket(store, accountId);
  const byId = new Map(bucket.posts.map((p) => [p.id, p]));

  for (const raw of posts) {
    const normalized = normalizePost(raw);
    if (!normalized) continue;
    const existing = byId.get(normalized.id);
    byId.set(normalized.id, existing ? { ...existing, ...normalized, cachedAt: Date.now() } : normalized);
  }

  bucket.posts = [...byId.values()].sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0));
  bucket.updatedAt = Date.now();
  writeStore(store);
  return bucket.posts;
}
