import http from "http";
import https from "https";
import { URL } from "url";
import { parseProxyRuntime } from "./proxy-config.js";
import { wrapErrorZh } from "./error-zh.js";

const TRANSIENT_NET_RE =
  /超时|连接被拒绝|连接被重置|连接中止|连接已断开|无法解析|无法到达|管道已断开|协议错误|请求失败|代理连接|节点不稳定|换一个节点|ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ENOTFOUND|socket hang up|Socket closed|socket closed|fetch failed|TLS|secure TLS|socket disconnected|Client network socket|EPROTO|EPIPE|EHOSTUNREACH|Proxy connection timed out/i;

const RETRY_DELAYS_MS = [0, 600, 1400, 2800];
const RETRYABLE_METHODS = new Set(["GET", "HEAD", "OPTIONS", "PUT"]);
const RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isTransientNetworkError(message = "") {
  return TRANSIENT_NET_RE.test(String(message || ""));
}

export function isRetryableStatus(status) {
  return RETRYABLE_STATUS_CODES.has(Number(status));
}

export function resolveRetryDelays(options = {}) {
  if (options.retries === false) return [0];

  const method = String(options.method || "GET").toUpperCase();
  if (!RETRYABLE_METHODS.has(method) && options.retryUnsafe !== true) return [0];

  if (Array.isArray(options.retryDelaysMs) && options.retryDelaysMs.length) {
    const delays = options.retryDelaysMs
      .map((value) => Math.max(0, Number(value) || 0))
      .slice(0, 8);
    return delays[0] === 0 ? delays : [0, ...delays];
  }

  return RETRY_DELAYS_MS;
}

function toResponse(response, chunks) {
  return {
    ok: response.statusCode >= 200 && response.statusCode < 300,
    status: response.statusCode,
    statusText: response.statusMessage,
    headers: response.headers || {},
    text: async () => Buffer.concat(chunks).toString("utf8"),
  };
}

function buildHttpsOpts(target, options, socket) {
  const destinationPort =
    target.protocol === "https:" ? 443 : parseInt(target.port || "80", 10);
  const body = options.body
    ? Buffer.isBuffer(options.body)
      ? options.body
      : Buffer.from(options.body)
    : null;
  const headers = { ...options.headers };
  if (body) headers["Content-Length"] = body.length;

  return {
    body,
    reqOpts: {
      host: target.hostname,
      hostname: target.hostname,
      servername: target.hostname, // 经代理隧道时必须显式 SNI，否则易 TLS 握手失败
      port: destinationPort,
      path: target.pathname + target.search,
      method: options.method || "GET",
      headers,
      socket,
      agent: false,
      rejectUnauthorized: true,
    },
  };
}

function finishHttpsRequest(reqOpts, body, timeoutMs, resolve, reject) {
  const req = https.request(reqOpts, (response) => {
    const chunks = [];
    response.on("data", (c) => chunks.push(c));
    response.on("end", () => {
      resolve(toResponse(response, chunks));
    });
  });
  req.on("error", reject);
  req.setTimeout(timeoutMs || 60000, () => req.destroy(new Error("请求超时")));
  if (body) req.write(body);
  req.end();
}

function requestDirect(url, options) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const lib = target.protocol === "https:" ? https : http;
    const body = options.body
      ? Buffer.isBuffer(options.body)
        ? options.body
        : Buffer.from(options.body)
      : null;
    const headers = { ...options.headers };
    if (body) headers["Content-Length"] = body.length;

    const req = lib.request(
      {
        hostname: target.hostname,
        servername: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        path: target.pathname + target.search,
        method: options.method || "GET",
        headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve(toResponse(res, chunks));
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(options.timeoutMs || 60000, () => req.destroy(new Error("请求超时")));
    if (body) req.write(body);
    req.end();
  });
}

function requestViaHttpProxy(url, options, runtime) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const destPort = target.protocol === "https:" ? 443 : parseInt(target.port || "80", 10);
    const connectTarget = `${target.hostname}:${destPort}`;
    const headers = {
      Host: connectTarget,
      "Proxy-Connection": "keep-alive",
    };
    if (runtime.username || runtime.password) {
      headers["Proxy-Authorization"] = `Basic ${Buffer.from(
        `${runtime.username || ""}:${runtime.password || ""}`,
      ).toString("base64")}`;
    }

    const connectReq = http.request({
      host: runtime.host,
      port: runtime.port || 80,
      method: "CONNECT",
      path: connectTarget,
      headers,
    });

    connectReq.setTimeout(options.timeoutMs || 30000, () =>
      connectReq.destroy(new Error("代理连接超时")),
    );
    connectReq.on("error", reject);
    connectReq.on("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`代理连接失败: HTTP ${res.statusCode}`));
        return;
      }

      // 避免代理侧空闲断连导致握手中途掉线
      socket.setKeepAlive(true, 10000);
      socket.setNoDelay(true);

      if (target.protocol !== "https:") {
        const body = options.body
          ? Buffer.isBuffer(options.body)
            ? options.body
            : Buffer.from(options.body)
          : null;
        const reqHeaders = { ...options.headers };
        if (body) reqHeaders["Content-Length"] = body.length;
        const req = http.request(
          {
            host: target.hostname,
            port: target.port || 80,
            path: target.pathname + target.search,
            method: options.method || "GET",
            headers: reqHeaders,
            socket,
            agent: false,
          },
          (response) => {
            const chunks = [];
            response.on("data", (c) => chunks.push(c));
            response.on("end", () => {
              resolve(toResponse(response, chunks));
            });
          },
        );
        req.on("error", reject);
        req.setTimeout(options.timeoutMs || 60000, () => req.destroy(new Error("请求超时")));
        if (body) req.write(body);
        req.end();
        return;
      }

      const { body, reqOpts } = buildHttpsOpts(target, options, socket);
      finishHttpsRequest(reqOpts, body, options.timeoutMs, resolve, reject);
    });
    connectReq.end();
  });
}

