import http from "http";
import https from "https";
import net from "net";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { URL } from "url";
import { parseProxyRuntime } from "./proxy-config.js";
import { wrapErrorZh } from "./error-zh.js";
import { getDirectHttpsAgent } from "./proxy-tunnel-agent.js";

const requireFromHere = createRequire(fileURLToPath(import.meta.url));

const TRANSIENT_NET_RE =
  /超时|连接被拒绝|连接被重置|连接中止|连接已断开|无法解析|无法到达|管道已断开|协议错误|请求失败|代理连接|节点不稳定|换一个节点|ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ENOTFOUND|socket hang up|Socket closed|socket closed|fetch failed|TLS|secure TLS|socket disconnected|Client network socket|EPROTO|EPIPE|EHOSTUNREACH|Proxy connection timed out/i;

const RETRY_DELAYS_MS = [0, 600, 1400, 2800];
const RETRYABLE_METHODS = new Set(["GET", "HEAD", "OPTIONS", "PUT"]);
const RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function abortError(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  if (typeof reason === "string" && reason.trim()) return new Error(reason.trim());
  return new Error("已取消托管");
}

/** 将 AbortSignal 接到可 destroy 的请求/套接字上，取消时立刻断开 */
function wireAbort(signal, destroy) {
  if (!signal) return () => {};
  if (signal.aborted) {
    try {
      destroy(abortError(signal));
    } catch {
      // ignore
    }
    return () => {};
  }
  const onAbort = () => {
    try {
      destroy(abortError(signal));
    } catch {
      // ignore
    }
  };
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

/** Node 的 req.setTimeout / socks timeout 在 TLS 握手或半开代理上可能不触发，用硬截止兜底 */
function withHardTimeout(work, timeoutMs, message = "请求超时") {
  const ms = Math.max(1000, Number(timeoutMs) || 30000);
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(message));
    }, ms);

    Promise.resolve()
      .then(() => (typeof work === "function" ? work() : work))
      .then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        },
      );
  });
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
  const raw = Buffer.concat(chunks);
  return {
    ok: response.statusCode >= 200 && response.statusCode < 300,
    status: response.statusCode,
    statusText: response.statusMessage,
    headers: response.headers || {},
    text: async () => raw.toString("utf8"),
    buffer: async () => raw,
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

function finishHttpsRequest(reqOpts, body, timeoutMs, resolve, reject, signal) {
  const req = https.request(reqOpts, (response) => {
    const chunks = [];
    response.on("data", (c) => chunks.push(c));
    response.on("end", () => {
      unwire();
      resolve(toResponse(response, chunks));
    });
  });
  const unwire = wireAbort(signal, (err) => req.destroy(err));
  req.on("error", (err) => {
    unwire();
    reject(err);
  });
  req.setTimeout(timeoutMs || 60000, () => req.destroy(new Error("请求超时")));
  if (body) req.write(body);
  req.end();
}

function requestDirect(url, options) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const isHttps = target.protocol === "https:";
    const lib = isHttps ? https : http;
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
        port: target.port || (isHttps ? 443 : 80),
        path: target.pathname + target.search,
        method: options.method || "GET",
        headers,
        ...(isHttps ? { agent: getDirectHttpsAgent() } : {}),
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          unwire();
          resolve(toResponse(res, chunks));
        });
      },
    );
    const unwire = wireAbort(options.signal, (err) => req.destroy(err));
    req.on("error", (err) => {
      unwire();
      reject(err);
    });
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

    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      unwire();
      try {
        connectReq.destroy();
      } catch {
        // ignore
      }
      reject(err);
    };
    const unwire = wireAbort(options.signal, fail);

    connectReq.setTimeout(options.timeoutMs || 30000, () =>
      fail(new Error("代理连接超时")),
    );
    connectReq.on("error", fail);
    connectReq.on("connect", (res, socket) => {
      if (settled) {
        socket.destroy();
        return;
      }
      if (res.statusCode !== 200) {
        socket.destroy();
        fail(new Error(`代理连接失败: HTTP ${res.statusCode}`));
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
              if (settled) return;
              settled = true;
              unwire();
              resolve(toResponse(response, chunks));
            });
          },
        );
        wireAbort(options.signal, (err) => {
          try {
            socket.destroy();
          } catch {
            // ignore
          }
          req.destroy(err);
        });
        req.on("error", fail);
        req.setTimeout(options.timeoutMs || 60000, () => req.destroy(new Error("请求超时")));
        if (body) req.write(body);
        req.end();
        return;
      }

      const { body, reqOpts } = buildHttpsOpts(target, options, socket);
      finishHttpsRequest(
        reqOpts,
        body,
        options.timeoutMs,
        (value) => {
          if (settled) return;
          settled = true;
          unwire();
          resolve(value);
        },
        fail,
        options.signal,
      );
    });
    connectReq.end();
  });
}

