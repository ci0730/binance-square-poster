/**
 * 币圈网站截图：给自动配图补充 CoinMarketCap / Coinglass / Binance 等页面画面。
 * 失败时静默返回空，由调用方回退到不配图。
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";
import { getBrowserPath, getProxyUrl } from "./square-api.js";
import { toPlaywrightProxy } from "./proxy-config.js";

const SCREENSHOT_CACHE_MS = 5 * 60 * 1000;
const screenshotCache = new Map();
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(MODULE_DIR, "..");

export function clearScreenshotMemoryCache() {
  screenshotCache.clear();
}

const HEADLESS_ARGS = [
  "--headless=new",
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--disable-blink-features=AutomationControlled",
  "--disable-gpu",
  "--hide-scrollbars",
  "--mute-audio",
  "--window-size=1280,800",
];

function findChromeInPlaywrightDir(browsersDir) {
  if (!browsersDir || !fs.existsSync(browsersDir)) return null;
  try {
    const entries = fs.readdirSync(browsersDir);
    const preferred = [
      ...entries.filter((n) => /^chromium-\d+$/i.test(n)),
      ...entries.filter((n) => /^chromium_headless_shell-\d+$/i.test(n)),
    ];
    for (const name of preferred) {
      const base = path.join(browsersDir, name);
      const candidates = [
        path.join(base, "chrome-win64", "chrome.exe"),
        path.join(base, "chrome-win", "chrome.exe"),
        path.join(base, "chrome-headless-shell-win64", "chrome-headless-shell.exe"),
        path.join(base, "chrome-linux", "chrome"),
        path.join(base, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"),
      ];
      for (const file of candidates) {
        if (fs.existsSync(file)) return file;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

function resolveBrowserExecutable() {
  const configured = String(getBrowserPath() || "").trim();
  if (configured && fs.existsSync(configured)) return configured;

  const systemBrowsers = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    path.join(process.env.LOCALAPPDATA || "", "Microsoft", "Edge", "Application", "msedge.exe"),
  ].filter(Boolean);
  for (const file of systemBrowsers) {
    if (fs.existsSync(file)) return file;
  }

  const playwrightDirs = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    process.resourcesPath ? path.join(process.resourcesPath, "ms-playwright") : null,
    path.join(PROJECT_ROOT, "build", "ms-playwright"),
    path.join(process.env.LOCALAPPDATA || "", "ms-playwright"),
  ].filter(Boolean);

  for (const dir of playwrightDirs) {
    const found = findChromeInPlaywrightDir(dir);
    if (found) return found;
  }
  return null;
}

function buildLaunchOptions(proxyUrl) {
  const launchOpts = {
    headless: true,
    args: [...HEADLESS_ARGS],
    ignoreDefaultArgs: ["--enable-automation"],
  };
  const effectiveProxy = proxyUrl !== undefined ? proxyUrl : getProxyUrl();
  if (effectiveProxy) {
    launchOpts.proxy = toPlaywrightProxy(effectiveProxy) || { server: effectiveProxy };
  }
  const executablePath = resolveBrowserExecutable();
  if (executablePath) launchOpts.executablePath = executablePath;
  return launchOpts;
}

/**
 * 代币配图截图目标：只要「行情图」类页面，不要 CMC/CG 资料预览页。
 * 顺序：币安现货 K 线 → Coinglass 图表 → Coinglass 币种页。
 */
export function buildTokenScreenshotTargets(symbol) {
  const sym = String(symbol || "").toUpperCase();
  if (!sym) return [];

  return [
    {
      id: "binance",
      label: "Binance",
      url: `https://www.binance.com/zh-CN/trade/${sym}_USDT?type=spot`,
      waitUntil: "domcontentloaded",
      settleMs: 3200,
      // 截交易区左侧图表为主，少带右侧下单面板噪音
      clip: { x: 0, y: 64, width: 900, height: 720 },
    },
    {
      id: "coinglass-tv",
      label: "Coinglass Chart",
      url: `https://www.coinglass.com/tv/Binance_${sym}USDT`,
      waitUntil: "domcontentloaded",
      settleMs: 2800,
      clip: { x: 0, y: 56, width: 1280, height: 720 },
    },
    {
      id: "coinglass",
      label: "Coinglass",
      url: `https://www.coinglass.com/currencies/${sym}`,
      waitUntil: "domcontentloaded",
      settleMs: 2200,
      clip: { x: 0, y: 72, width: 1280, height: 720 },
    },
  ];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function dismissOverlays(page) {
  const selectors = [
    'button:has-text("Accept")',
    'button:has-text("Accept All")',
    'button:has-text("I Accept")',
    'button:has-text("Agree")',
    'button:has-text("同意")',
    'button:has-text("接受")',
    '[aria-label="Close"]',
    'button[aria-label="close"]',
    ".cmc-cookie-policy-banner button",
  ];
  for (const sel of selectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 400 }).catch(() => false)) {
        await btn.click({ timeout: 800 }).catch(() => {});
      }
    } catch {
      // ignore
    }
  }
}

