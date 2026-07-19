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
import { getCacheOverview, clearCacheItems } from "./lib/cache-manager.js";
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
import { probeProxy, measureProxyLatency } from "./lib/proxy-probe.js";
import { fetchPostStatsByRef } from "./lib/square-stats.js";
import { fetchPostCommentsByRef, closeBrowserClient, testBrowserLaunch } from "./lib/square-browser.js";
import { fetchAccountPublishedPosts, discoverIdentityFromPostRef } from "./lib/square-posts.js";
import {
  getCachedPosts,
  cachePublishedPost,
  mergeCachedPosts,
  syncCachedPosts,
  getAccountPostMetrics,
} from "./lib/post-cache.js";
import {
  getAiSettingsPublic,
  saveAiSettings,
  resolveAiCredentials,
  readAiSettings,
  getRecentTokenPairs,
  markRunStarted,
  recordAiConnectionTest,
} from "./lib/ai-settings.js";
import { listAiProvidersPublic } from "./lib/ai-providers.js";
import { generateSquarePost, testAiApiKey } from "./lib/ai-generator.js";
import { getAiSchedulerStatus, runAiHostedCycle, startAiScheduler, requestAiHostCancel, isAiHostRunActive } from "./lib/ai-scheduler.js";
import { getAiRunProgress } from "./lib/ai-run-progress.js";
import {
  buildCryptoContext,
  fetchRegistryTokenQuotes,
  syncBinanceTokenRegistry,
  fetchHotNegativeFundingTokens,
  pickRandomAllBinanceTokenPair,
  TOKEN_MODE_RANDOM_ALL,
  normalizeTokenMode,
} from "./lib/crypto-context.js";
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
    if (res.destroyed || res.writableEnded) return;
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      if (typeof res.flush === "function") res.flush();
    } catch {
      // 客户端关闭页面后，后台仍完成当前批次并写入本地发布缓存。
    }
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
      const item = {
        index: i,
        ok: false,
        uncertain: err?.code === "PUBLISH_CONFIRMATION_UNKNOWN",
        error: err.message,
        text: post.text?.slice(0, 80),
      };
      results.push(item);
      send("result", item);
      continue;
    }

    try {
      const result = await publishPost(apiKey, post, uploadsDir, (info) => {
        send("progress", { index: i, total: posts.length, status: info.stage, message: info.message, accountName });
      }, {
        proxyUrl: resolveAccountProxy(post.accountId),
        cookie: getAccountCookie(post.accountId),
      });
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
      const item = {
        index: i,
        ok: true,
        result,
        text: post.text?.slice(0, 80),
        accountId: post.accountId || null,
        confirmedByFetch: result?.publishStatus === "confirmed_by_fetch",
      };
      results.push(item);
      send("result", item);
    } catch (err) {
      const item = {
        index: i,
        ok: false,
        uncertain: err?.code === "PUBLISH_CONFIRMATION_UNKNOWN",
        error: err.message,
        text: post.text?.slice(0, 80),
        accountId: post.accountId || null,
      };
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
  const uncertain = results.filter((r) => r.uncertain).length;
  const failed = results.filter((r) => !r.ok && !r.uncertain).length;
  send("done", { total: posts.length, succeeded, failed, uncertain, results });
  if (!res.destroyed && !res.writableEnded) res.end();
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
        // 供桌面端识别：是否为本软件拉起的服务（避免误连外部占用 3456 的旧 node）
        desktopOwned: process.env.BINANCE_SQUARE_DESKTOP === "1",
        serverBootAt: Number(process.env.BINANCE_SQUARE_SERVER_BOOT_AT || 0) || null,
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

    if (pathname === "/api/config/proxy-latency" && req.method === "GET") {
      const proxyUrl = getProxyUrl();
      const publicCfg = getGlobalProxyConfigPublic();
      let result;
      try {
        result = await Promise.race([
          measureProxyLatency(proxyUrl, { timeoutMs: 5000 }),
          new Promise((_, reject) => {
            setTimeout(() => reject(new Error("测速超时")), 9000);
          }),
        ]);
      } catch (err) {
        result = {
          ok: false,
          latencyMs: null,
          error: err?.message || "测速失败",
          source: "none",
          nodeName: null,
          kindLabel: "测速失败",
        };
      }
      json(res, 200, {
        ok: Boolean(result.ok),
        latencyMs: result.latencyMs,
        error: result.error || null,
        hasProxy: Boolean(proxyUrl),
        proxyLabel: publicCfg?.proxyLabel || publicCfg?.label || (proxyUrl ? "全局代理" : "直连"),
        source: result.source || null,
        nodeName: result.nodeName || null,
        kindLabel: result.kindLabel || null,
      });
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

    if (pathname === "/api/cache" && req.method === "GET") {
      json(res, 200, getCacheOverview(__dirname));
      return;
    }

    if (pathname === "/api/cache/clear" && req.method === "POST") {
      const body = req.headers["content-length"] ? JSON.parse(await readBody(req)) : {};
      const ids = Array.isArray(body.ids) ? body.ids : [];
      if (!ids.length) {
        json(res, 400, { error: "请选择要清理的缓存项" });
        return;
      }
      const result = clearCacheItems(ids, __dirname);
      const labels = {
        posts: "已发布帖子缓存",
        uploads: "上传图片/配图",
        tokens: "代币地址列表",
        runtime: "运行时行情/资讯缓存",
        logs: "运行日志",
      };
      const names = result.cleared.map((id) => labels[id] || id).join("、");
      appendSystemLog(`已清理缓存：${names || "无"}`, { type: "info", source: "settings" });
      json(res, 200, {
        ...result,
        message: result.cleared.length
          ? `已清理：${names}`
          : "未清理到可删除内容",
      });
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
      try {
        const result = await publishPost(apiKey, body, uploadsDir, undefined, {
          proxyUrl: resolveAccountProxy(body.accountId),
          cookie: getAccountCookie(body.accountId),
        });
        const accountId = body.accountId || getDefaultAccountId();
        if (accountId && result?.id) {
          cachePublishedPost(accountId, {
            id: result.id,
            text: body.text,
            title: body.title || "",
            shareLink: result.shareLink,
            publishedAt: Date.now(),
            source: "publish",
          });
        }
        json(res, 200, { ok: true, result });
      } catch (err) {
        const status = err?.code === "PUBLISH_CONFIRMATION_UNKNOWN" ? 409 : 500;
        json(res, status, {
          ok: false,
          uncertain: err?.code === "PUBLISH_CONFIRMATION_UNKNOWN",
          error: err.message,
        });
      }
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
      const accountProxy = resolveAccountProxy(body.accountId);
      const globalProxy = getProxyUrl();
      const timeoutMs = Math.max(4000, Math.min(parseInt(body.timeoutMs, 10) || 12000, 30000));
      let stats;
      try {
        stats = await fetchPostStatsByRef(ref, {
          proxyUrl: accountProxy,
          timeoutMs,
          retries: false,
        });
      } catch (err) {
        const msg = err?.message || "";
        const canFallback =
          Boolean(globalProxy) &&
          globalProxy !== accountProxy &&
          /超时|代理|连接|ECONN|ETIMEDOUT|socket|TLS/i.test(msg);
        if (!canFallback) throw err;
        stats = await fetchPostStatsByRef(ref, {
          proxyUrl: globalProxy,
          timeoutMs,
          retries: false,
        });
      }
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

    // 托管列表一键拉取互动（公开读接口）：默认走全局代理，整轮硬截止，避免 SOCKS 卡死
    if (pathname === "/api/hosted/metrics/refresh" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const limitPerAccount = Math.max(1, Math.min(parseInt(body.limitPerAccount, 10) || 5, 12));
      const delayMs = Math.max(0, Math.min(parseInt(body.delayMs, 10) || 50, 800));
      const postTimeoutMs = Math.max(2500, Math.min(parseInt(body.postTimeoutMs, 10) || 4000, 10000));
      const deadlineMs = Math.max(10000, Math.min(parseInt(body.deadlineMs, 10) || 35000, 60000));
      // 默认 false：互动用全局代理（本机梯子），避免坏 SOCKS 拖死；发帖仍走账号代理
      const useAccountProxy = body.useAccountProxy === true;
      const startedAt = Date.now();
      const allAccounts = listAccountsPublic().accounts || [];
      const hasExplicitIds = Array.isArray(body.accountIds);
      let accountIds = hasExplicitIds
        ? body.accountIds.map((id) => String(id || "").trim()).filter(Boolean)
        : [];

      if (!accountIds.length) {
        if (hasExplicitIds) {
          json(res, 400, { error: "没有可刷新的账号" });
          return;
        }
        const settings = readAiSettings();
        if (body.scope === "enabled") {
          accountIds = (settings.hostedAccounts || [])
            .filter((item) => item.enabled)
            .map((item) => item.accountId)
            .filter(Boolean);
        } else {
          accountIds = allAccounts.map((item) => item.id).filter(Boolean);
        }
      }

      if (!accountIds.length) {
        json(res, 400, { error: "没有可刷新的账号" });
        return;
      }

      function remainingMs() {
        return deadlineMs - (Date.now() - startedAt);
      }

      function skippedResult(accountId, error) {
        const account = getAccount(accountId);
        return {
          accountId,
          accountName: account?.name,
          ok: false,
          error,
          metrics: getAccountPostMetrics(accountId),
          refreshedPosts: 0,
          failedPosts: 0,
          usedProxy: Boolean(getProxyUrl() || resolveAccountProxy(accountId)),
          usedFallback: false,
        };
      }

      async function refreshOneAccount(accountId) {
        const account = getAccount(accountId);
        if (!account) {
          return {
            accountId,
            ok: false,
            error: "账号不存在",
            metrics: getAccountPostMetrics(accountId),
            refreshedPosts: 0,
            failedPosts: 0,
            usedProxy: false,
            usedFallback: false,
          };
        }

        if (remainingMs() < postTimeoutMs + 400) {
          return skippedResult(accountId, "整轮超时，已跳过该账号");
        }

        const accountProxyUrl = resolveAccountProxy(accountId);
        const globalProxyUrl = getProxyUrl();
        let activeProxyUrl = useAccountProxy
          ? accountProxyUrl || globalProxyUrl
          : globalProxyUrl || accountProxyUrl;
        let usedFallback = false;
        const canFallbackToGlobal =
          useAccountProxy &&
          Boolean(globalProxyUrl) &&
          globalProxyUrl !== activeProxyUrl;

        const posts = getCachedPosts(accountId, { limit: limitPerAccount });
        if (!posts.length) {
          return {
            accountId,
            accountName: account.name,
            ok: false,
            error: "暂无已缓存帖子，请先发帖或在「已发布」里拉取历史后再获取互动",
            metrics: getAccountPostMetrics(accountId),
            refreshedPosts: 0,
            failedPosts: 0,
            usedProxy: Boolean(activeProxyUrl),
            usedFallback: false,
          };
        }

        if (!activeProxyUrl && !globalProxyUrl) {
          // 无代理时仍尝试直连（部分环境可通）
          activeProxyUrl = "";
        }

        let refreshedPosts = 0;
        let failedPosts = 0;
        let consecutiveFails = 0;
        let lastError = "";
        const updated = [];

        async function fetchStatsOnce(ref, proxyUrl) {
          return fetchPostStatsByRef(ref, {
            proxyUrl,
            timeoutMs: Math.min(postTimeoutMs, Math.max(1800, remainingMs() - 200)),
            retries: false,
          });
        }

        for (let i = 0; i < posts.length; i += 1) {
          if (remainingMs() < Math.min(postTimeoutMs, 2000)) {
            lastError = "整轮超时，已提前结束";
            break;
          }
          const post = posts[i];
          const ref = post.id || post.shareLink;
          if (!ref) continue;
          try {
            let stats;
            try {
              stats = await fetchStatsOnce(ref, activeProxyUrl);
            } catch (err) {
              const msg = err?.message || "刷新失败";
              const proxyDead = /超时|代理|连接|ECONN|ETIMEDOUT|socket|TLS/i.test(msg);
              if (proxyDead && canFallbackToGlobal) {
                activeProxyUrl = globalProxyUrl;
                usedFallback = true;
                consecutiveFails = 0;
                stats = await fetchStatsOnce(ref, activeProxyUrl);
              } else {
                throw err;
              }
            }
            updated.push({
              ...post,
              viewCount: stats.viewCount ?? post.viewCount,
              likeCount: stats.likeCount ?? post.likeCount,
              commentCount: stats.commentCount ?? post.commentCount,
              shareCount: stats.shareCount ?? post.shareCount,
            });
            refreshedPosts += 1;
            consecutiveFails = 0;
          } catch (err) {
            failedPosts += 1;
            consecutiveFails += 1;
            lastError = err?.message || "刷新失败";
            updated.push(post);
            if (
              consecutiveFails >= 2 &&
              /超时|代理|连接|ECONN|ETIMEDOUT|socket|TLS/i.test(lastError)
            ) {
              lastError = `网络/代理不可用（${lastError}），已跳过剩余帖子`;
              break;
            }
          }
          if (delayMs > 0 && i < posts.length - 1) {
            await new Promise((r) => setTimeout(r, delayMs));
          }
        }

        if (updated.length) mergeCachedPosts(accountId, updated);
        return {
          accountId,
          accountName: account.name,
          ok: refreshedPosts > 0,
          error: refreshedPosts
            ? usedFallback
              ? "账号代理不可用，已改用全局代理刷新"
              : null
            : lastError || "帖子互动数据刷新失败（代理超时或网络异常）",
          metrics: getAccountPostMetrics(accountId),
          refreshedPosts,
          failedPosts,
          usedProxy: Boolean(activeProxyUrl),
          usedFallback,
          viaGlobalProxy: !useAccountProxy || usedFallback || activeProxyUrl === globalProxyUrl,
        };
      }

      const accounts = new Array(accountIds.length);
      const concurrency = Math.max(1, Math.min(3, accountIds.length));
      let cursor = 0;

      const workers = Promise.all(
        Array.from({ length: concurrency }, async () => {
          while (cursor < accountIds.length) {
            const index = cursor++;
            if (remainingMs() < 1200) {
              accounts[index] = skippedResult(accountIds[index], "整轮超时，已跳过该账号");
              continue;
            }
            try {
              accounts[index] = await refreshOneAccount(accountIds[index]);
            } catch (err) {
              accounts[index] = skippedResult(
                accountIds[index],
                err?.message || "刷新异常",
              );
            }
          }
        }),
      );

      // 绝对硬截止：即便底层代理 Promise 未结束，也先返回已完成的结果
      await Promise.race([
        workers,
        new Promise((resolve) => setTimeout(resolve, deadlineMs)),
      ]);

      for (let i = 0; i < accountIds.length; i += 1) {
        if (!accounts[i]) {
          accounts[i] = skippedResult(accountIds[i], "整轮超时，已跳过该账号");
        }
      }

      const okCount = accounts.filter((item) => item?.ok).length;
      const failAccounts = accounts.filter((item) => !item?.ok);
      const elapsedMs = Date.now() - startedAt;
      const viaGlobal = !useAccountProxy;
      const summary =
        okCount > 0
          ? `已为 ${okCount}/${accounts.length} 个账号刷新互动${viaGlobal ? "（经全局代理）" : ""}，耗时 ${Math.round(elapsedMs / 1000)}s`
          : `未能刷新互动数据（${accounts.length} 个账号，耗时 ${Math.round(elapsedMs / 1000)}s）`;
      if (failAccounts.length) {
        const detail = failAccounts
          .map((item) => `「${item.accountName || item.accountId}」${item.error || "失败"}`)
          .join("；");
        appendSystemLog(`${summary}；未成功 ${failAccounts.length} 个：${detail}`, {
          type: okCount > 0 ? "info" : "err",
          source: "metrics",
        });
      } else {
        appendSystemLog(summary, { type: "ok", source: "metrics" });
      }
      json(res, 200, {
        ok: okCount > 0,
        message: summary,
        elapsedMs,
        deadlineMs,
        useAccountProxy,
        accounts,
      });
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
      const saved = getAiSettingsPublic();
      json(res, 200, {
        ...saved,
        hostingLocked: Boolean(saved.enabled) || isAiHostRunActive(),
        runActive: isAiHostRunActive(),
      });
      return;
    }

    if (pathname === "/api/ai/providers" && req.method === "GET") {
      json(res, 200, { providers: listAiProvidersPublic() });
      return;
    }

    if (pathname === "/api/ai/config" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const deferFirstRun = Boolean(body?.deferFirstRun);
      if ("deferFirstRun" in body) delete body.deferFirstRun;
      const current = readAiSettings();
      const isDisabling = body?.enabled === false;
      const hostingLocked = Boolean(current.enabled) || isAiHostRunActive();
      if (hostingLocked && !isDisabling) {
        json(res, 409, {
          error: "自动托管进行中，请先点击「取消托管」后再修改设置",
          hostingLocked: true,
        });
        return;
      }
      if (isDisabling) requestAiHostCancel();
      const saved = saveAiSettings(body);
      // 开启托管但不立刻跑：把「上次运行」记为现在，下次按运行间隔再发
      if (deferFirstRun && saved.enabled) {
        markRunStarted();
      }
      const publicSettings = getAiSettingsPublic();
      json(res, 200, {
        ok: true,
        ...publicSettings,
        hostingLocked: Boolean(publicSettings.enabled) || isAiHostRunActive(),
        runActive: isAiHostRunActive(),
      });
      return;
    }

    if (pathname === "/api/ai/status" && req.method === "GET") {
      json(res, 200, getAiSchedulerStatus());
      return;
    }

    if (pathname === "/api/ai/progress" && req.method === "GET") {
      json(res, 200, getAiRunProgress());
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
      const autoMatch = body.autoMatch !== false;
      let profileId = body.aiProfileId || null;
      try {
        const creds = resolveAiCredentials({
          profileId: body.aiProfileId,
          overrides: {
            apiKey: body.apiKey,
            provider: body.provider,
            baseUrl: body.baseUrl,
            model: body.model,
          },
          allowEmptyModel: autoMatch,
        });
        profileId = creds.aiProfileId || body.aiProfileId || null;
        const result = await testAiApiKey(creds.apiKey, {
          provider: creds.provider,
          model: creds.model,
          baseUrl: creds.baseUrl,
          autoMatch,
        });
        recordAiConnectionTest({ ok: true, profileId });
        json(res, 200, result);
      } catch (err) {
        recordAiConnectionTest({
          ok: false,
          error: toChineseError(err) || err?.message || "连接失败",
          profileId,
        });
        throw err;
      }
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
      const tokenMode = normalizeTokenMode(body.tokenMode, body.selectedTokens);
      for (let i = 0; i < count; i++) {
        const selectedTokens =
          tokenMode === TOKEN_MODE_RANDOM_ALL
            ? await pickRandomAllBinanceTokenPair({ recentPairs: getRecentTokenPairs() })
            : body.selectedTokens;
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
          selectedTokens,
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

    if (pathname === "/api/market/hot-tokens" && req.method === "GET") {
      const limit = Math.max(1, Math.min(40, parseInt(url.searchParams.get("limit"), 10) || 18));
      const force = url.searchParams.get("force") === "1";
      const result = await fetchHotNegativeFundingTokens({ limit, force });
      json(res, 200, { ok: true, ...result });
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
