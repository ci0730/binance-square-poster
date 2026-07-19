/**
 * AI 发帖配图：
 * 1) 优先新闻配图（RSS 封面）
 * 2) 再截代币行情图（币安交易页 / Coinglass），不截 CMC 资料预览页
 * 都失败则不配图。
 */
import fs from "fs";
import path from "path";
import { getProxyUrl } from "./square-api.js";
import { transportFetch } from "./http-transport.js";
import { captureRelatedSiteScreenshots } from "./site-screenshots.js";

const MAX_IMAGES = 2;

async function downloadImageBuffer(url, timeoutMs = 10000, redirectLeft = 3) {
  if (!url || !/^https?:\/\//i.test(url) || redirectLeft < 0) return null;
  try {
    const res = await transportFetch(url, {
      method: "GET",
      headers: {
        "User-Agent": "binance-square-poster/1.0",
        Accept: "image/*,application/json,*/*",
      },
      proxyUrl: getProxyUrl() || "",
      timeoutMs,
      retries: false,
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers?.location || res.headers?.Location;
      if (!location) return null;
      return downloadImageBuffer(new URL(location, url).toString(), timeoutMs, redirectLeft - 1);
    }
    if (res.status !== 200) return null;
    const buffer = await res.buffer();
    if (!buffer?.length || buffer.length < 200) return null;
    const ct = String(res.headers?.["content-type"] || res.headers?.["Content-Type"] || "").toLowerCase();
    if (ct && !ct.includes("image") && !ct.includes("octet-stream") && !ct.includes("json")) return null;
    const head = buffer.slice(0, 32).toString("utf8").toLowerCase();
    if (head.includes("<!doctype") || head.includes("<html")) return null;
    return buffer;
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

/**
 * @param {{
 *   focusTokens?: string[],
 *   uploadsDir: string,
 *   maxImages?: number,
 *   newsImageUrl?: string,
 *   preferLogos?: boolean,
 *   enableSiteScreenshots?: boolean,
 * }} options
 * @returns {Promise<string[]>} 上传目录内相对文件名
 */
export async function prepareRelatedPostImages({
  focusTokens = [],
  uploadsDir,
  maxImages = MAX_IMAGES,
  newsImageUrl = "",
  preferLogos = false,
  enableSiteScreenshots = true,
} = {}) {
  if (!uploadsDir) return [];
  fs.mkdirSync(uploadsDir, { recursive: true });

  const tokens = [...new Set((focusTokens || []).map((s) => String(s || "").toUpperCase()).filter(Boolean))];
  const limit = Math.max(1, Math.min(Number(maxImages) || MAX_IMAGES, 4));
  const paths = [];

  // 新闻图 + 网站截图并行；全部失败则返回空（不画本地 K 线）
  const newsTask = newsImageUrl ? downloadNewsImage(newsImageUrl, uploadsDir) : Promise.resolve(null);
  const shotSlots = enableSiteScreenshots !== false && tokens.length ? Math.min(1, limit) : 0;
  const shotTask =
    shotSlots > 0
      ? captureRelatedSiteScreenshots({
          focusTokens: tokens.slice(0, shotSlots),
          uploadsDir,
          maxImages: shotSlots,
          timeoutMs: 26000,
        }).catch(() => [])
      : Promise.resolve([]);

  const [newsPath, shotPaths] = await Promise.all([newsTask, shotTask]);
  if (newsPath) paths.push(newsPath);
  for (const shot of shotPaths || []) {
    if (paths.length >= limit) break;
    if (shot) paths.push(shot);
  }

  // 仅显式 preferLogos 时才贴图标；默认截图失败就纯文字发帖
  if (preferLogos) {
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
