/**
 * AI 发帖配图：按重点代币下载公开图标（无需 API Key），写入 uploads 供发布使用。
 */
import fs from "fs";
import path from "path";
import https from "https";
import http from "http";
import { getProxyUrl } from "./square-api.js";

const MAX_IMAGES = 2;

function fetchBinary(url, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const lib = target.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        path: target.pathname + target.search,
        method: "GET",
        headers: {
          "User-Agent": "binance-square-poster/1.0",
          Accept: "image/*,*/*",
        },
        timeout: timeoutMs,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          fetchBinary(new URL(res.headers.location, url).toString(), timeoutMs).then(resolve).catch(reject);
          return;
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode, buffer: Buffer.concat(chunks), contentType: res.headers["content-type"] || "" }),
        );
      },
    );
    req.on("timeout", () => req.destroy(new Error("请求超时")));
    req.on("error", reject);
    req.end();
  });
}

function fetchBinaryViaProxy(url, proxyUrl, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const proxy = new URL(proxyUrl);
    const connectReq = http.request({
      host: proxy.hostname,
      port: proxy.port || 80,
      method: "CONNECT",
      path: `${target.hostname}:443`,
    });
    connectReq.setTimeout(timeoutMs, () => connectReq.destroy(new Error("代理连接超时")));
    connectReq.on("error", reject);
    connectReq.on("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        reject(new Error(`代理连接失败: HTTP ${res.statusCode}`));
        return;
      }
      const req = https.request(
        {
          host: target.hostname,
          hostname: target.hostname,
          servername: target.hostname,
          port: 443,
          path: target.pathname + target.search,
          method: "GET",
          headers: { "User-Agent": "binance-square-poster/1.0", Accept: "image/*,*/*" },
          socket,
          agent: false,
          timeout: timeoutMs,
        },
        (response) => {
          if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
            fetchBinaryViaProxy(new URL(response.headers.location, url).toString(), proxyUrl, timeoutMs)
              .then(resolve)
              .catch(reject);
            return;
          }
          const chunks = [];
          response.on("data", (c) => chunks.push(c));
          response.on("end", () =>
            resolve({
              status: response.statusCode,
              buffer: Buffer.concat(chunks),
              contentType: response.headers["content-type"] || "",
            }),
          );
        },
      );
      req.on("timeout", () => req.destroy(new Error("请求超时")));
      req.on("error", reject);
      req.end();
    });
    connectReq.end();
  });
}

async function downloadImageBuffer(url) {
  const proxy = getProxyUrl();
  const res = proxy ? await fetchBinaryViaProxy(url, proxy) : await fetchBinary(url);
  if (res.status !== 200 || !res.buffer?.length || res.buffer.length < 200) return null;
  const ct = String(res.contentType || "").toLowerCase();
  if (ct && !ct.includes("image") && !ct.includes("octet-stream")) return null;
  // 粗过滤 HTML 错误页
  const head = res.buffer.slice(0, 32).toString("utf8").toLowerCase();
  if (head.includes("<!doctype") || head.includes("<html")) return null;
  return res.buffer;
}

function extFromBuffer(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return "png";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "jpg";
  if (buf[0] === 0x47 && buf[1] === 0x49) return "gif";
  if (buf[0] === 0x52 && buf[1] === 0x49) return "webp";
  return "png";
}

function iconUrlCandidates(symbol) {
  const s = String(symbol || "").toLowerCase();
  if (!s) return [];
  return [
    `https://raw.githubusercontent.com/spothq/cryptocurrency-icons/master/128/color/${s}.png`,
    `https://assets.coincap.io/assets/icons/${s}@2x.png`,
  ];
}

async function downloadTokenIcon(symbol, uploadsDir) {
  for (const url of iconUrlCandidates(symbol)) {
    try {
      const buf = await downloadImageBuffer(url);
      if (!buf) continue;
      const ext = extFromBuffer(buf);
      const filename = `ai_${String(symbol).toUpperCase()}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.${ext}`;
      const fullPath = path.join(uploadsDir, filename);
      fs.writeFileSync(fullPath, buf);
      return filename;
    } catch {
      // try next
    }
  }
  return null;
}

/**
 * @param {{ focusTokens?: string[], uploadsDir: string, maxImages?: number }} options
 * @returns {Promise<string[]>} 上传目录内相对文件名
 */
export async function prepareRelatedPostImages({ focusTokens = [], uploadsDir, maxImages = MAX_IMAGES } = {}) {
  if (!uploadsDir) return [];
  fs.mkdirSync(uploadsDir, { recursive: true });
  const tokens = [...new Set((focusTokens || []).map((s) => String(s || "").toUpperCase()).filter(Boolean))];
  if (!tokens.length) return [];

  const limit = Math.max(1, Math.min(Number(maxImages) || MAX_IMAGES, 4));
  const paths = [];
  for (const symbol of tokens) {
    if (paths.length >= limit) break;
    const saved = await downloadTokenIcon(symbol, uploadsDir);
    if (saved) paths.push(saved);
  }
  return paths;
}