async function loadSocksClient() {
  let lastError = null;
  try {
    const mod = await import("socks");
    const SocksClient = mod.SocksClient || mod.default?.SocksClient || mod.default;
    if (SocksClient?.createConnection) return SocksClient;
  } catch (err) {
    lastError = err;
  }
  try {
    // 安装版服务进程以 ELECTRON_RUN_AS_NODE 运行时，动态 import 偶发解析失败；
    // createRequire 可从当前 lib 目录稳定解析到 unpacked/node_modules。
    const mod = requireFromHere("socks");
    const SocksClient = mod.SocksClient || mod.default?.SocksClient || mod.default;
    if (SocksClient?.createConnection) return SocksClient;
  } catch (err) {
    lastError = err;
  }
  const detail = String(lastError?.message || lastError || "").trim();
  throw new Error(
    detail
      ? `Socks5 代理依赖加载失败：${detail}`
      : "Socks5 代理依赖未完整打包，请重装/更新应用",
  );
}

async function requestViaSocks5(url, options, runtime) {
  const SocksClient = await loadSocksClient();
  if (!SocksClient?.createConnection) {
    throw new Error("Socks5 代理模块无效，请重装应用");
  }

  if (options.signal?.aborted) throw abortError(options.signal);

  const timeoutMs = options.timeoutMs || 30000;
  const target = new URL(url);
  const destinationPort = target.protocol === "https:" ? 443 : parseInt(target.port || "80", 10);
  let socket = null;
  let connectPending = true;
  const unwireConnect = wireAbort(options.signal, (err) => {
    if (!connectPending) return;
    try {
      socket?.destroy?.(err);
    } catch {
      // ignore
    }
  });
  try {
    ({ socket } = await withHardTimeout(
      SocksClient.createConnection({
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
        timeout: timeoutMs,
      }),
      timeoutMs,
      "代理连接超时",
    ));
  } catch (err) {
    try {
      socket?.destroy?.();
    } catch {
      // ignore
    }
    if (options.signal?.aborted) throw abortError(options.signal);
    throw err;
  } finally {
    connectPending = false;
    unwireConnect();
  }

  if (options.signal?.aborted) {
    try {
      socket.destroy();
    } catch {
      // ignore
    }
    throw abortError(options.signal);
  }

  socket.setKeepAlive(true, 10000);
  socket.setNoDelay(true);

  return new Promise((resolve, reject) => {
    let unwire = () => {};
    const fail = (err) => {
      unwire();
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      reject(err);
    };

    if (target.protocol !== "https:") {
      unwire = wireAbort(options.signal, fail);
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
            unwire();
            resolve(toResponse(response, chunks));
          });
        },
      );
      req.on("error", fail);
      req.setTimeout(timeoutMs, () => fail(new Error("请求超时")));
      if (body) req.write(body);
      req.end();
      return;
    }

    const { body, reqOpts } = buildHttpsOpts(target, options, socket);
    finishHttpsRequest(reqOpts, body, timeoutMs, resolve, fail, options.signal);
  });
}

