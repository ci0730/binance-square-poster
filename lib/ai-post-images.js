/**
 * AI 发帖配图：优先新闻配图 + K 线走势图，图标仅作兜底。
 */
import fs from "fs";
import path from "path";
import https from "https";
import http from "http";
import zlib from "zlib";
import { getProxyUrl } from "./square-api.js";

const MAX_IMAGES = 2;
const KLINE_URLS = [
  (pair, interval, limit) =>
    `https://data-api.binance.vision/api/v3/klines?symbol=${pair}&interval=${interval}&limit=${limit}`,
  (pair, interval, limit) =>
    `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=${interval}&limit=${limit}`,
  (pair, interval, limit) =>
    `https://fapi.binance.com/fapi/v1/klines?symbol=${pair}&interval=${interval}&limit=${limit}`,
  (pair, interval, limit) =>
    `https://fapi.binance.vision/fapi/v1/klines?symbol=${pair}&interval=${interval}&limit=${limit}`,
];

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
          Accept: "image/*,application/json,*/*",
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
          headers: { "User-Agent": "binance-square-poster/1.0", Accept: "image/*,application/json,*/*" },
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

async function downloadImageBuffer(url, timeoutMs = 10000) {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const proxy = getProxyUrl();
  const res = proxy ? await fetchBinaryViaProxy(url, proxy, timeoutMs) : await fetchBinary(url, timeoutMs);
  if (res.status !== 200 || !res.buffer?.length || res.buffer.length < 200) return null;
  const ct = String(res.contentType || "").toLowerCase();
  if (ct && !ct.includes("image") && !ct.includes("octet-stream") && !ct.includes("json")) return null;
  const head = res.buffer.slice(0, 32).toString("utf8").toLowerCase();
  if (head.includes("<!doctype") || head.includes("<html")) return null;
  return res.buffer;
}

async function fetchJsonBuffer(url) {
  const proxy = getProxyUrl();
  const res = proxy ? await fetchBinaryViaProxy(url, proxy) : await fetchBinary(url);
  if (res.status !== 200 || !res.buffer?.length) return null;
  try {
    return JSON.parse(res.buffer.toString("utf8"));
  } catch {
    return null;
  }
}

function extFromBuffer(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return "png";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "jpg";
  if (buf[0] === 0x47 && buf[1] === 0x49) return "gif";
  if (buf[0] === 0x52 && buf[1] === 0x49) return "webp";
  return "png";
}

