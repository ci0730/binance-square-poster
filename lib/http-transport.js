import http from "http";
import https from "https";
import { URL } from "url";
import { parseProxyRuntime } from "./proxy-config.js";

function requestDirect(url, options) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const lib = target.protocol === "https:" ? https : http;
    const body = options.body ? (Buffer.isBuffer(options.body) ? options.body : Buffer.from(options.body)) : null;
    const headers = { ...options.headers };
    if (body) headers["Content-Length"] = body.length;

    const req = lib.request(
      {
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        path: target.pathname + target.search,
        method: options.method || "GET",
        headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            statusText: res.statusMessage,
            text: async () => Buffer.concat(chunks).toString("utf8"),
          });
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
    const headers = {};
    if (runtime.username || runtime.password) {
      headers["Proxy-Authorization"] = `Basic ${Buffer.from(`${runtime.username || ""}:${runtime.password || ""}`).toString("base64")}`;
    }

    const connectReq = http.request({
      host: runtime.host,
      port: runtime.port || 80,
      method: "CONNECT",
      path: `${target.hostname}:${target.protocol === "https:" ? 443 : target.port || 80}`,
      headers,
    });

    connectReq.setTimeout(options.timeoutMs || 30000, () => connectReq.destroy(new Error("代理连接超时")));
    connectReq.on("error", reject);
    connectReq.on("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        reject(new Error(`代理连接失败: HTTP ${res.statusCode}`));
        return;
      }

      const body = options.body ? (Buffer.isBuffer(options.body) ? options.body : Buffer.from(options.body)) : null;
      const reqHeaders = { ...options.headers };
      if (body) reqHeaders["Content-Length"] = body.length;

      const req = https.request(
        {
          host: target.hostname,
          port: target.protocol === "https:" ? 443 : target.port || 80,
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
            resolve({
              ok: response.statusCode >= 200 && response.statusCode < 300,
              status: response.statusCode,
              statusText: response.statusMessage,
              text: async () => Buffer.concat(chunks).toString("utf8"),
            });
          });
        },
      );
      req.on("error", reject);
      req.setTimeout(options.timeoutMs || 60000, () => req.destroy(new Error("请求超时")));
      if (body) req.write(body);
      req.end();
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

  return new Promise((resolve, reject) => {
    const body = options.body ? (Buffer.isBuffer(options.body) ? options.body : Buffer.from(options.body)) : null;
    const headers = { ...options.headers };
    if (body) headers["Content-Length"] = body.length;

    const req = https.request(
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
          resolve({
            ok: response.statusCode >= 200 && response.statusCode < 300,
            status: response.statusCode,
            statusText: response.statusMessage,
            text: async () => Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(options.timeoutMs || 60000, () => req.destroy(new Error("请求超时")));
    if (body) req.write(body);
    req.end();
  });
}

export async function transportFetch(url, options = {}) {
  const proxyUrl = options.proxyUrl;
  const { proxyUrl: _ignored, timeoutMs, ...fetchOptions } = options;

  if (!proxyUrl) {
    return requestDirect(url, { ...fetchOptions, timeoutMs });
  }

  const runtime = parseProxyRuntime(proxyUrl);
  if (!runtime) {
    return requestViaHttpProxy(url, { ...fetchOptions, timeoutMs }, {
      type: "http",
      host: new URL(proxyUrl).hostname,
      port: parseInt(new URL(proxyUrl).port, 10) || 80,
      username: "",
      password: "",
    });
  }

  if (runtime.type === "socks5") {
    return requestViaSocks5(url, { ...fetchOptions, timeoutMs }, runtime);
  }

  return requestViaHttpProxy(url, { ...fetchOptions, timeoutMs }, runtime);
}
