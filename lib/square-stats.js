import { binanceFetch, resolveEffectiveProxy } from "./square-api.js";

const CONTENT_DETAIL_URL = "https://www.binance.com/bapi/composite/v3/friendly/pgc/special/content/detail";
const STATS_RETRY_DELAYS_MS = [0, 800, 1600];

function isTransientNetworkError(message = "") {
  return /超时|ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|socket hang up|fetch failed/i.test(message);
}

function formatNetworkError(err, proxy) {
  const msg = err.message || "fetch failed";
  if (!isTransientNetworkError(msg)) return err;
  const proxyHint = proxy
    ? "（当前代理可能不可用，请检查代理是否已开启、地址和端口是否正确）"
    : "（国内网络需配置代理，如 http://127.0.0.1:7897）";
  return new Error(`无法连接币安${proxyHint}`);
}

async function webFetch(url, options = {}) {
  const proxy = resolveEffectiveProxy(options.proxyUrl);
  const { proxyUrl: _proxyUrl, ...fetchOptions } = options;
  let lastError = null;

  for (const delayMs of STATS_RETRY_DELAYS_MS) {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    try {
      return await binanceFetch(url, { ...fetchOptions, proxyUrl: proxy });
    } catch (err) {
      lastError = err;
      if (!isTransientNetworkError(err.message || "")) break;
    }
  }

  throw formatNetworkError(lastError || new Error("fetch failed"), proxy);
}

export function extractPostId(shareLinkOrId) {
  if (!shareLinkOrId) return null;
  const value = String(shareLinkOrId).trim();
  if (/^\d+$/.test(value)) return value;

  const patterns = [/\/cpos\/(\d+)/i, /\/post\/(\d+)/i, /contentId=(\d+)/i, /[?&]id=(\d+)/i];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function mapComment(reply) {
  return {
    author: reply.displayName || reply.username || "未知用户",
    text: (reply.bodyTextOnly || reply.summary || "").trim(),
    time: reply.createTime || null,
    likeCount: reply.likeCount ?? null,
  };
}

async function fetchPostDetailRaw(postId, proxyUrl) {
  const requestOptions = {
    method: "GET",
    headers: {
      clienttype: "web",
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Referer: "https://www.binance.com/zh-CN/square",
      Origin: "https://www.binance.com",
    },
  };
  if (proxyUrl !== undefined) requestOptions.proxyUrl = proxyUrl;

  const res = await webFetch(`${CONTENT_DETAIL_URL}/${postId}`, requestOptions);

  const raw = await res.text();
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`帖子数据解析失败: HTTP ${res.status}`);
  }

  if (json.code !== "000000") {
    throw new Error(`[${json.code}] ${json.message || "获取帖子数据失败"}`);
  }
  return json.data || {};
}

export async function fetchPostAuthorFromRef(shareLinkOrId, { proxyUrl } = {}) {
  const postId = extractPostId(shareLinkOrId);
  if (!postId) throw new Error("无法从链接中解析帖子 ID");

  const data = await fetchPostDetailRaw(postId, proxyUrl);
  const squareUid = data.squareUid || data.squareAuthorId || data.author?.squareUid || null;
  const username = data.username || data.author?.username || data.authorName || null;
  const displayName = data.displayName || data.author?.displayName || data.authorName || null;

  if (!squareUid && !username) {
    throw new Error("无法从帖子中解析作者信息");
  }

  return {
    postId,
    squareUid: squareUid ? String(squareUid) : null,
    username: username ? String(username) : null,
    displayName: displayName ? String(displayName) : null,
  };
}

export async function fetchPostStats(postId, { proxyUrl } = {}) {
  const data = await fetchPostDetailRaw(postId, proxyUrl);
  const replyList = [...(data.replyPostList || []), ...(data.childReplyPostList || [])];

  return {
    postId,
    viewCount: data.viewCount ?? null,
    likeCount: data.likeCount ?? null,
    commentCount: data.commentCount ?? null,
    shareCount: data.shareCount ?? null,
    recentComments: replyList.slice(0, 10).map(mapComment).filter((c) => c.text),
    fetchedAt: Date.now(),
  };
}

export async function fetchPostStatsByRef(shareLinkOrId, { proxyUrl } = {}) {
  const postId = extractPostId(shareLinkOrId);
  if (!postId) throw new Error("无法从链接中解析帖子 ID");
  return fetchPostStats(postId, { proxyUrl });
}