function saveBuffer(uploadsDir, prefix, buf) {
  const ext = extFromBuffer(buf);
  const filename = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.${ext}`;
  fs.writeFileSync(path.join(uploadsDir, filename), buf);
  return filename;
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
      return saveBuffer(uploadsDir, `ai_icon_${String(symbol).toUpperCase()}`, buf);
    } catch {
      // try next
    }
  }
  return null;
}

async function downloadNewsImage(imageUrl, uploadsDir) {
  try {
    const buf = await downloadImageBuffer(imageUrl, 8000);
    if (!buf || buf.length < 1500) return null;
    return saveBuffer(uploadsDir, "ai_news", buf);
  } catch {
    return null;
  }
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
  }
  return ~c >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** 无依赖生成走势 PNG（深色底 + 涨跌色折线） */
function renderLineChartPng({
  title,
  values,
  width = 800,
  height = 450,
  upColor = [14, 203, 129],
  downColor = [246, 70, 93],
} = {}) {
  const pts = (values || []).map(Number).filter((n) => Number.isFinite(n));
  if (pts.length < 2) return null;

  const first = pts[0];
  const last = pts[pts.length - 1];
  const up = last >= first;
  const line = up ? upColor : downColor;
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const span = max - min || 1;

  const padL = 56;
  const padR = 24;
  const padT = 52;
  const padB = 36;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const pixels = Buffer.alloc(width * height * 4);
  const setPx = (x, y, r, g, b, a = 255) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 4;
    pixels[i] = r;
    pixels[i + 1] = g;
    pixels[i + 2] = b;
    pixels[i + 3] = a;
  };
  const blend = (x, y, r, g, b, a = 255) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 4;
    const aa = a / 255;
    pixels[i] = Math.round(pixels[i] * (1 - aa) + r * aa);
    pixels[i + 1] = Math.round(pixels[i + 1] * (1 - aa) + g * aa);
    pixels[i + 2] = Math.round(pixels[i + 2] * (1 - aa) + b * aa);
    pixels[i + 3] = 255;
  };

  // background
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) setPx(x, y, 18, 22, 28);
  }
  // panel
  for (let y = padT - 8; y < height - padB + 8; y++) {
    for (let x = padL - 8; x < width - padR + 8; x++) setPx(x, y, 24, 30, 38);
  }

  // grid
  for (let g = 0; g <= 4; g++) {
    const y = padT + Math.round((plotH * g) / 4);
    for (let x = padL; x < padL + plotW; x++) blend(x, y, 55, 65, 80, 90);
  }

  const toXY = (idx, val) => {
    const x = padL + Math.round((idx / (pts.length - 1)) * plotW);
    const y = padT + Math.round(((max - val) / span) * plotH);
    return [x, y];
  };

  // filled area under line
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = toXY(i, pts[i]);
    const [x1, y1] = toXY(i + 1, pts[i + 1]);
    const xStart = Math.min(x0, x1);
    const xEnd = Math.max(x0, x1);
    for (let x = xStart; x <= xEnd; x++) {
      const t = xEnd === xStart ? 0 : (x - x0) / (x1 - x0 || 1);
      const yLine = Math.round(y0 + (y1 - y0) * t);
      for (let y = yLine; y < padT + plotH; y++) {
        blend(x, y, line[0], line[1], line[2], 28);
      }
    }
  }

  // line
  const drawLine = (x0, y0, x1, y1) => {
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    let x = x0;
    let y = y0;
    while (true) {
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          const a = ox === 0 && oy === 0 ? 255 : 110;
          blend(x + ox, y + oy, line[0], line[1], line[2], a);
        }
      }
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) {
        err -= dy;
        x += sx;
      }
      if (e2 < dx) {
        err += dx;
        y += sy;
      }
    }
  };
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = toXY(i, pts[i]);
    const [x1, y1] = toXY(i + 1, pts[i + 1]);
    drawLine(x0, y0, x1, y1);
  }

  // title bar text as simple pixel glyphs (ASCII/常见数字)
  drawSimpleText(pixels, width, height, 24, 22, String(title || "Chart").slice(0, 42), [240, 185, 11]);
  const chg = (((last - first) / first) * 100).toFixed(2);
  const chgLabel = `${last >= first ? "+" : ""}${chg}%`;
  drawSimpleText(pixels, width, height, 24, 40, chgLabel, line);

  // price labels
  drawSimpleText(pixels, width, height, 8, padT - 2, formatPriceLabel(max), [160, 170, 185]);
  drawSimpleText(pixels, width, height, 8, padT + plotH - 10, formatPriceLabel(min), [160, 170, 185]);

  // pack PNG
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    pixels.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const compressed = zlib.deflateSync(raw);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function formatPriceLabel(n) {
  if (!Number.isFinite(n)) return "";
  if (n >= 1000) return n.toFixed(0);
  if (n >= 1) return n.toFixed(2);
  return n.toPrecision(4);
}

/** 极简 5x7 点阵，够画标题/涨跌幅 */
const GLYPHS = {
  " ": [0, 0, 0, 0, 0],
  "+": [0x04, 0x04, 0x1f, 0x04, 0x04],
  "-": [0x00, 0x00, 0x1f, 0x00, 0x00],
  ".": [0x00, 0x00, 0x00, 0x00, 0x04],
  "%": [0x19, 0x1a, 0x04, 0x0b, 0x13],
  "/": [0x01, 0x02, 0x04, 0x08, 0x10],
  "0": [0x0e, 0x11, 0x13, 0x15, 0x0e],
  "1": [0x04, 0x0c, 0x04, 0x04, 0x0e],
  "2": [0x0e, 0x11, 0x02, 0x08, 0x1f],
  "3": [0x1e, 0x01, 0x0e, 0x01, 0x1e],
  "4": [0x02, 0x06, 0x0a, 0x1f, 0x02],
  "5": [0x1f, 0x10, 0x1e, 0x01, 0x1e],
  "6": [0x06, 0x08, 0x1e, 0x11, 0x0e],
  "7": [0x1f, 0x01, 0x02, 0x04, 0x08],
  "8": [0x0e, 0x11, 0x0e, 0x11, 0x0e],
  "9": [0x0e, 0x11, 0x0f, 0x01, 0x0c],
  A: [0x0e, 0x11, 0x1f, 0x11, 0x11],
  B: [0x1e, 0x11, 0x1e, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x11, 0x0e],
  D: [0x1e, 0x11, 0x11, 0x11, 0x1e],
  E: [0x1f, 0x10, 0x1e, 0x10, 0x1f],
  F: [0x1f, 0x10, 0x1e, 0x10, 0x10],
  G: [0x0e, 0x10, 0x13, 0x11, 0x0e],
  H: [0x11, 0x11, 0x1f, 0x11, 0x11],
  I: [0x0e, 0x04, 0x04, 0x04, 0x0e],
  K: [0x11, 0x12, 0x1c, 0x12, 0x11],
  L: [0x10, 0x10, 0x10, 0x10, 0x1f],
  N: [0x11, 0x19, 0x15, 0x13, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x0e],
  P: [0x1e, 0x11, 0x1e, 0x10, 0x10],
  R: [0x1e, 0x11, 0x1e, 0x12, 0x11],
  S: [0x0f, 0x10, 0x0e, 0x01, 0x1e],
  T: [0x1f, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x0e],
  X: [0x11, 0x0a, 0x04, 0x0a, 0x11],
  Y: [0x11, 0x0a, 0x04, 0x04, 0x04],
  h: [0x10, 0x10, 0x1e, 0x11, 0x11],
};

function drawSimpleText(pixels, width, height, startX, startY, text, rgb) {
  let x = startX;
  const scale = 2;
  for (const ch of String(text).toUpperCase()) {
    const glyph = GLYPHS[ch] || GLYPHS[" "] || [0, 0, 0, 0, 0];
    for (let row = 0; row < 5; row++) {
      const bits = glyph[row];
      for (let col = 0; col < 5; col++) {
        if (!(bits & (0x10 >> col))) continue;
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            const px = x + col * scale + sx;
            const py = startY + row * scale + sy;
            if (px < 0 || py < 0 || px >= width || py >= height) continue;
            const i = (py * width + px) * 4;
            pixels[i] = rgb[0];
            pixels[i + 1] = rgb[1];
            pixels[i + 2] = rgb[2];
            pixels[i + 3] = 255;
          }
        }
      }
    }
    x += 6 * scale;
  }
}

async function fetchClosePrices(symbol) {
  const pair = `${String(symbol || "").toUpperCase()}USDT`;
  const attempts = KLINE_URLS.map(async (build) => {
    const data = await fetchJsonBuffer(build(pair, "1h", 48));
    if (!Array.isArray(data) || data.length < 5) throw new Error("empty");
    const closes = data.map((row) => Number(row[4])).filter((n) => Number.isFinite(n) && n > 0);
    if (closes.length < 5) throw new Error("short");
    return closes;
  });
  try {
    return await Promise.any(attempts);
  } catch {
    return null;
  }
}

async function renderTokenChart(symbol, uploadsDir) {
  const closes = await fetchClosePrices(symbol);
  if (!closes?.length) return null;
  const sym = String(symbol).toUpperCase();
  // 本地绘制更快更稳，避免等 QuickChart（跨境经常卡住十几秒）
  const buf = renderLineChartPng({
    title: `${sym}/USDT 48h`,
    values: closes,
  });
  if (!buf) return null;
  return saveBuffer(uploadsDir, `ai_chart_${sym}`, buf);
}

/**
 * @param {{
 *   focusTokens?: string[],
 *   uploadsDir: string,
 *   maxImages?: number,
 *   newsImageUrl?: string,
 *   preferLogos?: boolean,
 * }} options
 * @returns {Promise<string[]>} 上传目录内相对文件名
 */
export async function prepareRelatedPostImages({
  focusTokens = [],
  uploadsDir,
  maxImages = MAX_IMAGES,
  newsImageUrl = "",
  preferLogos = false,
} = {}) {
  if (!uploadsDir) return [];
  fs.mkdirSync(uploadsDir, { recursive: true });

  const tokens = [...new Set((focusTokens || []).map((s) => String(s || "").toUpperCase()).filter(Boolean))];
  const limit = Math.max(1, Math.min(Number(maxImages) || MAX_IMAGES, 4));
  const paths = [];

  const newsTask = newsImageUrl ? downloadNewsImage(newsImageUrl, uploadsDir) : Promise.resolve(null);
  const chartTasks = tokens.slice(0, limit).map((symbol) => renderTokenChart(symbol, uploadsDir));
  const [newsPath, ...chartPaths] = await Promise.all([newsTask, ...chartTasks]);

  if (newsPath) paths.push(newsPath);
  for (const chart of chartPaths) {
    if (paths.length >= limit) break;
    if (chart) paths.push(chart);
  }

  // 仅在完全失败时兜底图标（默认不主动贴 Logo）
  if (!paths.length || preferLogos) {
    const iconResults = await Promise.all(
      tokens.slice(0, limit).map((symbol) => downloadTokenIcon(symbol, uploadsDir)),
    );
    for (const icon of iconResults) {
      if (paths.length >= limit) break;
      if (icon) paths.push(icon);
    }
  }

  return paths.slice(0, limit);
}
