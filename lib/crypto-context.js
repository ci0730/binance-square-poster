import { getProxyUrl } from "./square-api.js";
import { transportFetch } from "./http-transport.js";
import { getRecentTokenPairs } from "./ai-settings.js";
import {
  getTokenRegistryEntry,
  getTokenRegistryMap,
  listAllTokenRegistryEntries,
  applySyncedTokenBatch,
} from "./token-registry.js";

const RSS_FEEDS = [
  { name: "Cointelegraph", url: "https://cointelegraph.com/rss" },
  { name: "Decrypt", url: "https://decrypt.co/feed" },
  { name: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/" },
  { name: "The Block", url: "https://www.theblock.co/rss.xml" },
  { name: "CryptoPanic", url: "https://cryptopanic.com/news/rss/" },
];

// 仅主流高热度代币，排除 OP/PEPE 等易被新闻误带的标的
export const MAINSTREAM_POOL = [
  "BTC", "ETH", "BNB", "SOL", "XRP", "DOGE", "ADA", "AVAX", "LINK",
  "DOT", "NEAR", "APT", "TON", "TRX", "SHIB", "MATIC", "LTC", "UNI", "FIL", "BCH",
];

const TOKEN_ALIASES = {
  BTC: ["BTC", "BITCOIN", "比特币"],
  ETH: ["ETH", "ETHEREUM", "以太坊"],
  BNB: ["BNB", "BINANCE COIN"],
  SOL: ["SOL", "SOLANA"],
  XRP: ["XRP", "RIPPLE"],
  DOGE: ["DOGE", "DOGECOIN"],
  ADA: ["ADA", "CARDANO"],
  AVAX: ["AVAX", "AVALANCHE"],
  LINK: ["LINK", "CHAINLINK"],
  DOT: ["DOT", "POLKADOT"],
  NEAR: ["NEAR"],
  APT: ["APT", "APTOS"],
  TON: ["TON"],
  TRX: ["TRX", "TRON"],
  SHIB: ["SHIB", "SHIBA"],
  MATIC: ["MATIC", "POLYGON", "POL"],
  LTC: ["LTC", "LITECOIN"],
  UNI: ["UNI", "UNISWAP"],
  FIL: ["FIL", "FILECOIN"],
  BCH: ["BCH"],
};

function decodeEntities(text) {
  return String(text || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pickTag(block, tag) {
  const cdata = block.match(new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, "i"));
  if (cdata) return decodeEntities(cdata[1]);
  const plain = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return decodeEntities(plain?.[1] || "");
}

function pickRssImageUrl(block) {
  const patterns = [
    /<media:content[^>]+url=["']([^"']+)["']/i,
    /<media:thumbnail[^>]+url=["']([^"']+)["']/i,
    /<enclosure[^>]+url=["']([^"']+)["'][^>]*(?:type=["']image\/[^"']*["'])?/i,
    /url=["'](https?:\/\/[^"']+\.(?:jpg|jpeg|png|webp|gif)(?:\?[^"']*)?)["']/i,
  ];
  for (const re of patterns) {
    const m = block.match(re);
    if (m?.[1] && /^https?:\/\//i.test(m[1])) return decodeEntities(m[1].trim());
  }
  const desc = pickTag(block, "description") || pickTag(block, "content:encoded") || "";
  const img = desc.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (img?.[1] && /^https?:\/\//i.test(img[1])) return decodeEntities(img[1].trim());
  return "";
}

function parseRss(xml, limit = 8) {
  const items = [];
  const blocks = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  for (const block of blocks) {
    if (items.length >= limit) break;
    const title = pickTag(block, "title");
    if (!title) continue;
    const rawDesc = pickTag(block, "description");
    items.push({
      title,
      summary: rawDesc.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 220),
      source: pickTag(block, "source") || "",
      publishedAt: pickTag(block, "pubDate") || "",
      imageUrl: pickRssImageUrl(block),
      link: pickTag(block, "link") || "",
    });
  }
  return items;
}

let cryptoNewsCache = { at: 0, articles: [], errors: [] };
const CRYPTO_NEWS_CACHE_MS = 2 * 60 * 1000;
let cryptoNewsInflight = null;

export function getRuntimeCacheStats() {
  const news = cryptoNewsCache.articles?.length || 0;
  const spot = spotTickerCache.byPair?.size || 0;
  const futures = futuresTickerCache.byPair?.size || 0;
  const alpha = alphaTokenCache.map?.size || 0;
  const funding = hotFundingCache.tokens?.length || 0;
  const parts = [];
  if (news) parts.push(`资讯 ${news}`);
  if (spot) parts.push(`现货 ${spot}`);
  if (futures) parts.push(`合约 ${futures}`);
  if (alpha) parts.push(`Alpha ${alpha}`);
  if (funding) parts.push(`费率热榜 ${funding}`);
  return {
    news,
    spot,
    futures,
    alpha,
    funding,
    detail: parts.length ? parts.join(" · ") : "当前为空",
  };
}

export function clearMarketAndNewsCaches() {
  cryptoNewsCache = { at: 0, articles: [], errors: [] };
  cryptoNewsInflight = null;
  alphaTokenCache = { at: 0, map: new Map(), byAddress: new Map() };
  spotTickerCache = { at: 0, byPair: new Map() };
  futuresTickerCache = { at: 0, byPair: new Map() };
  hotFundingCache = { at: 0, tokens: [] };
}

export async function fetchCryptoNews({ limit = 6 } = {}) {
  const want = Math.max(1, Math.min(20, Number(limit) || 6));
  if (
    Date.now() - cryptoNewsCache.at < CRYPTO_NEWS_CACHE_MS &&
    cryptoNewsCache.articles.length
  ) {
    return {
      articles: cryptoNewsCache.articles.slice(0, want),
      errors: cryptoNewsCache.errors,
      cached: true,
    };
  }
  if (cryptoNewsInflight) {
    const shared = await cryptoNewsInflight;
    return {
      articles: (shared.articles || []).slice(0, want),
      errors: shared.errors || [],
      cached: true,
    };
  }

  cryptoNewsInflight = (async () => {
    const articles = [];
    const errors = [];

    // 缩短超时：资讯辅助写帖，拖太久不如跳过
    const results = await Promise.all(
      RSS_FEEDS.map(async (feed) => {
        try {
          const res = await transportFetch(feed.url, {
            method: "GET",
            headers: { "User-Agent": "binance-square-poster/1.0", Accept: "application/rss+xml,application/xml,text/xml,*/*" },
            proxyUrl: getProxyUrl() || "",
            timeoutMs: 5000,
            retries: false,
          });
          if (res.status !== 200) return { error: `${feed.name}: HTTP ${res.status}`, items: [] };
          const text = await res.text();
          return {
            error: null,
            items: parseRss(text, 12).map((item) => ({
              ...item,
              source: item.source || feed.name,
            })),
          };
        } catch (err) {
          return { error: `${feed.name}: ${err.message}`, items: [] };
        }
      }),
    );
    for (const row of results) {
      if (row.error) errors.push(row.error);
      articles.push(...row.items);
    }

    const seen = new Set();
    const unique = [];
    for (const item of articles) {
      const key = item.title.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(item);
      if (unique.length >= 12) break;
    }

    cryptoNewsCache = { at: Date.now(), articles: unique, errors };
    return { articles: unique, errors };
  })().finally(() => {
    cryptoNewsInflight = null;
  });

  const fresh = await cryptoNewsInflight;
  return {
    articles: (fresh.articles || []).slice(0, want),
    errors: fresh.errors || [],
    cached: false,
  };
}

function isMainstream(symbol) {
  return MAINSTREAM_POOL.includes(symbol);
}

export function normalizeTokenSymbol(raw = "") {
  const symbol = String(raw).replace(/^\$/, "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (symbol.length < 2 || symbol.length > 10) return "";
  return symbol;
}

export function normalizeUserTokens(tokens = []) {
  return [...new Set(tokens.map(normalizeTokenSymbol).filter(Boolean))];
}

/** 托管代币模式：fixed=指定列表；auto=新闻轮换主流；random_all=每次从币安 USDT 全市场随机 */
export const TOKEN_MODE_FIXED = "fixed";
export const TOKEN_MODE_AUTO = "auto";
export const TOKEN_MODE_RANDOM_ALL = "random_all";

export function normalizeTokenMode(raw, selectedTokens = []) {
  const mode = String(raw || "").trim();
  if (mode === TOKEN_MODE_RANDOM_ALL) return TOKEN_MODE_RANDOM_ALL;
  if (mode === TOKEN_MODE_AUTO) return TOKEN_MODE_AUTO;
  if (mode === TOKEN_MODE_FIXED) return TOKEN_MODE_FIXED;
  return normalizeUserTokens(selectedTokens).length ? TOKEN_MODE_FIXED : TOKEN_MODE_AUTO;
}

const STABLE_OR_FIAT_SKIP = new Set([
  "USDT", "USDC", "BUSD", "FDUSD", "TUSD", "DAI", "USDE", "USD1", "USDP", "USDD",
  "EUR", "AEUR", "EURI", "GBP", "TRY", "BRL", "ARS", "UAH", "ZAR", "PLN",
]);

function isExcludedFromRandomAllPool(symbol) {
  const s = normalizeTokenSymbol(symbol);
  if (!s || s.length < 2) return true;
  if (STABLE_OR_FIAT_SKIP.has(s)) return true;
  // 杠杆代币 / 3x 等
  if (/(UP|DOWN|BULL|BEAR)$/i.test(s)) return true;
  if (/^\d/.test(s) && /(LONG|SHORT|UP|DOWN)$/i.test(s)) return true;
  return false;
}

/**
 * 从软件内「代币地址列表」取随机池（本地，不联网）。
 * 排除稳定币/杠杆币；列表过少时回退主流币。
 */
export function getRandomAllTokenPoolFromRegistry() {
  const seen = new Set();
  const symbols = [];
  for (const item of listAllTokenRegistryEntries()) {
    if (item?.enabled === false) continue;
    const symbol = normalizeTokenSymbol(item.symbol);
    if (!symbol || seen.has(symbol) || isExcludedFromRandomAllPool(symbol)) continue;
    seen.add(symbol);
    symbols.push(symbol);
  }
  if (symbols.length >= 2) return symbols;
  return [...MAINSTREAM_POOL];
}

/** 每次发文从软件内代币列表随机抽 2 个（不拉币安接口，避免网络失败） */
export async function pickRandomAllBinanceTokenPair({ recentPairs = [] } = {}) {
  const pool = getRandomAllTokenPoolFromRegistry();
  if (pool.length < 2) return ["BTC", "ETH"];

  // 合并历史 + 本轮其它账号已抽过的组合，避免多账户并行抽到同一对
  const mergedRecent = [
    ...(Array.isArray(recentPairs) ? recentPairs : []),
    ...(randomAllSessionActive ? randomAllSessionPairs : []),
  ];
  const recentTokens = new Set(
    mergedRecent.flat().map(normalizeTokenSymbol).filter(Boolean),
  );
  const usedPairKeys = new Set(
    mergedRecent
      .map((p) =>
        Array.isArray(p) && p.length >= 2
          ? [normalizeTokenSymbol(p[0]), normalizeTokenSymbol(p[1])].filter(Boolean).sort().join(",")
          : "",
      )
      .filter(Boolean),
  );

  const fresh = pool.filter((s) => !recentTokens.has(s));
  const primaryPool = fresh.length >= 8 ? fresh : pool;
  const primary = primaryPool[Math.floor(Math.random() * primaryPool.length)];

  const secondaryPool = pool.filter((s) => s !== primary);
  let secondary =
    secondaryPool[Math.floor(Math.random() * secondaryPool.length)] || primary;

  for (let i = 0; i < 16; i += 1) {
    const key = [primary, secondary].sort().join(",");
    if (!usedPairKeys.has(key) || secondaryPool.length < 2) break;
    secondary = secondaryPool[Math.floor(Math.random() * secondaryPool.length)];
  }

  // 同步记入本轮会话（无 await 间隙，并行调用也安全）
  if (randomAllSessionActive) {
    randomAllSessionPairs.push([primary, secondary]);
    if (randomAllSessionPairs.length > 48) {
      randomAllSessionPairs = randomAllSessionPairs.slice(-48);
    }
  }

  return [primary, secondary];
}

export function splitPresetAndCustomTokens(tokens = [], preset = MAINSTREAM_POOL) {
  const normalized = normalizeUserTokens(tokens);
  const presetSet = new Set(preset);
  const selected = [];
  const custom = [];
  for (const symbol of normalized) {
    if (presetSet.has(symbol)) selected.push(symbol);
    else custom.push(symbol);
  }
  return { selected, custom };
}

function detectTokensInText(text) {
  const upper = String(text || "").toUpperCase();
  const found = [];
  for (const [symbol, aliases] of Object.entries(TOKEN_ALIASES)) {
    if (!isMainstream(symbol)) continue;
    if (aliases.some((alias) => upper.includes(alias))) found.push(symbol);
  }
  const cashtags = [...upper.matchAll(/\$([A-Z]{2,10})\b/g)].map((m) => m[1]);
  for (const tag of cashtags) {
    if (!found.includes(tag) && isMainstream(tag)) found.push(tag);
  }
  return found;
}

function pairKey(a, b) {
  return [a, b].sort().join(",");
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function pickLeastUsed(candidates, recentTokens) {
  // 未近期出现的优先；同组内 Fisher–Yates 打乱（避免 Math.random 比较器偏差）
  const unused = [];
  const used = [];
  for (const symbol of candidates) {
    if (recentTokens.has(symbol)) used.push(symbol);
    else unused.push(symbol);
  }
  return [...shuffleInPlace(unused), ...shuffleInPlace(used)];
}

export function pickFocusTokens({ articles = [], preferred = [], recentPairs = [] } = {}) {
  const recentTokens = new Set(recentPairs.flat());
  const usedPairKeys = new Set(recentPairs.map((p) => pairKey(p[0], p[1])));

  const scores = new Map();
  const bump = (symbol, weight = 1) => {
    if (!isMainstream(symbol)) return;
    scores.set(symbol, (scores.get(symbol) || 0) + weight);
  };

  for (const symbol of preferred) bump(symbol, 3);
  for (const article of articles) {
    detectTokensInText(`${article.title} ${article.summary}`).forEach((symbol) => bump(symbol, 2));
  }

  let candidates = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([symbol]) => symbol);

  if (!candidates.length) candidates = [...MAINSTREAM_POOL];
  candidates = pickLeastUsed(candidates, recentTokens);

  const primary = candidates[0] || "BTC";
  const secondaryCandidates = pickLeastUsed(
    MAINSTREAM_POOL.filter((s) => s !== primary),
    recentTokens,
  );

  let secondary =
    secondaryCandidates.find((s) => !usedPairKeys.has(pairKey(primary, s))) ||
    secondaryCandidates[0] ||
    (primary === "BTC" ? "ETH" : "BTC");

  return [primary, secondary];
}

export async function fetchMarketTickers(symbols = []) {
  const normalized = normalizeUserTokens(symbols);
  if (!normalized.length) return { tickers: [], missing: [] };

  const results = await Promise.all(normalized.map(async (symbol) => ({ symbol, quote: await fetchTokenQuote(symbol) })));
  const tickers = [];
  const missing = [];
  for (const row of results) {
    if (row.quote) tickers.push(row.quote);
    else missing.push(row.symbol);
  }
  return { tickers, missing };
}

let alphaTokenCache = { at: 0, map: new Map(), byAddress: new Map() };
const ALPHA_CACHE_MS = 5 * 60 * 1000;
const ALPHA_TOKEN_LIST_URL =
  "https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/cex/alpha/all/token/list";

async function fetchJson(url, timeoutMs = 15000) {
  try {
    const res = await transportFetch(url, {
      method: "GET",
      headers: { "User-Agent": "binance-square-poster/1.0", Accept: "application/json" },
      proxyUrl: getProxyUrl() || "",
      timeoutMs,
      retries: false,
    });
    if (res.status !== 200) return null;
    const text = await res.text();
    return JSON.parse(text);
  } catch {
    return null;
  }
}

let spotTickerCache = { at: 0, byPair: new Map() };
/** 多账户并行写稿时共用，避免每人冷启动各打一遍全市场 24hr */
const SPOT_TICKER_CACHE_MS = 3 * 60 * 1000;
let spotTickerInflight = null;
/** 轻量公开行情域名，比完整 exchangeInfo（约 17MB）快很多 */
const TICKER_PRICE_URLS = [
  "https://data-api.binance.vision/api/v3/ticker/price",
  "https://api.binance.com/api/v3/ticker/price",
];
const TICKER_24HR_URLS = [
  "https://data-api.binance.vision/api/v3/ticker/24hr",
  "https://api.binance.com/api/v3/ticker/24hr",
];
const NETWORK_COIN_URL =
  "https://www.binance.com/bapi/capital/v1/public/capital/getNetworkCoinAll";

async function fetchJsonFirstOk(urls, timeoutMs = 45000) {
  for (const url of urls) {
    const json = await fetchJson(url, timeoutMs);
    if (json != null) return json;
  }
  throw new Error("币安公开 API 请求失败，请检查网络或代理");
}

const FUTURES_PREMIUM_INDEX_URLS = [
  "https://fapi.binance.com/fapi/v1/premiumIndex",
  "https://fapi.binance.vision/fapi/v1/premiumIndex",
];
const FUTURES_TICKER_24HR_URLS = [
  "https://fapi.binance.com/fapi/v1/ticker/24hr",
  "https://fapi.binance.vision/fapi/v1/ticker/24hr",
];
const FUTURES_TICKER_SYMBOL_URLS = (pair) => [
  `https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=${pair}`,
  `https://fapi.binance.vision/fapi/v1/ticker/24hr?symbol=${pair}`,
];

let futuresTickerCache = { at: 0, byPair: new Map() };
const FUTURES_TICKER_CACHE_MS = 3 * 60 * 1000;
let futuresTickerInflight = null;

let hotFundingCache = { at: 0, tokens: [] };
const HOT_FUNDING_CACHE_MS = 60 * 1000;

/** 同轮托管内：随机代币去重（内存，不写盘） */
let randomAllSessionActive = false;
let randomAllSessionPairs = [];

export function beginRandomAllTokenSession() {
  randomAllSessionActive = true;
  randomAllSessionPairs = [];
}

export function endRandomAllTokenSession() {
  randomAllSessionActive = false;
  randomAllSessionPairs = [];
}

/**
 * 多账户开跑前预热现货/合约/Alpha 行情表，后续各账号直接读缓存。
 */
export async function warmupMarketTickerCaches() {
  await Promise.all([
    fetchAllSpot24hrMap(false).catch(() => null),
    ensureFuturesTickerCache().catch(() => null),
    fetchAlphaTokenMaps().catch(() => null),
  ]);
}

/**
 * 币安 U 本位永续：资金费负向最高（空头热度/轧空题材常用）的热点代币
 */
export async function fetchHotNegativeFundingTokens({
  limit = 24,
  minNegativeRate = -0.00003,
  force = false,
} = {}) {
  if (
    !force &&
    Date.now() - hotFundingCache.at < HOT_FUNDING_CACHE_MS &&
    hotFundingCache.tokens.length
  ) {
    return {
      tokens: hotFundingCache.tokens.slice(0, limit),
      fetchedAt: hotFundingCache.at,
      cached: true,
    };
  }

  let rows = null;
  let lastError = null;
  for (const url of FUTURES_PREMIUM_INDEX_URLS) {
    try {
      const json = await fetchJson(url, 25000);
      if (Array.isArray(json) && json.length) {
        rows = json;
        break;
      }
    } catch (err) {
      lastError = err;
    }
  }
  if (!rows?.length) {
    throw new Error(lastError?.message || "无法获取币安合约资金费率");
  }

  const scored = [];
  for (const item of rows) {
    const pair = String(item?.symbol || "").toUpperCase();
    if (!pair.endsWith("USDT")) continue;
    if (pair.includes("_")) continue;
    const rate = Number(item.lastFundingRate);
    if (!Number.isFinite(rate) || rate >= minNegativeRate) continue;
    const symbol = normalizeTokenSymbol(pair.slice(0, -4));
    if (!symbol || symbol.length < 2) continue;
    scored.push({
      symbol,
      binanceSymbol: pair,
      fundingRate: rate,
      fundingRatePercent: Number((rate * 100).toFixed(4)),
      markPrice: item.markPrice != null ? String(item.markPrice) : "",
      nextFundingTime: Number(item.nextFundingTime) || 0,
      reason: "负资金费率",
    });
  }

  scored.sort((a, b) => a.fundingRate - b.fundingRate);
  const seen = new Set();
  const tokens = [];
  for (const row of scored) {
    if (seen.has(row.symbol)) continue;
    seen.add(row.symbol);
    tokens.push(row);
    if (tokens.length >= Math.max(1, Math.min(40, limit))) break;
  }

  hotFundingCache = { at: Date.now(), tokens };
  return { tokens, fetchedAt: hotFundingCache.at, cached: false };
}

async function fetchAllSpot24hrMap(force = false) {
  if (
    !force &&
    Date.now() - spotTickerCache.at < SPOT_TICKER_CACHE_MS &&
    spotTickerCache.byPair.size
  ) {
    return spotTickerCache.byPair;
  }
  if (!force && spotTickerInflight) return spotTickerInflight;

  const task = (async () => {
    const json = await fetchJsonFirstOk(TICKER_24HR_URLS, 60000);
    const byPair = new Map();
    if (Array.isArray(json)) {
      for (const item of json) {
        const pair = String(item?.symbol || "").toUpperCase();
        if (pair) byPair.set(pair, item);
      }
    }
    spotTickerCache = { at: Date.now(), byPair };
    return byPair;
  })();

  if (!force) {
    spotTickerInflight = task.finally(() => {
      if (spotTickerInflight === task) spotTickerInflight = null;
    });
    return spotTickerInflight;
  }
  return task;
}

function pickNetworkContract(networkList = [], symbol = "") {
  const withAddr = (networkList || []).filter((n) => String(n?.contractAddress || "").trim());
  if (!withAddr.length) return { address: "", network: "" };
  const sym = String(symbol || "").toUpperCase();
  const preferred =
    withAddr.find((n) => n.isDefault) ||
    withAddr.find((n) => String(n.network || "").toUpperCase() === sym) ||
    withAddr.find((n) => /^(BSC|BEP20)$/i.test(String(n.network || ""))) ||
    withAddr.find((n) => /^(ETH|ERC20)$/i.test(String(n.network || ""))) ||
    withAddr.find((n) => /^(MATIC|ARB|BASE|OP|AVAXC|SOL)$/i.test(String(n.network || ""))) ||
    withAddr[0];
  return {
    address: String(preferred.contractAddress || "").trim(),
    network: String(preferred.network || preferred.networkDisplay || "").trim(),
  };
}

async function fetchSpotContractMap() {
  const json = await fetchJson(NETWORK_COIN_URL, 60000);
  const map = new Map();
  for (const coin of json?.data || []) {
    const symbol = normalizeTokenSymbol(coin?.coin);
    if (!symbol) continue;
    const picked = pickNetworkContract(coin.networkList || [], symbol);
    if (!picked.address) continue;
    map.set(symbol, {
      address: picked.address,
      network: picked.network,
      name: String(coin?.name || symbol).trim() || symbol,
    });
  }
  return map;
}

/**
 * 从币安公开接口同步：现货 USDT + 充提网络合约 + Alpha + U 本位合约（含 TradFi，如 STXX）。
 * 合约地址：仅覆盖未标记「用户修改」的条目。
 */
export async function syncBinanceTokenRegistry() {
  const prices = await fetchJsonFirstOk(TICKER_PRICE_URLS, 45000);
  if (!Array.isArray(prices) || !prices.length) {
    throw new Error("无法获取币安交易对列表（ticker/price），请检查网络或代理");
  }

  const synced = [];
  const seen = new Set();
  const bySymbol = new Map();

  for (const item of prices) {
    const pair = String(item?.symbol || "").toUpperCase();
    if (!pair.endsWith("USDT")) continue;
    // 排除杠杆代币等怪异后缀可按需扩展；先取全部 USDT
    const symbol = normalizeTokenSymbol(pair.slice(0, -4));
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    const row = {
      symbol,
      name: symbol,
      binanceSymbol: pair,
      contractAddress: "",
      contractNetwork: "",
      listingType: "spot",
      chain: "binance-spot",
      source: "auto",
      enabled: true,
    };
    synced.push(row);
    bySymbol.set(symbol, row);
  }

  let networkContracts = 0;
  try {
    const contractMap = await fetchSpotContractMap();
    for (const [symbol, info] of contractMap.entries()) {
      const row = bySymbol.get(symbol);
      if (row) {
        if (!row.contractAddress) {
          row.contractAddress = info.address;
          row.contractNetwork = info.network;
          if (info.name && info.name !== symbol) row.name = info.name;
          networkContracts += 1;
        }
      } else {
        // 充提列表里有、但当前无 USDT 现货对的，仍收录（标记现货资产）
        seen.add(symbol);
        const created = {
          symbol,
          name: info.name || symbol,
          binanceSymbol: `${symbol}USDT`,
          contractAddress: info.address,
          contractNetwork: info.network,
          listingType: "spot",
          chain: "binance-spot",
          source: "auto",
          enabled: true,
        };
        synced.push(created);
        bySymbol.set(symbol, created);
        networkContracts += 1;
      }
    }
  } catch {
    // 网络合约失败不阻断现货同步
  }

  const alpha = await fetchAlphaTokenMaps();
  let alphaOnly = 0;
  for (const [symbol, item] of alpha.map.entries()) {
    const contract = String(item?.contractAddress || "").trim();
    const chainName = String(item?.chainName || "").trim();
    const existing = bySymbol.get(symbol);
    if (existing) {
      if (!existing.contractAddress && contract) {
        existing.contractAddress = contract;
        existing.contractNetwork = chainName || existing.contractNetwork;
      }
      continue;
    }
    seen.add(symbol);
    alphaOnly += 1;
    const row = {
      symbol,
      name: item?.name || symbol,
      binanceSymbol: `${symbol}USDT`,
      contractAddress: contract,
      contractNetwork: chainName,
      listingType: "alpha",
      chain: "binance-alpha",
      source: "alpha",
      enabled: true,
      notes: chainName ? `Alpha链:${chainName}` : "",
    };
    synced.push(row);
    bySymbol.set(symbol, row);
  }

  // U 本位永续（含股票/TradFi 永续如 STXX）：仅补现货/Alpha 没有的交易对
  let futuresOnly = 0;
  try {
    const futuresTickers = await fetchJsonFirstOk(FUTURES_TICKER_24HR_URLS, 45000);
    if (Array.isArray(futuresTickers)) {
      for (const item of futuresTickers) {
        const pair = String(item?.symbol || "").toUpperCase();
        if (!pair.endsWith("USDT")) continue;
        if (pair.includes("_")) continue; // 交割等带日期后缀的先跳过
        const symbol = normalizeTokenSymbol(pair.slice(0, -4));
        if (!symbol || seen.has(symbol)) continue;
        seen.add(symbol);
        futuresOnly += 1;
        const row = {
          symbol,
          name: symbol,
          binanceSymbol: pair,
          contractAddress: "",
          contractNetwork: "",
          listingType: "futures",
          chain: "binance-futures",
          source: "futures",
          enabled: true,
          notes: "币安 U 本位永续（无现货时可取合约价）",
        };
        synced.push(row);
        bySymbol.set(symbol, row);
      }
    }
  } catch {
    // 合约列表失败不阻断主同步
  }

  const result = applySyncedTokenBatch(synced);
  return {
    ...result,
    spotPairs: synced.filter((t) => t.listingType === "spot").length,
    alphaOnly,
    futuresOnly,
    networkContracts,
    fetched: synced.length,
  };
}

/** 拉取代币地址列表的实时报价（币安公开 ticker/24hr 批量） */
export async function fetchRegistryTokenQuotes(symbols = []) {
  const requested = normalizeUserTokens(symbols);
  const allEntries = listAllTokenRegistryEntries();
  const entries = requested.length
    ? allEntries.filter((t) => requested.includes(t.symbol))
    : allEntries;

  if (!entries.length) return { tickers: [], missing: [] };

  const spotMap = await fetchAllSpot24hrMap(true);
  const alphaMaps = await fetchAlphaTokenMaps();
  const tickers = [];
  const missing = [];

  for (const entry of entries) {
    const pair = normalizeBinancePair(entry.binanceSymbol, `${entry.symbol}USDT`);
    const spot = spotMap.get(pair);
    if (spot?.lastPrice != null) {
      tickers.push({
        symbol: entry.symbol,
        binanceSymbol: pair,
        price: String(spot.lastPrice),
        openPrice: spot.openPrice != null ? String(spot.openPrice) : "",
        highPrice: spot.highPrice != null ? String(spot.highPrice) : "",
        lowPrice: spot.lowPrice != null ? String(spot.lowPrice) : "",
        changePercent: Number(spot.priceChangePercent),
        source: "binance_spot",
        marketType: "币安现货",
        contractAddress: entry.contractAddress || "",
      });
      continue;
    }

    const addr = String(entry.contractAddress || "").trim().toLowerCase();
    const alphaItem =
      (addr && alphaMaps.byAddress?.get(addr)) || alphaMaps.map.get(entry.symbol);
    const alpha = alphaItemToQuote(entry.symbol, alphaItem);
    if (alpha) {
      tickers.push({
        ...alpha,
        binanceSymbol: pair,
        contractAddress: alpha.contractAddress || entry.contractAddress || "",
      });
    } else {
      missing.push(entry.symbol);
    }
  }

  return { tickers, missing };
}

async function fetchAlphaTokenMaps() {
  if (
    Date.now() - alphaTokenCache.at < ALPHA_CACHE_MS &&
    alphaTokenCache.map?.size
  ) {
    return alphaTokenCache;
  }

  const json = await fetchJson(ALPHA_TOKEN_LIST_URL);
  const bySymbol = new Map();
  const byAddress = new Map();
  for (const item of json?.data || []) {
    const symbol = normalizeTokenSymbol(item?.symbol);
    if (symbol && !bySymbol.has(symbol)) bySymbol.set(symbol, item);
    const addr = String(item?.contractAddress || "").trim().toLowerCase();
    if (addr) byAddress.set(addr, item);
  }
  alphaTokenCache = { at: Date.now(), map: bySymbol, byAddress };
  return alphaTokenCache;
}

function normalizeBinancePair(pairOrSymbol, fallbackSymbol = "") {
  let pair = String(pairOrSymbol || fallbackSymbol || "")
    .trim()
    .replace(/^\$/, "")
    .toUpperCase()
    .replace(/\s+/g, "");
  if (!pair) return "";
  if (!/(USDT|USDC|BUSD|FDUSD|TUSD)$/.test(pair)) pair = `${pair}USDT`;
  return pair;
}

async function fetchSpotTicker(symbol, binancePair = "") {
  const pair = normalizeBinancePair(binancePair, `${symbol}USDT`);
  if (!pair) return null;

  // 单币优先走轻量单对接口，避免冷启动拉整表 24hr
  const hasWarmCache =
    Date.now() - spotTickerCache.at < SPOT_TICKER_CACHE_MS && spotTickerCache.byPair.size > 0;
  if (hasWarmCache) {
    const item = spotTickerCache.byPair.get(pair);
    if (item?.lastPrice != null) {
      return {
        symbol,
        binanceSymbol: pair,
        price: String(item.lastPrice),
        openPrice: item.openPrice != null ? String(item.openPrice) : "",
        highPrice: item.highPrice != null ? String(item.highPrice) : "",
        lowPrice: item.lowPrice != null ? String(item.lowPrice) : "",
        changePercent: Number(item.priceChangePercent),
        source: "binance_spot",
        marketType: "币安现货",
      };
    }
  }

  const urls = [
    `https://data-api.binance.vision/api/v3/ticker/24hr?symbol=${pair}`,
    `https://api.binance.com/api/v3/ticker/24hr?symbol=${pair}`,
  ];
  const json = await fetchJsonFirstOk(urls, 12000).catch(() => null);
  if (json && !json.code && json.lastPrice != null) {
    return {
      symbol,
      binanceSymbol: pair,
      price: String(json.lastPrice),
      openPrice: json.openPrice != null ? String(json.openPrice) : "",
      highPrice: json.highPrice != null ? String(json.highPrice) : "",
      lowPrice: json.lowPrice != null ? String(json.lowPrice) : "",
      changePercent: Number(json.priceChangePercent),
      source: "binance_spot",
      marketType: "币安现货",
    };
  }

  try {
    const spotMap = await fetchAllSpot24hrMap(false);
    const item = spotMap.get(pair);
    if (item?.lastPrice != null) {
      return {
        symbol,
        binanceSymbol: pair,
        price: String(item.lastPrice),
        openPrice: item.openPrice != null ? String(item.openPrice) : "",
        highPrice: item.highPrice != null ? String(item.highPrice) : "",
        lowPrice: item.lowPrice != null ? String(item.lowPrice) : "",
        changePercent: Number(item.priceChangePercent),
        source: "binance_spot",
        marketType: "币安现货",
      };
    }
  } catch {
    // ignore
  }
  return null;
}

function alphaItemToQuote(symbol, item) {
  if (!item?.price) return null;
  return {
    symbol,
    price: String(item.price),
    changePercent: Number(item.percentChange24h),
    source: "binance_alpha",
    marketType: "币安 Alpha",
    tokenName: item.name || symbol,
    chainName: item.chainName || "",
    contractAddress: item.contractAddress || "",
  };
}

async function fetchAlphaTicker(symbol, contractAddress = "") {
  const caches = await fetchAlphaTokenMaps();
  const addr = String(contractAddress || "").trim().toLowerCase();
  if (addr && caches.byAddress?.has(addr)) {
    return alphaItemToQuote(symbol, caches.byAddress.get(addr));
  }
  return alphaItemToQuote(symbol, caches.map.get(symbol));
}

async function ensureFuturesTickerCache() {
  if (Date.now() - futuresTickerCache.at < FUTURES_TICKER_CACHE_MS && futuresTickerCache.byPair.size) {
    return futuresTickerCache.byPair;
  }
  if (futuresTickerInflight) return futuresTickerInflight;

  const task = (async () => {
    const json = await fetchJsonFirstOk(FUTURES_TICKER_24HR_URLS, 45000).catch(() => null);
    const map = new Map();
    if (Array.isArray(json)) {
      for (const item of json) {
        const pair = String(item?.symbol || "").toUpperCase();
        if (pair) map.set(pair, item);
      }
    }
    futuresTickerCache = { at: Date.now(), byPair: map };
    return map;
  })();

  futuresTickerInflight = task.finally(() => {
    if (futuresTickerInflight === task) futuresTickerInflight = null;
  });
  return futuresTickerInflight;
}

async function fetchFuturesTicker(symbol, pair) {
  const normalized = normalizeTokenSymbol(symbol);
  const tradePair = String(pair || `${normalized}USDT`).toUpperCase();

  const hasWarmCache =
    Date.now() - futuresTickerCache.at < FUTURES_TICKER_CACHE_MS && futuresTickerCache.byPair.size > 0;
  if (hasWarmCache) {
    const hit = futuresTickerCache.byPair.get(tradePair);
    if (hit?.lastPrice != null) {
      return {
        symbol: normalized,
        binanceSymbol: tradePair,
        price: String(hit.lastPrice),
        openPrice: hit.openPrice != null ? String(hit.openPrice) : "",
        highPrice: hit.highPrice != null ? String(hit.highPrice) : "",
        lowPrice: hit.lowPrice != null ? String(hit.lowPrice) : "",
        changePercent: Number(hit.priceChangePercent),
        source: "binance_futures",
        marketType: "币安 U 本位合约",
      };
    }
  }

  const json = await fetchJsonFirstOk(FUTURES_TICKER_SYMBOL_URLS(tradePair), 12000).catch(() => null);
  if (json && !json.code && json.lastPrice != null) {
    return {
      symbol: normalized,
      binanceSymbol: tradePair,
      price: String(json.lastPrice),
      openPrice: json.openPrice != null ? String(json.openPrice) : "",
      highPrice: json.highPrice != null ? String(json.highPrice) : "",
      lowPrice: json.lowPrice != null ? String(json.lowPrice) : "",
      changePercent: Number(json.priceChangePercent),
      source: "binance_futures",
      marketType: "币安 U 本位合约",
    };
  }

  try {
    const cache = await ensureFuturesTickerCache();
    const hit = cache.get(tradePair);
    if (hit?.lastPrice != null) {
      return {
        symbol: normalized,
        binanceSymbol: tradePair,
        price: String(hit.lastPrice),
        openPrice: hit.openPrice != null ? String(hit.openPrice) : "",
        highPrice: hit.highPrice != null ? String(hit.highPrice) : "",
        lowPrice: hit.lowPrice != null ? String(hit.lowPrice) : "",
        changePercent: Number(hit.priceChangePercent),
        source: "binance_futures",
        marketType: "币安 U 本位合约",
      };
    }
  } catch {
    // ignore
  }
  return null;
}

async function fetchTokenQuote(symbol) {
  const normalized = normalizeTokenSymbol(symbol);
  if (!normalized) return null;

  const registry = getTokenRegistryEntry(normalized);
  const source = registry?.source || "auto";
  const pair = registry?.binanceSymbol || `${normalized}USDT`;
  const contract = registry?.contractAddress || "";
  const listingType = registry?.listingType || "";

  const trySpot = async () => fetchSpotTicker(normalized, pair);
  const tryAlpha = async () => fetchAlphaTicker(normalized, contract);
  const tryFutures = async () => fetchFuturesTicker(normalized, pair);

  if (source === "spot") return trySpot();
  if (source === "alpha") return tryAlpha();
  if (source === "futures" || listingType === "futures" || registry?.chain === "binance-futures") {
    return (await tryFutures()) || (await trySpot()) || tryAlpha();
  }

  // auto：现货优先；Alpha / 有合约的非主流再走 Alpha；最后尝试 U 本位合约（TradFi 等）
  if (!isMainstream(normalized) || registry?.chain === "binance-alpha") {
    const alpha = await tryAlpha();
    if (alpha) return alpha;
  }

  const spot = await trySpot();
  if (spot) return spot;

  const alpha = await tryAlpha();
  if (alpha) return alpha;

  return tryFutures();
}

export function formatUsdPrice(price) {
  const num = Number(price);
  if (!Number.isFinite(num)) return String(price || "");
  // 不用千分位逗号：避免 String.replace 把 $2,879 误当成捕获组 $2
  if (num >= 1000) {
    return num.toLocaleString("en-US", { maximumFractionDigits: 2, useGrouping: false });
  }
  if (num >= 1) return num.toFixed(4).replace(/\.?0+$/, "");
  if (num >= 0.01) return num.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  return num.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

export function getTokenAliases(symbol) {
  const key = normalizeTokenSymbol(symbol);
  const list = TOKEN_ALIASES[key] || [key];
  return [...new Set(list.filter(Boolean))];
}

function isGenericHeadline(title) {
  const t = String(title || "").toLowerCase();
  return (
    t.includes("what happened in crypto today") ||
    t.includes("need to know what happened") ||
    t.includes("crypto today") ||
    t.length < 18
  );
}

export function pickTokensFromUserSelection(userTokens = [], { index = 0, recentPairs = [] } = {}) {
  const tokens = normalizeUserTokens(userTokens);
  if (!tokens.length) return null;

  if (tokens.length === 1) {
    return [tokens[0], tokens[0]];
  }

  // 多选时随机抽取，并优先避开最近发过的币，避免总落在列表前几位（如 BTC/ETH）
  const recentTokens = new Set(recentPairs.flat());
  const usedPairKeys = new Set(
    recentPairs.map((p) => (Array.isArray(p) && p.length >= 2 ? pairKey(p[0], p[1]) : "")).filter(Boolean),
  );

  const primaryPool = pickLeastUsed(tokens, recentTokens);
  // index 仅作同轮多次生成时的轻微偏移，避免一轮内重复抽到同一主币
  const primary =
    primaryPool[index % primaryPool.length] ||
    tokens[Math.floor(Math.random() * tokens.length)];

  const secondaryPool = pickLeastUsed(
    tokens.filter((s) => s !== primary),
    recentTokens,
  );
  const secondary =
    secondaryPool.find((s) => !usedPairKeys.has(pairKey(primary, s))) ||
    secondaryPool[0] ||
    primary;

  return [primary, secondary];
}

export async function buildCryptoContext({
  preferredTokens = [],
  selectedTokens = [],
  recentPairs = null,
  marketSentiment = "auto",
  tokenIndex = 0,
} = {}) {
  const pairs = recentPairs || getRecentTokenPairs();
  const explicit = normalizeUserTokens(selectedTokens);
  const preferred = preferredTokens.filter(isMainstream);

  // 已指定代币时：新闻与行情并行；未指定时先预热 BTC/ETH，等新闻决定 focus 后再补
  let focusTokens;
  let news;
  let tickersResult;

  if (explicit.length > 0) {
    focusTokens = pickTokensFromUserSelection(explicit, { index: tokenIndex, recentPairs: pairs });
    // 只拉本篇重点币行情，避免把整份候选列表（常以 BTC/ETH 开头）塞进提示词
    [news, tickersResult] = await Promise.all([
      fetchCryptoNews({ limit: 6 }),
      fetchMarketTickers(focusTokens),
    ]);
  } else {
    const warmSymbols = [...new Set([...(preferred.length ? preferred : ["BTC", "ETH"])])].slice(0, 4);
    [news, tickersResult] = await Promise.all([
      fetchCryptoNews({ limit: 6 }),
      fetchMarketTickers(warmSymbols),
    ]);
    focusTokens = pickFocusTokens({
      articles: news.articles,
      preferred,
      recentPairs: pairs,
    });
    const needExtra = focusTokens.filter((s) => !tickersResult.tickers.some((t) => t.symbol === s));
    if (needExtra.length) {
      const extra = await fetchMarketTickers(needExtra);
      tickersResult = {
        tickers: [...tickersResult.tickers, ...extra.tickers],
        missing: [...new Set([...tickersResult.missing, ...extra.missing])],
      };
    }
  }

  const focusSet = new Set(focusTokens);
  // 预热可能多拉了 BTC/ETH，提示词里只保留本篇重点币，避免串价
  const tickers = tickersResult.tickers.filter((t) => focusSet.has(t.symbol));
  const missingTickers = [
    ...new Set([
      ...tickersResult.missing.filter((s) => focusSet.has(s)),
      ...focusTokens.filter((s) => !tickers.some((t) => t.symbol === s)),
    ]),
  ];
  // 优先匹配本篇重点币的新闻，而不是按用户列表顺序（BTC 常在最前）
  const leadArticle = pickLeadArticle(news.articles, focusTokens);
  const sentiment = ["bullish", "bearish", "auto"].includes(marketSentiment) ? marketSentiment : "auto";

  const topicBase = `围绕 ${focusTokens.map((t) => `$${t}`).join(" 和 ")} 的最新行情与资讯`;
  const topic =
    sentiment === "bullish"
      ? `${topicBase}，表达看多观点写帖`
      : sentiment === "bearish"
        ? `${topicBase}，表达看空/谨慎观点写帖`
        : explicit.length
          ? `${topicBase}写帖`
          : leadArticle
            ? `结合这条新闻写帖：${leadArticle.title}`
            : `${topicBase}写帖`;

  return {
    fetchedAt: Date.now(),
    focusTokens,
    selectedTokens: explicit,
    marketSentiment: sentiment,
    leadArticle,
    headlines: news.articles.slice(0, 5).map((a) => a.title),
    tickers,
    missingTickers,
    newsErrors: news.errors,
    topic,
  };
}

function articleMentionsToken(article, symbol) {
  const text = `${article?.title || ""} ${article?.summary || ""}`.toUpperCase();
  const sym = String(symbol || "").toUpperCase();
  if (!sym) return false;
  if (text.includes(`$${sym}`)) return true;
  // 短代码用词边界，避免 NEAR⊂NEARLY、TON⊂BUTTON 等误匹配
  const re = new RegExp(`(?:^|[^A-Z0-9])${sym}(?:[^A-Z0-9]|$)`);
  return re.test(text);
}

function pickLeadArticle(articles = [], preferredTokens = []) {
  const usable = articles.filter((a) => !isGenericHeadline(a.title));
  if (!preferredTokens.length) return usable[0] || articles[0] || null;
  // 按 preferred 顺序找匹配新闻，保证 focus 主币优先于列表里靠前的 BTC/ETH
  for (const symbol of preferredTokens) {
    const matched = usable.find((a) => articleMentionsToken(a, symbol));
    if (matched) return matched;
  }
  return null;
}

export function formatContextForPrompt(context) {
  const lines = [];
  if (context.selectedTokens?.length) {
    lines.push(`【用户指定代币】${context.selectedTokens.map((s) => `$${s}`).join("、")}`);
  }
  if (context.headlines?.length && (!context.selectedTokens?.length || context.leadArticle)) {
    lines.push("【最新资讯】");
    const headlines = context.leadArticle
      ? [context.leadArticle.title]
      : context.headlines.slice(0, 5);
    headlines.forEach((title, i) => lines.push(`${i + 1}. ${title}`));
  }
  if (context.tickers?.length) {
    lines.push("【24h 行情（币安真实数据，正文只能使用以下价格，禁止用记忆中的旧价格）】");
    context.tickers.forEach((t) => {
      const sign = t.changePercent >= 0 ? "+" : "";
      const marketLabel =
        t.marketType ||
        (t.source === "binance_alpha"
          ? "币安 Alpha"
          : t.source === "binance_futures"
            ? "币安 U 本位合约"
            : "币安现货");
      const priceText = formatUsdPrice(t.price);
      const changeText = `${sign}${Number(t.changePercent || 0).toFixed(2)}%`;
      const registry = getTokenRegistryEntry(t.symbol);
      const contract =
        t.contractAddress || registry?.contractAddress || "";
      const pair = t.binanceSymbol || registry?.binanceSymbol || "";
      const openText = t.openPrice ? formatUsdPrice(t.openPrice) : "";
      const highText = t.highPrice ? formatUsdPrice(t.highPrice) : "";
      const lowText = t.lowPrice ? formatUsdPrice(t.lowPrice) : "";
      lines.push(
        `${t.symbol} (${marketLabel}): 最新价 $${priceText} USDT (24h ${changeText})` +
          (openText ? `，开盘 $${openText}` : "") +
          (highText ? `，最高 $${highText}` : "") +
          (lowText ? `，最低 $${lowText}` : "") +
          (t.tokenName && t.tokenName !== t.symbol ? `，项目名 ${t.tokenName}` : "") +
          (t.chainName ? `，链 ${t.chainName}` : "") +
          (pair ? `，交易对 ${pair}` : "") +
          (contract ? `，合约 ${contract}` : ""),
      );
    });
    lines.push(
      "【价格纪律】正文凡出现美元价格/开盘价/最高价/最低价/收盘价/涨跌幅，必须逐字使用上表数字；禁止输出 XX、$XX、XXXX 占位，禁止使用训练记忆中的过时价格（如把 BTC 写成 26000）。",
    );
  }
  lines.push(`【本篇重点代币】${context.focusTokens.map((s) => `$${s}`).join("、")}`);
  if (context.marketSentiment === "bullish") {
    lines.push("【观点倾向】看多：正文应表达对该代币的乐观看法，可结合利好、上涨趋势、机会等，语气积极但不过度夸张。");
  } else if (context.marketSentiment === "bearish") {
    lines.push("【观点倾向】看空：正文应表达谨慎或偏空看法，可结合风险、回调、抛压等，语气理性但不制造恐慌。");
  } else {
    lines.push("【观点倾向】自动：根据 24h 行情与新闻自然判断偏多或偏空，保持客观。");
  }
  const hasCustom = context.selectedTokens?.some((s) => !isMainstream(s));
  if (hasCustom) {
    lines.push("【代币要求】必须使用【本篇重点代币】中的标签；这是用户在币安广场选择的代币，不要与其他同名项目混淆。");
  } else {
    lines.push("【代币要求】必须使用【本篇重点代币】中的标签，不要提及其他未指定的代币、股票或平台名。");
  }
  if (context.missingTickers?.length) {
    lines.push(
      `【未找到行情】${context.missingTickers.map((s) => `$${s}`).join("、")} 暂无币安现货/Alpha/U本位合约报价，正文中禁止编造具体价格、支撑位、阻力位等数字，只做定性分析。`,
    );
  } else if (context.selectedTokens?.length && !context.tickers?.length) {
    lines.push("【行情说明】未获取到币安报价，正文中禁止编造具体价格数字，只做定性分析。");
  }
  return lines.join("\n");
}