function savePng(uploadsDir, prefix, buffer) {
  const filename = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.png`;
  fs.writeFileSync(path.join(uploadsDir, filename), buffer);
  return filename;
}

/** 页面是否像「上架预览 / 空壳 / 错误页」——这类截图发到广场会很难看 */
async function isLowQualityTokenPage(page) {
  try {
    const text = String(
      await page.evaluate(() => (document.body?.innerText || "").slice(0, 4000)),
    );
    if (
      /preview page|Listing Review|listing review|上架审核|审核标准|Submit token|Update token info|Claim community badge|页面不存在|Page not found|找不到|404|没有找到|未找到该|token not found|coin not found/i.test(
        text,
      )
    ) {
      return true;
    }
    // 正常行情/交易页通常会有价格或 K 线相关文案
    const hasPrice = /\$\s*[\d,]+|\d+\.\d+\s*USDT|市值|Market Cap|Price|开盘|最高|最低|成交额|24H/i.test(text);
    if (!hasPrice) return true;
    return false;
  } catch {
    return false;
  }
}

async function waitForUsefulContent(page, target) {
  const readySelectors = [
    'text=/\\$[\\d,]+/',
    'text=/Bitcoin|Ethereum|Solana|BNB|Market Cap|市值|价格|USDT/',
    '[data-role="chart"]',
    "canvas",
    "svg",
  ];
  for (const sel of readySelectors) {
    try {
      await page.waitForSelector(sel, { timeout: 5000 });
      break;
    } catch {
      // try next
    }
  }

  try {
    const loading = page.locator("text=/Loading Data|Please wait|加载中/i").first();
    if (await loading.isVisible({ timeout: 300 }).catch(() => false)) {
      await loading.waitFor({ state: "hidden", timeout: 8000 }).catch(() => {});
    }
  } catch {
    // ignore
  }

  if (target.settleMs > 0) {
    await sleep(target.settleMs);
  }
}

async function captureOneTarget(page, target, uploadsDir, symbol) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(target.url, {
    waitUntil: target.waitUntil || "domcontentloaded",
    timeout: 18000,
  });
  await dismissOverlays(page);
  await waitForUsefulContent(page, target);
  await dismissOverlays(page);

  if (await isLowQualityTokenPage(page)) {
    throw new Error(`low-quality page: ${target.id}`);
  }

  const clip = target.clip || { x: 0, y: 0, width: 1280, height: 720 };
  const buf = await page.screenshot({
    type: "png",
    clip,
    animations: "disabled",
    timeout: 8000,
  });
  // 过小的图多半是空白/未渲染完
  if (!buf || buf.length < 20000) return null;
  return savePng(uploadsDir, `ai_shot_${target.id}_${String(symbol).toUpperCase()}`, buf);
}

/**
 * 为代币截取一张币圈网站页面图。
 * @returns {Promise<string|null>} uploads 目录内文件名
 */
export async function captureTokenSiteScreenshot(symbol, uploadsDir, {
  timeoutMs = 28000,
  preferredSites = null,
} = {}) {
  const sym = String(symbol || "").toUpperCase();
  if (!sym || !uploadsDir) return null;

  const cacheKey = `shot:${sym}`;
  const cached = screenshotCache.get(cacheKey);
  if (cached && Date.now() - cached.at < SCREENSHOT_CACHE_MS && cached.file) {
    const full = path.join(uploadsDir, cached.file);
    if (fs.existsSync(full)) return cached.file;
  }

  fs.mkdirSync(uploadsDir, { recursive: true });
  let targets = buildTokenScreenshotTargets(sym);
  if (Array.isArray(preferredSites) && preferredSites.length) {
    const allow = new Set(preferredSites.map((s) => String(s).toLowerCase()));
    targets = targets.filter((t) => allow.has(t.id));
  }
  if (!targets.length) return null;

  let browser = null;
  try {
    browser = await chromium.launch(buildLaunchOptions());
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      locale: "zh-CN",
      javaScriptEnabled: true,
    });
    await context.route("**/*", (route) => {
      const type = route.request().resourceType();
      if (type === "media" || type === "font") {
        route.abort().catch(() => {});
        return;
      }
      route.continue().catch(() => {});
    });

    const page = await context.newPage();
    const deadline = Date.now() + timeoutMs;
    let saved = null;

    for (const target of targets) {
      if (Date.now() >= deadline) break;
      try {
        const remaining = Math.max(4000, deadline - Date.now());
        const file = await Promise.race([
          captureOneTarget(page, target, uploadsDir, sym),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("screenshot timeout")), remaining),
          ),
        ]);
        if (file) {
          saved = file;
          break;
        }
      } catch {
        // 试下一个站点
      }
    }

    await context.close().catch(() => {});
    if (saved) {
      screenshotCache.set(cacheKey, { at: Date.now(), file: saved });
      return saved;
    }
  } catch (err) {
    // 浏览器启动失败等 —— 不打断发帖，调用方会回退本地 K 线
    if (process.env.BSP_DEBUG_SCREENSHOTS === "1") {
      console.warn("[site-screenshots]", String(err?.message || err));
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  return null;
}

/**
 * 为多个代币各尝试一张网站截图（受 maxImages 限制）。
 */
export async function captureRelatedSiteScreenshots({
  focusTokens = [],
  uploadsDir,
  maxImages = 1,
  timeoutMs = 28000,
} = {}) {
  const tokens = [...new Set((focusTokens || []).map((s) => String(s || "").toUpperCase()).filter(Boolean))];
  if (!tokens.length || !uploadsDir) return [];

  const limit = Math.max(1, Math.min(Number(maxImages) || 1, 2));
  const out = [];
  // 串行截图：共用一次浏览器启动成本更高，但多 token 时并行易打爆代理；
  // 这里每个 token 独立短超时，优先保证第一枚成功。
  const perTokenBudget = Math.max(10000, Math.floor(timeoutMs / limit));

  for (const sym of tokens.slice(0, limit)) {
    try {
      const file = await captureTokenSiteScreenshot(sym, uploadsDir, {
        timeoutMs: perTokenBudget,
      });
      if (file) out.push(file);
    } catch {
      // ignore
    }
    if (out.length >= limit) break;
  }
  return out;
}
