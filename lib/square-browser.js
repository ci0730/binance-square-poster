import fs from "fs";
import { chromium } from "playwright";
import { getProxyUrl, getBinanceCookie, getBrowserPath } from "./square-api.js";
import { toPlaywrightProxy } from "./proxy-config.js";

const BASE = "https://www.binance.com";
const API_PATTERN = /queryReplyPostListByContentIdWithFilter/i;

const REPLAY_HEADER_KEYS = [
  "bnc-uuid",
  "bnc-time-zone",
  "csrftoken",
  "clienttype",
  "lang",
  "versioncode",
  "device-info",
  "fvideo-id",
  "fvideo-token",
];

/** 按 cookie+代理 隔离浏览器客户端，支持多账号并行拉历史 */
const clientPool = new Map();
const CLIENT_POOL_MAX = 3;

function clientPoolKey(cookieStr = "", proxyUrl = "") {
  const browserPath = getBrowserPath() || "";
  return `${String(cookieStr || "")}\n${String(proxyUrl || "")}\n${browserPath}`;
}

const HEADLESS_CHROME_ARGS = [
  "--headless=new",
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--disable-blink-features=AutomationControlled",
  "--disable-gpu",
  "--hide-scrollbars",
  "--mute-audio",
  "--window-position=-32000,-32000",
  "--window-size=1280,720",
];

function buildLaunchOptions(proxyUrl) {
  const launchOpts = {
    headless: true,
    // 禁止弹出可见浏览器窗口（部分本机 Chrome 在 headless 下仍会闪白窗）
    args: [...HEADLESS_CHROME_ARGS],
    ignoreDefaultArgs: ["--enable-automation"],
  };
  const effectiveProxy = proxyUrl !== undefined ? proxyUrl : getProxyUrl();
  if (effectiveProxy) {
    launchOpts.proxy = toPlaywrightProxy(effectiveProxy) || { server: effectiveProxy };
  }
  const executablePath = getBrowserPath();
  if (executablePath) {
    if (!fs.existsSync(executablePath)) {
      throw new Error(`浏览器路径不存在：${executablePath}`);
    }
    launchOpts.executablePath = executablePath;
  }
  return launchOpts;
}

function cryptoUuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function mapComment(reply) {
  return {
    id: reply.id != null ? String(reply.id) : null,
    author: reply.displayName || reply.username || reply.authorName || "未知用户",
    text: (reply.bodyTextOnly || reply.summary || reply.body || "").trim(),
    time: reply.createTime || reply.date || null,
    likeCount: reply.likeCount ?? null,
  };
}

function parseCookieString(cookieStr, domain = ".binance.com") {
  return cookieStr
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const idx = part.indexOf("=");
      if (idx <= 0) return null;
      return {
        name: part.slice(0, idx).trim(),
        value: part.slice(idx + 1).trim(),
        domain,
        path: "/",
      };
    })
    .filter(Boolean);
}

function extractCommentsFromPayload(payload) {
  if (!payload || typeof payload !== "object") return [];
  const data = payload.data ?? payload;
  const lists = [
    data.replyPostList,
    data.childReplyPostList,
    data.list,
    data.vos,
    data.records,
    data.items,
  ].filter(Array.isArray);

  const merged = [];
  for (const list of lists) merged.push(...list);
  return merged.map(mapComment).filter((c) => c.text);
}

class SquareBrowserClient {
  constructor() {
    this.browser = null;
    this.context = null;
    this.page = null;
    this.sniffedHeaders = {};
  }

