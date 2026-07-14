import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  maskApiKey,
  saveApiKey,
  publishPost,
  testApiKey,
  testNetwork,
  getProxyUrl,
  saveProxy,
  saveProxyConfig,
  getGlobalProxyConfigPublic,
  getGlobalProxyConfig,
  mergeGlobalProxyCredentials,
  applySystemProxyConfig,
  dismissProxyGuide,
  getBrowserPath,
  saveBrowserPath,
} from "./lib/square-api.js";
import { getUploadsDir, getConfigDir, getDataDirInfo, setCustomDataDir, resetCustomDataDir } from "./lib/app-paths.js";
import {
  listAccountsPublic,
  createAccount,
  updateAccount,
  deleteAccount,
  setDefaultAccount,
  resolveAccountApiKey,
  getAccountCookie,
  hasAnyAccountConfigured,
  getAccountName,
  getDefaultAccountId,
  getAccount,
  resolveAccountProxy,
  resolveProxyUrlFromBody,
  mergeAccountProxyCredentials,
  describeAccountProxyNetworkHint,
} from "./lib/accounts.js";
import { normalizeProxyConfig, isBlankProxyPassword } from "./lib/proxy-config.js";
import { probeProxy } from "./lib/proxy-probe.js";
import { fetchPostStatsByRef } from "./lib/square-stats.js";
import { fetchPostCommentsByRef, closeBrowserClient, testBrowserLaunch } from "./lib/square-browser.js";
import { fetchAccountPublishedPosts, discoverIdentityFromPostRef } from "./lib/square-posts.js";
import {
  getCachedPosts,
  cachePublishedPost,
  mergeCachedPosts,
  syncCachedPosts,
} from "./lib/post-cache.js";
import { getAiSettingsPublic, saveAiSettings, resolveAiCredentials, readAiSettings } from "./lib/ai-settings.js";
import { listAiProvidersPublic } from "./lib/ai-providers.js";
import { generateSquarePost, testAiApiKey } from "./lib/ai-generator.js";
import { getAiSchedulerStatus, runAiHostedCycle, startAiScheduler } from "./lib/ai-scheduler.js";
import { buildCryptoContext, fetchRegistryTokenQuotes, syncBinanceTokenRegistry } from "./lib/crypto-context.js";
import {
  listTokenRegistryPublic,
  upsertTokenRegistryEntry,
  updateTokenRegistryEntry,
  deleteTokenRegistryEntry,
  ensureTokenRegistrySeed,
  saveTokenRegistrySettings,
} from "./lib/token-registry.js";
import { getDeviceBindingPublic, unbindDevice } from "./lib/device-binding.js";
import { appendSystemLog, listSystemLogs, clearSystemLogs } from "./lib/system-log.js";
import { toChineseError } from "./lib/error-zh.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3456;
const uploadsDir = getUploadsDir(__dirname);
const publicDir = path.join(__dirname, "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function serveStatic(res, filePath) {
  if (!filePath.startsWith(publicDir) && !filePath.startsWith(uploadsDir)) {
    json(res, 403, { error: "Forbidden" });
    return;
  }
  if (!fs.existsSync(filePath)) {
    json(res, 404, { error: "Not found" });
    return;
  }
  const ext = path.extname(filePath);
  const headers = { "Content-Type": MIME[ext] || "application/octet-stream" };
  if (ext === ".html" || ext === ".js" || ext === ".css") {
    headers["Cache-Control"] = "no-cache, no-store, must-revalidate";
  }
  res.writeHead(200, headers);
  fs.createReadStream(filePath).pipe(res);
}

function normalizePost(p) {
  return {
    text: p.text || p.bodyTextOnly || p.content || "",
    title: p.title || "",
    imagePaths: p.imagePaths || [],
  };
}