async function requestViaSocks5(url, options, runtime) {
  let SocksClient;
  try {
    ({ SocksClient } = await import("socks"));
  } catch {
    throw new Error("Socks5 代理需要 socks 模块，请运行 npm install");
  }

  const target = new URL(url);
  const destinationPort = target.protocol === "https:" ? 443 : parseInt(target.port || "80", 10);
  const { socket } = await SocksClient.createConnection({
    proxy: {
      host: runtime.host,
      port: runtime.port || 1080,
      type: 5,
      userId: runtime.username || undefined,
      password: runtime.password || undefined,
    },
    command: "connect",
    destination: {
      host: target.hostname,
      port: destinationPort,
    },
    timeout: options.timeoutMs || 30000,
  });

  socket.setKeepAlive(true, 10000);
  socket.setNoDelay(true);

  return new Promise((resolve, reject) => {
    if (target.protocol !== "https:") {
      const body = options.body
        ? Buffer.isBuffer(options.body)
          ? options.body
          : Buffer.from(options.body)
        : null;
      const headers = { ...options.headers };
      if (body) headers["Content-Length"] = body.length;
      const req = http.request(
        {
          host: target.hostname,
          port: destinationPort,
          path: target.pathname + target.search,
          method: options.method || "GET",
          headers,
          socket,
          agent: false,
        },
        (response) => {
          const chunks = [];
        response.on("data", (c) => chunks.push(c));
        response.on("end", () => {
          resolve(toResponse(response, chunks));
        });
        },
      );
      req.on("error", reject);
      req.setTimeout(options.timeoutMs || 60000, () => req.destroy(new Error("请求超时")));
      if (body) req.write(body);
      req.end();
      return;
    }

    const { body, reqOpts } = buildHttpsOpts(target, options, socket);
    finishHttpsRequest(reqOpts, body, options.timeoutMs, resolve, reject);
  });
}

async function transportFetchOnce(url, options = {}) {
  const proxyUrl = options.proxyUrl;
  const {
    proxyUrl: _ignored,
    timeoutMs,
    retries: _retries,
    retryUnsafe: _retryUnsafe,
    retryDelaysMs: _retryDelaysMs,
    onRetry: _onRetry,
    ...fetchOptions
  } = options;

  if (!proxyUrl) {
    return requestDirect(url, { ...fetchOptions, timeoutMs });
  }

  const runtime = parseProxyRuntime(proxyUrl);
  if (!runtime) {
    return requestViaHttpProxy(
      url,
      { ...fetchOptions, timeoutMs },
      {
        type: "http",
        host: new URL(proxyUrl).hostname,
        port: parseInt(new URL(proxyUrl).port, 10) || 80,
        username: "",
        password: "",
      },
    );
  }

  if (runtime.type === "socks5") {
    return requestViaSocks5(url, { ...fetchOptions, timeoutMs }, runtime);
  }

  return requestViaHttpProxy(url, { ...fetchOptions, timeoutMs }, runtime);
}

export async function transportFetch(url, options = {}) {
  const retries = resolveRetryDelays(options);
  let lastError = null;

  for (let attempt = 0; attempt < retries.length; attempt++) {
    const delayMs = retries[attempt];
    if (delayMs > 0) await sleep(delayMs);
    try {
      const response = await transportFetchOnce(url, options);
      if (isRetryableStatus(response.status) && attempt < retries.length - 1) {
        lastError = new Error(`上游服务暂时不可用（HTTP ${response.status}）`);
        options.onRetry?.({
          attempt: attempt + 1,
          nextAttempt: attempt + 2,
          delayMs: retries[attempt + 1],
          status: response.status,
        });
        continue;
      }
      return response;
    } catch (err) {
      lastError = wrapErrorZh(err);
      const transient =
        isTransientNetworkError(err.message || "") || isTransientNetworkError(lastError.message);
      if (!transient || attempt >= retries.length - 1) break;
      options.onRetry?.({
        attempt: attempt + 1,
        nextAttempt: attempt + 2,
        delayMs: retries[attempt + 1],
        error: lastError,
      });
    }
  }

  throw lastError || new Error("网络请求失败");
}