async function transportFetchOnceInner(url, options = {}) {
  const proxyUrl = options.proxyUrl;
  const {
    proxyUrl: _ignored,
    timeoutMs,
    signal,
    retries: _retries,
    retryUnsafe: _retryUnsafe,
    retryDelaysMs: _retryDelaysMs,
    onRetry: _onRetry,
    ...fetchOptions
  } = options;

  if (signal?.aborted) throw abortError(signal);

  if (!proxyUrl) {
    return requestDirect(url, { ...fetchOptions, timeoutMs, signal });
  }

  // HTTPS 经代理必须用「CONNECT/SOCKS 拿到 TCP 后交给 https.request(socket)」做 TLS。
  // 旧的 Keep-Alive Agent 覆盖了 createConnection 却未 tls.connect，会导致握手挂死直至超时
  // （curl 同代理可通、软件内拉取互动失败）。
  const runtime = parseProxyRuntime(proxyUrl);
  if (!runtime) {
    return requestViaHttpProxy(
      url,
      { ...fetchOptions, timeoutMs, signal },
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
    return requestViaSocks5(url, { ...fetchOptions, timeoutMs, signal }, runtime);
  }

  return requestViaHttpProxy(url, { ...fetchOptions, timeoutMs, signal }, runtime);
}

async function transportFetchOnce(url, options = {}) {
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 30000);
  // +800ms 缓冲：给底层 socket.destroy 一点时间，但仍保证整体不无限挂死
  return withHardTimeout(() => transportFetchOnceInner(url, options), timeoutMs + 800, "请求超时");
}

export async function transportFetch(url, options = {}) {
  if (options.signal?.aborted) throw abortError(options.signal);
  const retries = resolveRetryDelays(options);
  let lastError = null;

  for (let attempt = 0; attempt < retries.length; attempt++) {
    if (options.signal?.aborted) throw abortError(options.signal);
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
      if (options.signal?.aborted || /已取消托管|aborted|AbortError/i.test(err?.message || "")) {
        throw options.signal?.aborted ? abortError(options.signal) : err;
      }
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

/**
 * 只测代理隧道建连耗时（类似 VPN 软件「节点延迟」），不做完整 HTTPS 网页请求。
 * 目标固定为 1.1.1.1:443，经本地代理 CONNECT / SOCKS 打通即结束。
 */
export async function measureProxyConnectLatency(proxyUrl = "", { timeoutMs = 5000 } = {}) {
  const ms = Math.max(1500, Math.min(Number(timeoutMs) || 5000, 8000));
  const destHost = "1.1.1.1";
  const destPort = 443;
  const started = Date.now();

  if (!proxyUrl) {
    await withHardTimeout(
      () =>
        new Promise((resolve, reject) => {
          const socket = netConnect({ host: destHost, port: destPort });
          socket.setTimeout(ms, () => {
            socket.destroy();
            reject(new Error("连接超时"));
          });
          socket.once("connect", () => {
            socket.destroy();
            resolve();
          });
          socket.once("error", reject);
        }),
      ms,
      "连接超时",
    );
    return Date.now() - started;
  }

  const runtime = parseProxyRuntime(proxyUrl);
  if (!runtime) {
    throw new Error("代理配置无效");
  }

  if (runtime.type === "socks5") {
    const SocksClient = await loadSocksClient();
    if (!SocksClient?.createConnection) {
      throw new Error("Socks5 代理模块无效，请重装应用");
    }
    const { socket } = await withHardTimeout(
      SocksClient.createConnection({
        proxy: {
          host: runtime.host,
          port: runtime.port || 1080,
          type: 5,
          userId: runtime.username || undefined,
          password: runtime.password || undefined,
        },
        command: "connect",
        destination: { host: destHost, port: destPort },
        timeout: ms,
      }),
      ms,
      "代理连接超时",
    );
    try {
      socket.destroy();
    } catch {
      // ignore
    }
    return Date.now() - started;
  }

  // HTTP/HTTPS 代理：只做 CONNECT，成功即断开
  await withHardTimeout(
    () =>
      new Promise((resolve, reject) => {
        const headers = {
          Host: `${destHost}:${destPort}`,
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
          path: `${destHost}:${destPort}`,
          headers,
        });
        connectReq.setTimeout(ms, () => connectReq.destroy(new Error("代理连接超时")));
        connectReq.on("error", reject);
        connectReq.on("connect", (res, socket) => {
          try {
            socket.destroy();
          } catch {
            // ignore
          }
          if (res.statusCode !== 200) {
            reject(new Error(`代理连接失败: HTTP ${res.statusCode}`));
            return;
          }
          resolve();
        });
        connectReq.end();
      }),
    ms,
    "代理连接超时",
  );
  return Date.now() - started;
}

function netConnect(options) {
  return net.connect(options);
}