function saveBase64Image(base64, originalName) {
  const match = base64.match(/^data:image\/(\w+);base64,(.+)$/);
  const ext = match ? (match[1] === "jpeg" ? ".jpg" : `.${match[1]}`) : path.extname(originalName) || ".png";
  const data = match ? match[2] : base64;
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
  const filePath = path.join(uploadsDir, filename);
  fs.writeFileSync(filePath, Buffer.from(data, "base64"));
  return { id: filename, path: filePath, url: `/uploads/${filename}` };
}

function validatePosts(posts) {
  const errors = [];
  posts.forEach((post, index) => {
    for (const img of post.imagePaths || []) {
      const file = path.join(uploadsDir, path.basename(img));
      if (!fs.existsSync(file)) {
        errors.push({ index, error: `第 ${index + 1} 条帖子的图片已失效，请重新编辑并上传图片` });
      }
    }
  });
  return errors;
}

async function handleBatchPublish(req, res, posts, intervalSeconds) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    if (typeof res.flush === "function") res.flush();
  };

  const results = [];
  const delay = Math.max(1, Math.min(intervalSeconds, 60)) * 1000;
  send("start", { total: posts.length, intervalSeconds: delay / 1000 });

  for (let i = 0; i < posts.length; i++) {
    const post = posts[i];
    const accountName = getAccountName(post.accountId);
    send("progress", {
      index: i,
      total: posts.length,
      status: "publishing",
      preview: post.text?.slice(0, 50),
      accountName,
    });

    let apiKey;
    try {
      apiKey = resolveAccountApiKey(post.accountId);
    } catch (err) {
      const item = { index: i, ok: false, error: err.message, text: post.text?.slice(0, 80) };
      results.push(item);
      send("result", item);
      continue;
    }

    try {
      const result = await publishPost(apiKey, post, uploadsDir, (info) => {
        send("progress", { index: i, total: posts.length, status: info.stage, message: info.message, accountName });
      }, { proxyUrl: resolveAccountProxy(post.accountId) });
      const accountId = post.accountId || getDefaultAccountId();
      if (accountId && result?.id) {
        cachePublishedPost(accountId, {
          id: result.id,
          text: post.text,
          title: post.title || "",
          shareLink: result.shareLink,
          publishedAt: Date.now(),
          source: "publish",
        });
      }
      const item = { index: i, ok: true, result, text: post.text?.slice(0, 80), accountId: post.accountId || null };
      results.push(item);
      send("result", item);
    } catch (err) {
      const item = { index: i, ok: false, error: err.message, text: post.text?.slice(0, 80) };
      results.push(item);
      send("result", item);
      if (err.message.includes("220009") || err.message.includes("已达上限")) {
        send("error", { message: "已达每日发帖上限，批量发布已停止" });
        break;
      }
    }

    if (i < posts.length - 1) {
      send("waiting", { seconds: delay / 1000, nextIndex: i + 1 });
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  const succeeded = results.filter((r) => r.ok).length;
  send("done", { total: posts.length, succeeded, failed: results.length - succeeded, results });
  res.end();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;
  let requestAccountId = null;

  try {
    // Static: uploads
    if (pathname.startsWith("/uploads/")) {
      serveStatic(res, path.join(uploadsDir, path.basename(pathname)));
      return;
    }

    // Static: public
    if (req.method === "GET" && !pathname.startsWith("/api/")) {
      const file = pathname === "/" ? "index.html" : pathname.slice(1);
      serveStatic(res, path.join(publicDir, file));
      return;
    }

    // API routes
    if (pathname === "/api/config" && req.method === "GET") {
      const accountInfo = listAccountsPublic();
      const defaultAcc = accountInfo.accounts.find((a) => a.isDefault);
      json(res, 200, {
        configured: hasAnyAccountConfigured(),
        maskedKey: defaultAcc?.maskedKey || null,
        dataDir: getConfigDir(),
        dataDirInfo: getDataDirInfo(),
        proxy: getProxyUrl() || null,
        proxyConfig: getGlobalProxyConfigPublic(),
        hasBinanceCookie: defaultAcc?.hasCookie || false,
        defaultAccountId: accountInfo.defaultAccountId,
        accountCount: accountInfo.accounts.length,
        creatorCenterUrl: "https://www.binance.com/square/creator-center/home",
        dailyLimit: 100,
        browserPath: getBrowserPath() || null,
      });
      return;
    }

    if (pathname === "/api/accounts" && req.method === "GET") {
      json(res, 200, listAccountsPublic());
      return;
    }

    if (pathname === "/api/accounts" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const account = createAccount(body);
      json(res, 200, {
        ok: true,
        account: {
          id: account.id,
          name: account.name,
          maskedKey: maskApiKey(account.apiKey),
          hasApiKey: Boolean(account.apiKey),
          hasCookie: Boolean(account.cookie),
        },
      });
      return;
    }

    const accountPostsRoute = pathname.match(/^\/api\/accounts\/([^/]+)\/posts$/);
    if (accountPostsRoute && req.method === "GET") {
      const accountId = decodeURIComponent(accountPostsRoute[1]);
      const account = getAccount(accountId);
      if (!account) {
        json(res, 404, { error: "账号不存在" });
        return;
      }
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "20", 10) || 20, 50);
      const probePostRef = url.searchParams.get("postRef") || "";
      const cached = getCachedPosts(accountId, { limit: 50 });

      try {
        const result = await fetchAccountPublishedPosts({
          apiKey: account.apiKey,
          cookie: account.cookie,
          username: account.username,
          squareUid: account.squareUid,
          anchorPostId: account.anchorPostId,
          probePostRef: probePostRef || account.anchorPostId,
          limit,
          proxyUrl: resolveAccountProxy(accountId),
        });
        const patch = {};
        if (result.squareUid && result.squareUid !== account.squareUid) patch.squareUid = result.squareUid;
        if (result.username && result.username !== account.username) patch.username = result.username;
        if (result.discoveredIdentity?.anchorPostId && result.discoveredIdentity.anchorPostId !== account.anchorPostId) {
          patch.anchorPostId = result.discoveredIdentity.anchorPostId;
        }
        if (Object.keys(patch).length) updateAccount(accountId, patch);

        let posts = result.posts || [];
        if (posts.length) {
          posts = mergeCachedPosts(accountId, posts).slice(0, limit);
        } else if (cached.length) {
          posts = cached.slice(0, limit);
          result.source = "cache";
          result.hint = "远程暂无更多帖子，已显示本地缓存";
        }

        json(res, 200, {
          ok: true,
          accountId,
          accountName: account.name,
          ...result,
          posts,
          cacheCount: getCachedPosts(accountId, { limit: 50 }).length,
        });
      } catch (err) {
        if (cached.length) {
          json(res, 200, {
            ok: true,
            accountId,
            accountName: account.name,
            posts: cached.slice(0, limit),
            source: "cache",
            fromCache: true,
            cacheCount: cached.length,
            fetchedAt: Date.now(),
            hint: `远程拉取失败，已显示本地缓存（${cached.length} 条）`,
            remoteError: err.message,
          });
        } else {
          json(res, 400, { error: err.message, code: err.code || null });
        }
      }
      return;
    }

    const accountPostsCacheRoute = pathname.match(/^\/api\/accounts\/([^/]+)\/posts\/cache$/);
    if (accountPostsCacheRoute && req.method === "POST") {
      const accountId = decodeURIComponent(accountPostsCacheRoute[1]);
      if (!getAccount(accountId)) {
        json(res, 404, { error: "账号不存在" });
        return;
      }
      const body = JSON.parse(await readBody(req));
      const posts = syncCachedPosts(accountId, body.posts || []);
      json(res, 200, { ok: true, accountId, count: posts.length });
      return;
    }

    const accountDiscoverRoute = pathname.match(/^\/api\/accounts\/([^/]+)\/discover-from-post$/);
    if (accountDiscoverRoute && req.method === "POST") {
      const accountId = decodeURIComponent(accountDiscoverRoute[1]);
      const account = getAccount(accountId);
      if (!account) {
        json(res, 404, { error: "账号不存在" });
        return;
      }
      const body = JSON.parse(await readBody(req));
      const postRef = body.postRef || body.postId || body.shareLink;
      if (!postRef) {
        json(res, 400, { error: "请提供 postRef、postId 或 shareLink" });
        return;
      }
      try {
        const identity = await discoverIdentityFromPostRef(postRef, {
          proxyUrl: resolveAccountProxy(accountId),
        });
        updateAccount(accountId, {
          username: identity.username || account.username,
          squareUid: identity.squareUid || account.squareUid,
          anchorPostId: identity.anchorPostId,
        });
        json(res, 200, { ok: true, accountId, ...identity });
      } catch (err) {
        json(res, 400, { error: err.message });
      }
      return;
    }

    const accountRoute = pathname.match(/^\/api\/accounts\/([^/]+)(\/default)?$/);
    if (accountRoute) {
      const accountId = decodeURIComponent(accountRoute[1]);
      const isSetDefault = accountRoute[2] === "/default";

      if (isSetDefault && req.method === "POST") {
        setDefaultAccount(accountId);
        json(res, 200, { ok: true, defaultAccountId: accountId });
        return;
      }

      if (req.method === "PUT") {
        const body = JSON.parse(await readBody(req));
        // 编辑账号：空 API Key / 未传 Cookie 都不覆盖已有值
        if (body && (body.apiKey == null || String(body.apiKey).trim() === "")) {
          delete body.apiKey;
        }
        if (body && Object.prototype.hasOwnProperty.call(body, "cookie") && body.cookie == null) {
          delete body.cookie;
        }
        const account = updateAccount(accountId, body);
        await closeBrowserClient();
        json(res, 200, {
          ok: true,
          account: {
            id: account.id,
            name: account.name,
            maskedKey: maskApiKey(account.apiKey),
            hasApiKey: Boolean(account.apiKey),
            hasCookie: Boolean(account.cookie),
          },
        });
        return;
      }

      if (req.method === "DELETE") {
        const result = deleteAccount(accountId);
        await closeBrowserClient();
        json(res, 200, { ok: true, ...result });
        return;
      }
    }

    if (pathname === "/api/config/proxy" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const saved = body.proxyConfig
        ? saveProxyConfig(body.proxyConfig)
        : saveProxy(body.proxy || "");
      json(res, 200, { ok: true, proxy: saved.proxyUrl, proxyConfig: saved });
      return;
    }

    if (pathname === "/api/config/proxy/apply-system" && req.method === "POST") {
      const saved = applySystemProxyConfig();
      json(res, 200, { ok: true, message: "已应用 Windows 系统代理", proxyConfig: saved });
      return;
    }

    if (pathname === "/api/config/proxy/dismiss-guide" && req.method === "POST") {
      dismissProxyGuide();
      json(res, 200, { ok: true, needsProxySetup: false });
      return;
    }

    if (pathname === "/api/config/browser" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const browserPath = String(body.browserPath || "").trim();
      if (browserPath && !fs.existsSync(browserPath)) {
        json(res, 400, { error: `浏览器路径不存在：${browserPath}` });
        return;
      }
      saveBrowserPath(browserPath);
      await closeBrowserClient();
      json(res, 200, { ok: true, browserPath: browserPath || null });
      return;
    }

    if (pathname === "/api/config/browser/test" && req.method === "POST") {
      const body = req.headers["content-length"] ? JSON.parse(await readBody(req)) : {};
      try {
        const result = await testBrowserLaunch(body.browserPath || getBrowserPath());
        json(res, 200, result);
      } catch (err) {
        json(res, 400, { error: err.message });
      }
      return;
    }

    if (pathname === "/api/config/cookie" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const cookie = body.cookie || "";
      const defaultId = getDefaultAccountId();
      if (!defaultId) {
        json(res, 400, { error: "请先添加账号" });
        return;
      }
      updateAccount(defaultId, { cookie });
      await closeBrowserClient();
      json(res, 200, { ok: true, hasBinanceCookie: Boolean(cookie) });
      return;
    }

    if (pathname === "/api/config/network-test" && req.method === "POST") {
      const body = req.headers["content-length"] ? JSON.parse(await readBody(req)) : {};
      // 自定义代理：分层检测 + HTTP/Socks5 自动纠错；全局/直连仍走原逻辑
      let proxyConfig = normalizeProxyConfig(body?.proxyConfig, body?.proxy);
      if (body?.accountId) {
        proxyConfig = mergeAccountProxyCredentials(body.accountId, proxyConfig);
      } else {
        proxyConfig = mergeGlobalProxyCredentials(proxyConfig);
      }
      if (["http", "https", "socks5", "ssh"].includes(proxyConfig.type)) {
        // 留空密码仅在有账号/已保存密码/填写了用户名时才报错；无鉴权本地代理可直接测
        if (body?.useSavedProxyPassword && !String(proxyConfig.password || "").trim()) {
          const stored = body?.accountId
            ? normalizeProxyConfig(getAccount(body.accountId)?.proxyConfig)
            : getGlobalProxyConfig();
          const storedHasPassword = !isBlankProxyPassword(stored.password);
          const username = String(proxyConfig.username || stored.username || "").trim();
          if (storedHasPassword || username) {
            const scope = body?.accountId ? "该账号" : "全局";
            json(res, 400, {
              ok: false,
              stage: "proxy",
              message: `未找到${scope}已保存的代理密码。请在「代理密码」中重新输入后再检测，并点保存。`,
            });
            return;
          }
        }
        const result = await probeProxy(proxyConfig);
        json(res, result.ok ? 200 : 400, result);
        return;
      }
      const proxyUrl = resolveProxyUrlFromBody(body);
      await testNetwork({ proxyUrl });
      json(res, 200, { ok: true, message: "网络连接正常，可以访问币安 API" });
      return;
    }

    if (pathname === "/api/config/data-dir" && req.method === "GET") {
      json(res, 200, getDataDirInfo());
      return;
    }

    if (pathname === "/api/config/data-dir" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      try {
        const result = setCustomDataDir(body.path || body.dataDir, { migrate: body.migrate !== false });
        json(res, 200, {
          ...result,
          message: result.migration.migrated
            ? `数据目录已更新，已迁移 ${result.migration.files} 项。请重启应用后生效。`
            : "数据目录已更新。请重启应用后生效。",
        });
      } catch (err) {
        json(res, 400, { error: err.message || "设置数据目录失败" });
      }
      return;
    }

    if (pathname === "/api/config/data-dir/reset" && req.method === "POST") {
      const body = req.headers["content-length"] ? JSON.parse(await readBody(req)) : {};
      try {
        const result = resetCustomDataDir({ migrate: body.migrate !== false });
        json(res, 200, {
          ...result,
          message: result.migration.migrated
            ? `已恢复默认目录，并迁移 ${result.migration.files} 项。请重启应用后生效。`
            : "已恢复默认目录。请重启应用后生效。",
        });
      } catch (err) {
        json(res, 400, { error: err.message || "恢复默认目录失败" });
      }
      return;
    }

    if (pathname === "/api/config" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const key = String(body.apiKey || "").trim();
      if (!key) {
        json(res, 400, { error: "API Key 不能为空" });
        return;
      }
      const accountInfo = listAccountsPublic();
      if (accountInfo.accounts.length === 0) {
        createAccount({ name: "默认账号", apiKey: key });
      } else {
        updateAccount(accountInfo.defaultAccountId, { apiKey: key });
      }
      saveApiKey(key);
      json(res, 200, { ok: true, maskedKey: maskApiKey(key) });
      return;
    }

    if (pathname === "/api/config/test" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const typedKey = String(body?.apiKey || "").trim();
      // 与代理密码同理：留空 / 要求使用已保存 Key 时，强制走 accountId，避免空串或脏输入覆盖
      const useSavedApiKey = Boolean(body?.useSavedApiKey) || !typedKey;
      let key;
      if (!useSavedApiKey && typedKey) {
        key = typedKey;
      } else if (body?.accountId) {
        key = resolveAccountApiKey(body.accountId);
      } else {
        key = resolveAccountApiKey();
      }
      // 会合并账号里已保存的代理密码（UI 留空时）
      const proxyUrl = resolveProxyUrlFromBody(body);
      await testApiKey(key, { proxyUrl });
      json(res, 200, {
        ok: true,
        message: useSavedApiKey
          ? "API Key 验证成功（已使用已保存的 Key，并连通币安）"
          : "API Key 验证成功（已连通币安）",
      });
      return;
    }

    if (pathname === "/api/upload" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const files = (body.files || []).map((f) => saveBase64Image(f.data, f.name));
      json(res, 200, { files });
      return;
    }

    if (pathname === "/api/publish/single" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const apiKey = resolveAccountApiKey(body.accountId);
      const result = await publishPost(apiKey, body, uploadsDir, undefined, {
        proxyUrl: resolveAccountProxy(body.accountId),
      });
      json(res, 200, { ok: true, result });
      return;
    }

    if (pathname === "/api/post/stats" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      requestAccountId = body.accountId || null;
      const ref = body.postId || body.shareLink;
      if (!ref) {
        json(res, 400, { error: "请提供 postId 或 shareLink" });
        return;
      }
      const stats = await fetchPostStatsByRef(ref, {
        proxyUrl: resolveAccountProxy(body.accountId),
      });
      json(res, 200, { ok: true, stats });
      return;
    }

    if (pathname === "/api/post/comments" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      requestAccountId = body.accountId || null;
      const ref = body.postId || body.shareLink;
      if (!ref) {
        json(res, 400, { error: "请提供 postId 或 shareLink" });
        return;
      }
      const cookie = getAccountCookie(body.accountId);
      const result = await fetchPostCommentsByRef(ref, {
        cookie,
        proxyUrl: resolveAccountProxy(body.accountId),
      });
      json(res, 200, { ok: true, ...result });
      return;
    }

    if (pathname === "/api/post/stats/batch" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      requestAccountId = body.accountId || null;
      const refs = body.refs || [];
      if (!Array.isArray(refs) || refs.length === 0) {
        json(res, 400, { error: "refs 不能为空" });
        return;
      }
      const results = [];
      for (const ref of refs) {
        try {
          const stats = await fetchPostStatsByRef(ref, {
            proxyUrl: resolveAccountProxy(body.accountId),
          });
          results.push({ ok: true, ref, stats });
        } catch (err) {
          results.push({ ok: false, ref, error: err.message });
        }
        if (refs.length > 1) await new Promise((r) => setTimeout(r, 500));
      }
      json(res, 200, { ok: true, results });
      return;
    }

    if (pathname === "/api/validate-posts" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const errors = validatePosts(body.posts || []);
      json(res, 200, { ok: errors.length === 0, errors });
      return;
    }

    if (pathname === "/api/publish/batch" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const posts = body.posts || [];
      if (!Array.isArray(posts) || posts.length === 0) {
        json(res, 400, { error: "帖子列表不能为空" });
        return;
      }
      if (posts.length > 100) {
        json(res, 400, { error: "单次批量最多 100 条（日限额 100 条）" });
        return;
      }
      const preErrors = validatePosts(posts);
      if (preErrors.length > 0) {
        json(res, 400, { error: preErrors[0].error, errors: preErrors });
        return;
      }
      await handleBatchPublish(req, res, posts, body.intervalSeconds || 3);
      return;
    }

    if (pathname === "/api/ai/config" && req.method === "GET") {
      json(res, 200, getAiSettingsPublic());
      return;
    }

    if (pathname === "/api/ai/providers" && req.method === "GET") {
      json(res, 200, { providers: listAiProvidersPublic() });
      return;
    }

    if (pathname === "/api/ai/config" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const saved = saveAiSettings(body);
      json(res, 200, { ok: true, ...saved });
      return;
    }

    if (pathname === "/api/ai/status" && req.method === "GET") {
      json(res, 200, getAiSchedulerStatus());
      return;
    }

    if (pathname === "/api/system-log" && req.method === "GET") {
      const sinceId = Number(url.searchParams.get("sinceId") || 0);
      const limit = Number(url.searchParams.get("limit") || 100);
      json(res, 200, { logs: listSystemLogs({ sinceId, limit }) });
      return;
    }

    if (pathname === "/api/system-log" && req.method === "DELETE") {
      clearSystemLogs();
      json(res, 200, { ok: true });
      return;
    }

    if (pathname === "/api/ai/test" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const creds = resolveAiCredentials({
        profileId: body.aiProfileId,
        overrides: {
          apiKey: body.apiKey,
          provider: body.provider,
          baseUrl: body.baseUrl,
          model: body.model,
        },
      });
      const result = await testAiApiKey(creds.apiKey, {
        provider: creds.provider,
        model: creds.model,
        baseUrl: creds.baseUrl,
      });
      json(res, 200, result);
      return;
    }

    if (pathname === "/api/ai/preview-style" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const sampleText = String(body?.sampleText || "").trim();
      if (sampleText.length < 20) {
        json(res, 400, { error: "参考文章至少 20 字" });
        return;
      }
      const creds = resolveAiCredentials({
        profileId: body.aiProfileId,
        overrides: {
          apiKey: body.apiKey,
          provider: body.provider,
          baseUrl: body.baseUrl,
          model: body.model,
        },
      });
      const previewRefId = `preview_${Date.now()}`;
      const styleReferences = [
        ...(readAiSettings().styleReferences || []),
        { id: previewRefId, name: "预览", sampleText, createdAt: Date.now() },
      ];
      const styleId = `ref:${previewRefId}`;
      const draft = await generateSquarePost({
        apiKey: creds.apiKey,
        provider: creds.provider,
        baseUrl: creds.baseUrl,
        model: creds.model,
        contentStyle: styleId,
        contentStyles: [styleId],
        styleReferencesOverride: styleReferences,
        selectedTokens: body.selectedTokens,
        marketSentiment: body.marketSentiment,
        useNews: body.useNews !== false,
      });
      json(res, 200, {
        ok: true,
        text: draft.text,
        topic: draft.topic,
        contentStyleLabel: draft.contentStyleLabel,
      });
      return;
    }

    if (pathname === "/api/ai/generate" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const creds = resolveAiCredentials({
        profileId: body.aiProfileId,
        overrides: {
          apiKey: body.apiKey,
          provider: body.provider,
          baseUrl: body.baseUrl,
          model: body.model,
        },
      });
      const count = Math.max(1, Math.min(parseInt(body.count, 10) || 1, 5));
      const generated = [];
      const recentTexts = [];
      const recentContentStyles = [];
      for (let i = 0; i < count; i++) {
        const draft = await generateSquarePost({
          apiKey: creds.apiKey,
          provider: creds.provider,
          baseUrl: creds.baseUrl,
          model: creds.model,
          topic: body.topic,
          recentTexts,
          contentStyles: body.contentStyles,
          contentStyle: body.contentStyle,
          recentContentStyles,
          selectedTokens: body.selectedTokens,
          marketSentiment: body.marketSentiment,
          tokenIndex: i,
        });
        generated.push(draft);
        recentTexts.push(draft.text);
        if (draft.contentStyle) recentContentStyles.push(draft.contentStyle);
      }
      json(res, 200, { ok: true, posts: generated });
      return;
    }

    if (pathname === "/api/ai/context" && req.method === "GET") {
      const context = await buildCryptoContext();
      json(res, 200, { ok: true, context });
      return;
    }

    if (pathname === "/api/token-registry" && req.method === "GET") {
      ensureTokenRegistrySeed();
      json(res, 200, listTokenRegistryPublic());
      return;
    }

    if (pathname === "/api/token-registry/settings" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const settings = saveTokenRegistrySettings(body || {});
      json(res, 200, { ok: true, settings });
      return;
    }

    if (pathname === "/api/token-registry/sync" && req.method === "POST") {
      const result = await syncBinanceTokenRegistry();
      // 不回传完整代币列表，避免超大 JSON 卡住界面
      json(res, 200, {
        ok: true,
        ...result,
        settings: listTokenRegistryPublic().settings,
      });
      return;
    }

    if (pathname === "/api/token-registry/quotes" && req.method === "GET") {
      const symbolsParam = String(url.searchParams.get("symbols") || "").trim();
      const symbols = symbolsParam
        ? symbolsParam.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)
        : [];
      const result = await fetchRegistryTokenQuotes(symbols);
      json(res, 200, { ok: true, ...result });
      return;
    }

    if (pathname === "/api/token-registry" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const saved = upsertTokenRegistryEntry(body || {});
      json(res, 200, { ok: true, token: saved });
      return;
    }

    if (pathname.startsWith("/api/token-registry/") && req.method === "PUT") {
      const id = decodeURIComponent(pathname.slice("/api/token-registry/".length));
      if (!id || id.includes("/")) {
        json(res, 400, { error: "无效的代币 ID" });
        return;
      }
      const body = JSON.parse(await readBody(req));
      const saved = updateTokenRegistryEntry(id, body || {});
      json(res, 200, { ok: true, token: saved });
      return;
    }

    if (pathname.startsWith("/api/token-registry/") && req.method === "DELETE") {
      const id = decodeURIComponent(pathname.slice("/api/token-registry/".length));
      if (!id || id.includes("/")) {
        json(res, 400, { error: "无效的代币 ID" });
        return;
      }
      const removed = deleteTokenRegistryEntry(id);
      json(res, 200, { ok: true, token: removed });
      return;
    }

    if (pathname === "/api/ai/run" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const result = await runAiHostedCycle({
        uploadsDir,
        force: true,
        manual: Boolean(body.manual),
        publish: body.publish,
        count: body.count,
        overrides: {
          selectedTokens: body.selectedTokens,
          customTokens: body.customTokens,
          marketSentiment: body.marketSentiment,
          contentStyles: body.contentStyles,
          provider: body.provider,
          baseUrl: body.baseUrl,
          model: body.model,
          topic: body.topic,
          accountId: body.accountId,
          allAccounts: Boolean(body.allAccounts),
        },
      });
      json(res, 200, result);
      return;
    }

    if (pathname === "/api/device" && req.method === "GET") {
      json(res, 200, { ok: true, ...getDeviceBindingPublic() });
      return;
    }

    if (pathname === "/api/device/unbind" && req.method === "POST") {
      const result = unbindDevice();
      json(res, 200, result);
      return;
    }

    if (pathname === "/api/parse-import" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const { text, format = "json" } = body;
      if (format === "json") {
        const parsed = JSON.parse(text);
        const posts = Array.isArray(parsed) ? parsed : parsed.posts || [];
        json(res, 200, { posts: posts.map(normalizePost) });
      } else {
        const lines = text.split("\n").filter((l) => l.trim());
        const posts = lines.map((line) => {
          const parts = line.split("|").map((s) => s.trim());
          return normalizePost({ text: parts[0], title: parts[1] || "" });
        });
        json(res, 200, { posts });
      }
      return;
    }

    json(res, 404, { error: "Not found" });
  } catch (err) {
    if (!res.headersSent) {
      const zh = toChineseError(err);
      const hint = describeAccountProxyNetworkHint(requestAccountId, zh);
      json(res, zh.includes("未配置") ? 400 : 500, { error: zh + hint });
    }
  }
});

server.listen(PORT, () => {
  console.log(`\n  币安广场批量发帖工具已启动`);
  console.log(`  打开浏览器访问: http://localhost:${PORT}\n`);
  appendSystemLog("本地服务已启动", { type: "ok", source: "system" });
  startAiScheduler(uploadsDir);
});

async function shutdown() {
  await closeBrowserClient();
  server.close();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    shutdown()
      .catch(() => {})
      .finally(() => process.exit(0));
  });
}
