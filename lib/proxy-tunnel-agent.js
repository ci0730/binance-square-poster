/**
 * 按代理 URL 复用 HTTPS Agent（Keep-Alive 隧道）。
 * 同类 VPN 工具稳定的关键：本地 Clash 常驻 + 客户端连接复用，而不是每次请求新建 SOCKS/CONNECT。
 */
import http from "http";
import https from "https";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { parseProxyRuntime } from "./proxy-config.js";

const requireFromHere = createRequire(fileURLToPath(import.meta.url));

const agents = new Map();
const DIRECT_AGENT = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 20_000,
  maxSockets: 8,
  maxFreeSockets: 4,
  scheduling: "lifo",
});

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
    const mod = requireFromHere("socks");
    const SocksClient = mod.SocksClient || mod.default?.SocksClient || mod.default;
    if (SocksClient?.createConnection) return SocksClient;
  } catch (err) {
    lastError = err;
  }
  throw new Error(`Socks5 代理依赖加载失败：${String(lastError?.message || lastError || "")}`);
}

function agentKey(proxyUrl = "") {
  return String(proxyUrl || "").trim() || "direct";
}

function createHttpConnectAgent(runtime) {
  return new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 20_000,
    maxSockets: 6,
    maxFreeSockets: 3,
    scheduling: "lifo",
    createConnection(options, callback) {
      const destHost = options.host || options.hostname;
      const destPort = Number(options.port) || 443;
      const connectTarget = `${destHost}:${destPort}`;
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

      const fail = (err) => {
        try {
          connectReq.destroy();
        } catch {
          // ignore
        }
        callback(err);
      };

      connectReq.setTimeout(20_000, () => fail(new Error("代理连接超时")));
      connectReq.on("error", fail);
      connectReq.on("connect", (res, socket) => {
        if (res.statusCode !== 200) {
          socket.destroy();
          fail(new Error(`代理连接失败: HTTP ${res.statusCode}`));
          return;
        }
        socket.setKeepAlive(true, 10_000);
        socket.setNoDelay(true);
        callback(null, socket);
      });
      connectReq.end();
    },
  });
}

function createSocksAgent(runtime, SocksClient) {
  return new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 20_000,
    maxSockets: 6,
    maxFreeSockets: 3,
    scheduling: "lifo",
    createConnection(options, callback) {
      const destHost = options.host || options.hostname;
      const destPort = Number(options.port) || 443;
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
        timeout: 20_000,
      })
        .then(({ socket }) => {
          socket.setKeepAlive(true, 10_000);
          socket.setNoDelay(true);
          callback(null, socket);
        })
        .catch((err) => callback(err));
    },
  });
}

/**
 * @returns {Promise<import('https').Agent>}
 */
export async function getProxyHttpsAgent(proxyUrl = "") {
  const key = agentKey(proxyUrl);
  if (!proxyUrl) return DIRECT_AGENT;

  const cached = agents.get(key);
  if (cached) return cached;

  const runtime = parseProxyRuntime(proxyUrl);
  if (!runtime?.host) return DIRECT_AGENT;

  let agent;
  if (runtime.type === "socks5") {
    const SocksClient = await loadSocksClient();
    agent = createSocksAgent(runtime, SocksClient);
  } else {
    agent = createHttpConnectAgent(runtime);
  }

  agents.set(key, agent);
  return agent;
}

export function dropProxyHttpsAgent(proxyUrl = "") {
  const key = agentKey(proxyUrl);
  if (key === "direct") return;
  const agent = agents.get(key);
  if (!agent) return;
  try {
    agent.destroy();
  } catch {
    // ignore
  }
  agents.delete(key);
}

export function getDirectHttpsAgent() {
  return DIRECT_AGENT;
}