  async init(cookieStr, proxyUrl) {
    this.browser = await chromium.launch(buildLaunchOptions(proxyUrl));
    this.context = await this.browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
      locale: "zh-CN",
      viewport: { width: 1440, height: 900 },
      extraHTTPHeaders: { "accept-language": "zh-CN,zh;q=0.9,en;q=0.5" },
    });
    this.page = await this.context.newPage();

    const cookie = cookieStr ?? getBinanceCookie();
    if (cookie) {
      const cookies = parseCookieString(cookie);
      if (cookies.length) await this.context.addCookies(cookies);
    }

    this.page.on("request", (req) => {
      if (!/\/bapi\/composite\//i.test(req.url())) return;
      if (this.sniffedHeaders["device-info"]) return;
      const headers = req.headers();
      for (const key of REPLAY_HEADER_KEYS) {
        if (headers[key]) this.sniffedHeaders[key] = headers[key];
      }
    });

    await this.page.goto(`${BASE}/zh-CN/square`, { waitUntil: "domcontentloaded", timeout: 45000 });
    const deadline = Date.now() + 20000;
    while (!this.sniffedHeaders["device-info"] && Date.now() < deadline) {
      await this.page.waitForTimeout(200);
    }
    if (!this.sniffedHeaders["device-info"]) {
      throw new Error("无法获取币安浏览器指纹，请检查代理或网络");
    }
  }

  async fetchComments(postId) {
    if (!this.page) throw new Error("浏览器未初始化");

    const captured = [];
    const onResponse = async (resp) => {
      const url = resp.url();
      if (!API_PATTERN.test(url)) return;
      try {
        const ct = resp.headers()["content-type"] || "";
        if (!ct.includes("application/json")) return;
        const body = await resp.json();
        captured.push({ url, body, requestBody: resp.request().postData() });
      } catch {
        // ignore
      }
    };

    this.page.on("response", onResponse);
    try {
      await this.page.goto(`${BASE}/zh-CN/square/post/${postId}`, {
        waitUntil: "domcontentloaded",
        timeout: 45000,
      });
      await this.page.waitForTimeout(5000);

      const expandBtn = this.page.locator("text=/查看\\s*\\d+\\s*条回复/").first();
      if (await expandBtn.count()) {
        await expandBtn.click({ timeout: 3000 }).catch(() => {});
        await this.page.waitForTimeout(3000);
      }

      for (const item of captured) {
        const comments = extractCommentsFromPayload(item.body);
        if (comments.length) {
          return {
            comments,
            source: "network",
            requestBody: item.requestBody,
            fetchedAt: Date.now(),
          };
        }
      }

      const apiResult = await this.tryCommentApi(postId, captured);
      if (apiResult?.comments?.length) return apiResult;

      const domComments = await this.scrapeCommentsFromDom();
      if (domComments.length) {
        return { comments: domComments, source: "dom", fetchedAt: Date.now() };
      }

      const needsLogin = !getBinanceCookie();
      if (captured.length) {
        return {
          comments: [],
          needsLogin: true,
          hint: needsLogin
            ? "请在设置中粘贴币安登录 Cookie 后重试"
            : "Cookie 可能已过期，请重新从浏览器复制",
          fetchedAt: Date.now(),
        };
      }

      return {
        comments: [],
        needsLogin: true,
        hint: "币安要求登录后才能查看评论，请在设置中配置 Cookie",
        fetchedAt: Date.now(),
      };
    } finally {
      this.page.off("response", onResponse);
    }
  }

  async tryCommentApi(postId, captured) {
    const requestBodies = [];
    for (const item of captured) {
      if (item.requestBody) {
        try {
          requestBodies.push(JSON.parse(item.requestBody));
        } catch {
          // ignore
        }
      }
    }

    if (!requestBodies.length) {
      requestBodies.push(
        { contentId: postId, pageIndex: 1, pageSize: 20, sortType: 1, filterType: 1 },
        { contentId: Number(postId), pageIndex: 1, pageSize: 20, sortType: 1, filterType: 1 },
        { contentId: postId, pageIndex: 1, pageSize: 20, sortType: 0, filterType: 0 },
      );
    }

    const path = "/bapi/composite/v2/friendly/pgc/content/queryReplyPostListByContentIdWithFilter";
    for (const payload of requestBodies) {
      const traceId = cryptoUuid();
      const headers = {
        ...this.sniffedHeaders,
        "content-type": "application/json",
        "x-trace-id": traceId,
        "x-ui-request-trace": traceId,
      };

      const result = await this.page.evaluate(
        async ({ path, payload, headers }) => {
          const resp = await fetch(path, {
            method: "POST",
            headers,
            body: JSON.stringify(payload),
            credentials: "include",
          });
          return { status: resp.status, text: await resp.text() };
        },
        { path, payload, headers },
      );

      let json;
      try {
        json = JSON.parse(result.text);
      } catch {
        continue;
      }
      if (json.code !== "000000") continue;
      const comments = extractCommentsFromPayload(json);
      if (comments.length) {
        return {
          comments,
          source: "api",
          requestBody: JSON.stringify(payload),
          fetchedAt: Date.now(),
        };
      }
    }
    return null;
  }

  async replayGet(path, query = {}) {
    if (!this.page) throw new Error("浏览器未初始化");
    const traceId = cryptoUuid();
    const headers = {
      ...this.sniffedHeaders,
      "x-trace-id": traceId,
      "x-ui-request-trace": traceId,
    };
    const qs = Object.entries(query)
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join("&");
    const fullPath = qs ? `${path}?${qs}` : path;

    const result = await this.page.evaluate(
      async ({ path, headers }) => {
        const resp = await fetch(path, { method: "GET", headers, credentials: "include" });
        return { status: resp.status, text: await resp.text() };
      },
      { path: fullPath, headers },
    );
    return parseApiResponse("GET", fullPath, result.status, result.text);
  }

  async replayPost(path, payload) {
    if (!this.page) throw new Error("浏览器未初始化");
    const traceId = cryptoUuid();
    const headers = {
      ...this.sniffedHeaders,
      "content-type": "application/json",
      "x-trace-id": traceId,
      "x-ui-request-trace": traceId,
    };

    const result = await this.page.evaluate(
      async ({ path, payload, headers }) => {
        const resp = await fetch(path, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          credentials: "include",
        });
        return { status: resp.status, text: await resp.text() };
      },
      { path, payload, headers },
    );
    return parseApiResponse("POST", path, result.status, result.text);
  }

  async scrapeCommentsFromDom() {
    return this.page.evaluate(() => {
      const results = [];
      const selectors = [
        "[class*='comment'] [class*='content']",
        "[class*='reply'] [class*='content']",
        "[data-testid*='comment']",
        "[data-testid*='reply']",
      ];
      const seen = new Set();
      for (const sel of selectors) {
        document.querySelectorAll(sel).forEach((el) => {
          const text = (el.textContent || "").trim();
          if (!text || text.length < 2 || text.length > 500 || seen.has(text)) return;
          seen.add(text);
          results.push({ author: "用户", text, time: null, likeCount: null, id: null });
        });
      }
      return results.slice(0, 20);
    });
  }

  async close() {
    await this.page?.close().catch(() => {});
    await this.context?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
    this.page = null;
    this.context = null;
    this.browser = null;
  }
}

