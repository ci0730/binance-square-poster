import { fetchPostAuthorFromRef } from "./square-stats.js";
import {
  resolveCreatorFromOpenApiKey,
  fetchPublishedPostsFromOpenApi,
} from "./square-api.js";
import { runWithBrowser } from "./square-browser.js";

const USER_CLIENT_PATH = "/bapi/composite/v3/friendly/pgc/user/client";
const USER_POSTS_PATH = "/bapi/composite/v2/friendly/pgc/content/queryUserProfilePageContentsWithFilter";
const CREATOR_CENTER = "/zh-CN/square/creator-center/home";

function findSquareUid(value, depth = 0) {
  if (!value || depth > 8) return null;
  if (typeof value === "object" && !Array.isArray(value)) {
    if (typeof value.squareUid === "string" && value.squareUid.length > 8) return value.squareUid;
    if (typeof value.squareAuthorId === "string" && value.squareAuthorId.length > 8) return value.squareAuthorId;
    for (const v of Object.values(value)) {
      const found = findSquareUid(v, depth + 1);
      if (found) return found;
    }
  } else if (Array.isArray(value)) {
    for (const item of value) {
      const found = findSquareUid(item, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function mapPost(item) {
  const id = item?.id != null ? String(item.id) : null;
  const text = (item?.bodyTextOnly || item?.summary || item?.body || "").trim();
  const title = (item?.title || item?.subTitle || "").trim();
  const shareLink =
    item?.webLink ||
    item?.shareLink ||
    (id ? `https://www.binance.com/zh-CN/square/post/${id}` : null);
  let publishedAt = null;
  if (item?.createTime) publishedAt = Number(item.createTime);
  else if (item?.firstReleaseTime) publishedAt = Number(item.firstReleaseTime);
  else if (item?.date) publishedAt = Number(item.date) * 1000;

  return {
    id,
    text: text || title || "(无正文)",
    title: title || "",
    shareLink,
    contentType: item?.contentType ?? item?.cardType ?? null,
    viewCount: item?.viewCount ?? null,
    likeCount: item?.likeCount ?? null,
    commentCount: item?.commentCount ?? null,
    shareCount: item?.shareCount ?? null,
    publishedAt,
  };
}

async function resolveIdentityFromCookie(client) {
  const captured = [];
  const onResponse = async (resp) => {
    if (!/\/bapi\/composite\//i.test(resp.url())) return;
    try {
      const ct = resp.headers()["content-type"] || "";
      if (!ct.includes("application/json")) return;
      captured.push(await resp.json());
    } catch {
      // ignore
    }
  };

  client.page.on("response", onResponse);
  try {
    await client.page.goto(`https://www.binance.com${CREATOR_CENTER}`, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
    await client.page.waitForTimeout(5000);

    for (const payload of captured) {
      const uid = findSquareUid(payload);
      if (uid) {
        const data = payload?.data || payload;
        return {
          squareUid: uid,
          username: data?.username || null,
          displayName: data?.displayName || data?.nickname || null,
        };
      }
    }

    const profile = await client.replayPost(USER_CLIENT_PATH, {
      getFollowCount: false,
      queryFollowersInfo: false,
      queryRelationTokens: false,
    });
    const uid = profile.data?.squareUid;
    if (uid) {
      return {
        squareUid: uid,
        username: profile.data?.username || null,
        displayName: profile.data?.displayName || null,
      };
    }

    throw new Error("Cookie 无法识别当前登录账号，请确认 Cookie 有效且未过期");
  } finally {
    client.page.off("response", onResponse);
  }
}

async function fetchPostsViaBrowser({ cookie, username, squareUid, limit, proxyUrl = "" }) {
  return runWithBrowser(cookie, async (client) => {
    let identity = { squareUid: squareUid || null, username: username || null, displayName: null };

    if (!identity.squareUid && identity.username) {
      const profile = await client.replayPost(USER_CLIENT_PATH, {
        username: identity.username,
        getFollowCount: false,
        queryFollowersInfo: false,
        queryRelationTokens: false,
      });
      identity = {
        squareUid: profile.data?.squareUid || null,
        username: profile.data?.username || identity.username,
        displayName: profile.data?.displayName || null,
      };
      if (!identity.squareUid) {
        throw new Error(`未找到用户「${username}」的 Square 资料，请检查用户名是否正确`);
      }
    }

    if (!identity.squareUid && cookie) {
      identity = await resolveIdentityFromCookie(client);
    }

    if (!identity.squareUid) {
      throw new Error("无法识别 Square 账号，请配置与 API Key 同一币安账号的 Cookie，或填写广场用户名");
    }

    const resp = await client.replayGet(USER_POSTS_PATH, {
      targetSquareUid: identity.squareUid,
      timeOffset: Date.now(),
      filterType: "ALL",
    });

    const contents = resp.data?.contents || [];
    const posts = contents.slice(0, limit).map(mapPost).filter((p) => p.id);
    return { ...identity, posts, hasMore: Boolean(resp.data?.isExistSecondPage) };
  }, { proxyUrl });
}

export async function discoverIdentityFromPostRef(postRef, { proxyUrl = "" } = {}) {
  const author = await fetchPostAuthorFromRef(postRef, { proxyUrl });
  return {
    squareUid: author.squareUid,
    username: author.username,
    displayName: author.displayName,
    anchorPostId: author.postId,
  };
}

async function fetchViaOpenApi(apiKey, cookie, limit, proxyUrl = "") {
  if (!cookie) {
    throw new Error("OpenAPI 拉取帖子需要配置 Cookie");
  }

  let identity = { squareUid: null, username: null, displayName: null };
  try {
    identity = await resolveCreatorFromOpenApiKey(apiKey, cookie, proxyUrl);
  } catch {
    // 部分账号可能无法读取身份信息，但 content/list 仍可用
  }

  const items = await fetchPublishedPostsFromOpenApi(apiKey, { cookie, limit, proxyUrl });
  const posts = items.slice(0, limit).map(mapPost).filter((p) => p.id);
  return {
    ...identity,
    posts,
    hasMore: items.length >= limit,
    source: "openApi",
  };
}

export async function fetchAccountPublishedPosts({
  apiKey = "",
  cookie = "",
  username = "",
  squareUid = "",
  anchorPostId = "",
  probePostRef = "",
  limit = 20,
  proxyUrl = "",
} = {}) {
  const maxItems = Math.max(1, Math.min(limit, 50));
  if (!apiKey) throw new Error("账号未配置 API Key");

  let resolvedUsername = username;
  let resolvedSquareUid = squareUid;
  let resolvedDisplayName = null;
  let discoveredAnchorPostId = null;
  let discoveredFromPost = false;

  const postRef = probePostRef || anchorPostId;
  if (!resolvedUsername && !resolvedSquareUid && postRef) {
    const identity = await discoverIdentityFromPostRef(postRef, { proxyUrl });
    resolvedUsername = identity.username || resolvedUsername;
    resolvedSquareUid = identity.squareUid || resolvedSquareUid;
    resolvedDisplayName = identity.displayName || null;
    discoveredAnchorPostId = identity.anchorPostId;
    discoveredFromPost = true;
  }

  let openApiError = null;
  if (cookie) {
    try {
      const result = await fetchViaOpenApi(apiKey, cookie, maxItems, proxyUrl);
      if (result.posts.length) {
        return {
          ...result,
          displayName: result.displayName || resolvedDisplayName,
          discoveredFromPost,
          discoveredIdentity: discoveredFromPost
            ? { username: resolvedUsername, squareUid: resolvedSquareUid, anchorPostId: discoveredAnchorPostId }
            : null,
          fetchedAt: Date.now(),
          hint: null,
        };
      }
      if (result.username || result.squareUid) {
        openApiError = new Error("该账号暂无已发布的广场帖子");
      }
    } catch (err) {
      openApiError = err;
    }
  }

  if (cookie || resolvedUsername || resolvedSquareUid) {
    const result = await fetchPostsViaBrowser({
      cookie,
      username: resolvedUsername,
      squareUid: resolvedSquareUid,
      limit: maxItems,
      proxyUrl,
    });
    return {
      ...result,
      displayName: result.displayName || resolvedDisplayName,
      source: "browser",
      discoveredFromPost,
      discoveredIdentity: discoveredFromPost
        ? { username: resolvedUsername, squareUid: resolvedSquareUid, anchorPostId: discoveredAnchorPostId }
        : null,
      fetchedAt: Date.now(),
      hint: result.posts.length ? null : "该账号暂无已发布的广场帖子",
    };
  }

  const needPublishError = new Error(
    "该功能需要发布成功一条帖子才能拉取，否则系统获取不到历史发布的帖子",
  );
  needPublishError.code = "NEED_PUBLISH_FIRST";
  throw openApiError || needPublishError;
}