function parseApiResponse(method, path, status, text) {
  if (status < 200 || status >= 300) {
    throw new Error(`${method} ${path} ${status}: ${text.slice(0, 300)}`);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${method} ${path}: 响应不是 JSON`);
  }
  if (json.code !== "000000" || json.success === false) {
    throw new Error(`[${json.code || "ERR"}] ${json.message || "请求失败"}`);
  }
  return json;
}

export async function testBrowserLaunch(executablePath = "") {
  const path = String(executablePath || getBrowserPath() || "").trim();
  const launchOpts = {
    headless: true,
    args: [...HEADLESS_CHROME_ARGS],
  };
  if (path) {
    if (!fs.existsSync(path)) throw new Error(`浏览器路径不存在：${path}`);
    launchOpts.executablePath = path;
  }
  let browser;
  try {
    browser = await chromium.launch(launchOpts);
    return {
      ok: true,
      message: path ? `浏览器启动成功：${path}` : "Playwright 内置 Chromium 启动成功",
      browserPath: path || null,
    };
  } finally {
    await browser?.close().catch(() => {});
  }
}

async function getClient(cookieStr = "", proxyUrl) {
  const cookie = cookieStr ?? "";
  const proxy = proxyUrl !== undefined ? proxyUrl : getProxyUrl() || "";
  const key = clientPoolKey(cookie, proxy);
  const existing = clientPool.get(key);
  if (existing) {
    // LRU：挪到末尾
    clientPool.delete(key);
    clientPool.set(key, existing);
    return existing;
  }

  // 池满时关掉最久未用的，避免并行拉历史时互相 close 掉正在用的浏览器
  while (clientPool.size >= CLIENT_POOL_MAX) {
    const [oldKey, oldPromise] = clientPool.entries().next().value;
    clientPool.delete(oldKey);
    try {
      const oldClient = await oldPromise;
      await oldClient.close();
    } catch {
      // ignore
    }
  }

  const created = (async () => {
    const client = new SquareBrowserClient();
    await client.init(cookie, proxy);
    return client;
  })();
  clientPool.set(key, created);
  try {
    return await created;
  } catch (err) {
    clientPool.delete(key);
    throw err;
  }
}

export async function runWithBrowser(cookieStr, fn, { proxyUrl } = {}) {
  const client = await getClient(cookieStr || "", proxyUrl);
  return fn(client);
}

export async function fetchPostComments(postId, cookieStr = "", { proxyUrl } = {}) {
  const client = await getClient(cookieStr, proxyUrl);
  return client.fetchComments(String(postId));
}

export async function fetchPostCommentsByRef(shareLinkOrId, { cookie, proxyUrl } = {}) {
  const { extractPostId } = await import("./square-stats.js");
  const postId = extractPostId(shareLinkOrId);
  if (!postId) throw new Error("无法从链接中解析帖子 ID");
  return fetchPostComments(postId, cookie || "", { proxyUrl });
}

export async function closeBrowserClient() {
  const entries = [...clientPool.entries()];
  clientPool.clear();
  await Promise.all(
    entries.map(async ([, promise]) => {
      try {
        const client = await promise;
        await client.close();
      } catch {
        // ignore
      }
    }),
  );
}

process.on("exit", () => {
  closeBrowserClient().catch(() => {});
});
