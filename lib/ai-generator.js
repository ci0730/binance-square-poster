import { readAiSettings, pickAiTopic } from "./ai-settings.js";
import { buildCryptoContext, formatContextForPrompt, pickTokensFromUserSelection, normalizeUserTokens, fetchMarketTickers, formatUsdPrice, getTokenAliases } from "./crypto-context.js";
import {
  pickContentStyle,
  getContentStylePrompt,
  getContentStyleUserHint,
  getContentStyleMeta,
  resolveStylePoolForGeneration,
  RANDOM_CONTENT_STYLE_ID,
  isReferenceStyleId,
} from "./ai-content-styles.js";
import { setAiRunProgress } from "./ai-run-progress.js";
import { buildGeminiUrl, resolveProviderRuntime, toOpenAiModelsUrl, AUTO_MATCH_MODEL_CANDIDATES, getAiProvider } from "./ai-providers.js";
import { getProxyUrl } from "./square-api.js";
import { transportFetch } from "./http-transport.js";

const DEFAULT_SYSTEM_PROMPT = getContentStylePrompt("casual");

/** 并行托管时可能有多路 AI 请求；取消时全部打断 */
const activeAiRequests = new Set();

export function abortActiveAiRequest(reason = "已取消托管") {
  if (!activeAiRequests.size) return false;
  const err = new Error(reason);
  for (const handle of [...activeAiRequests]) {
    activeAiRequests.delete(handle);
    try {
      handle.abort?.(err);
    } catch {
      // ignore
    }
  }
  return true;
}

async function requestJson(url, options = {}) {
  const controller = new AbortController();
  const handle = {
    abort(err) {
      const reason = err instanceof Error ? err : new Error(String(err || "已取消托管"));
      try {
        controller.abort(reason);
      } catch {
        // ignore
      }
    },
  };
  activeAiRequests.add(handle);

  try {
    const response = await transportFetch(url, {
      method: options.method || "GET",
      headers: options.headers || {},
      body: options.body || undefined,
      timeoutMs: options.timeoutMs || 90000,
      // 与发帖/行情同一套代理栈（支持 HTTP CONNECT / SOCKS5）
      proxyUrl: getProxyUrl() || "",
      retries: false,
      signal: controller.signal,
    });
    const text = await response.text();
    if (controller.signal.aborted) throw abortErrorFromSignal(controller.signal);
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
    return { status: response.status, data, text };
  } catch (err) {
    if (controller.signal.aborted) throw abortErrorFromSignal(controller.signal, err);
    throw err;
  } finally {
    activeAiRequests.delete(handle);
  }
}

function abortErrorFromSignal(signal, fallback) {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  if (typeof reason === "string" && reason.trim()) return new Error(reason.trim());
  if (fallback instanceof Error && /已取消托管|aborted|AbortError/i.test(fallback.message)) {
    return fallback;
  }
  return new Error("已取消托管");
}

function extractContent(data, apiType = "openai") {
  if (apiType === "anthropic") {
    const block = data?.content?.find((item) => item.type === "text");
    return normalizeAiText(block?.text || "");
  }
  if (apiType === "gemini") {
    const parts = data?.candidates?.[0]?.content?.parts || [];
    return normalizeAiText(parts.map((part) => part.text || "").join("\n"));
  }
  return normalizeAiText(data?.choices?.[0]?.message?.content || "");
}

function extractFinishReason(data, apiType = "openai") {
  if (apiType === "anthropic") return String(data?.stop_reason || "").toLowerCase();
  if (apiType === "gemini") return String(data?.candidates?.[0]?.finishReason || "").toLowerCase();
  return String(data?.choices?.[0]?.finish_reason || "").toLowerCase();
}

export function isTruncatedFinishReason(reason = "") {
  return /^(length|max_tokens?|max_token|model_length|max_output_tokens?)$/i.test(
    String(reason || "").trim(),
  );
}

function stripTrailingTokenTags(text) {
  return String(text || "")
    .replace(/\n?(?:\$[A-Z0-9]{2,16}\s*){1,6}$/i, "")
    .trim();
}

export function isLikelyIncompletePost(text, finishReason = "") {
  if (isTruncatedFinishReason(finishReason)) return true;
  const body = stripTrailingTokenTags(text);
  if (body.length < 36) return true;
  if (/[：:，,、；;（(\[【“‘\-—]$/.test(body)) return true;
  if (/(?:因为|如果|但是|而且|以及|例如|包括|分别为|这意味着|关键在于|接下来)$/i.test(body)) {
    return true;
  }

  const pairs = [
    ["（", "）"],
    ["(", ")"],
    ["【", "】"],
    ["[", "]"],
  ];
  return pairs.some(([open, close]) => body.split(open).length > body.split(close).length);
}

export function mergeAiContinuation(original, continuation) {
  const head = String(original || "").trim();
  let tail = normalizeAiText(continuation)
    .replace(/^(?:续写|接着写|补充)[：:]\s*/i, "")
    .trim();
  if (!head) return tail;
  if (!tail) return head;

  const maxOverlap = Math.min(120, head.length, tail.length);
  for (let size = maxOverlap; size >= 2; size--) {
    const overlap = head.slice(-size);
    const isUsefulShortChineseOverlap = size < 8 && /^[\u4e00-\u9fff]{2,}$/.test(overlap);
    if ((size >= 8 || isUsefulShortChineseOverlap) && overlap === tail.slice(0, size)) {
      tail = tail.slice(size).trimStart();
      break;
    }
  }
  if (!tail) return head;
  const separator = /[\n。！？!?；;：:]$/.test(head) ? "\n" : "";
  return `${head}${separator}${tail}`.replace(/\n{3,}/g, "\n\n").trim();
}

function normalizeAiText(content) {
  if (!content) return "";
  return String(content)
    .trim()
    .replace(/^["'「『]+|["'」』]+$/g, "")
    .replace(/^帖子[：:]\s*/i, "")
    .trim();
}

function sanitizeSpuriousMentions(text) {
  return String(text || "")
    .replace(/\bRobin\s*hood\b/gi, "某美股交易平台")
    .replace(/\bKraken\b/gi, "某海外交易所")
    .replace(/\bBitClub\b/gi, "某矿池项目")
    .replace(/\bHOOD\b/g, "该平台")
    // 只压缩行内空白，保留换行，避免行情/快讯/教学排版被压成一行
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function ensureTokenTags(text, tokens = []) {
  const raw = tokens.map((t) => String(t).replace(/^\$/, "").toUpperCase()).filter(Boolean);
  let normalized;
  if (raw.length === 1) normalized = [raw[0], raw[0]];
  else normalized = [...new Set(raw)].slice(0, 2);
  if (!normalized.length) return sanitizeSpuriousMentions(text);

  let body = sanitizeSpuriousMentions(text);
  body = body.replace(/(?:\s+\$[A-Z]{2,10}){1,8}\s*$/i, "").trim();
  body = body.replace(/\$([A-Z]{2,10})\b/gi, (_, symbol) => symbol.toUpperCase());
  body = body.replace(/[^\S\n]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  const tail = normalized.map((t) => `$${t}`).join(" ");
  return `${body}\n${tail}`.trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function enforceTickerPrices(text, tickers = [], focusSymbols = []) {
  if (!tickers?.length || !text) return text;
  const activeTickers = pickActiveTickers(tickers, focusSymbols);
  if (!activeTickers.length) return text;

  // 美元价：用「向前最近代币」校正，保留开高低标签后的真值
  let result = forceCorrectNearbyPrices(text, activeTickers);

  for (const ticker of activeTickers) {
    const symbol = String(ticker.symbol || "").toUpperCase();
    const actual = Number(ticker.price);
    const changeText = formatChangePercent(ticker.changePercent);
    const support = formatUsdPrice(actual * 0.9);
    const resistance = formatUsdPrice(actual * 1.1);
    const sym = escapeRegExp(symbol);
    const others = activeTickers
      .map((t) => String(t.symbol).toUpperCase())
      .filter((s) => s !== symbol)
      .map(escapeRegExp);
    const notOther = others.length
      ? `(?:(?!\\b(?:${others.join("|")})\\b)[\\s\\S]){0,120}?`
      : `[^$\\n]{0,120}?`;

    if (changeText) {
      const notOtherPct = others.length
        ? `(?:(?!\\b(?:${others.join("|")})\\b)[\\s\\S]){0,120}?`
        : `[^%\\n]{0,120}?`;
      const nearChange = new RegExp(
        `(\\$?${sym}\\b${notOtherPct})([+-]?\\d+(?:\\.\\d+)?\\s*%)`,
        "gi",
      );
      result = result.replace(nearChange, (_, prefix) => `${prefix}${changeText}`);
    }

    result = result.replace(
      new RegExp(`(\\$?${sym}\\b${notOther}支撑位[^$\\n]{0,24})(\\$\\s?[\\d.,]+|[\\d.,]+)`, "gi"),
      (_, prefix) => `${prefix}$${support}`,
    );
    result = result.replace(
      new RegExp(`(\\$?${sym}\\b${notOther}阻力[^$\\n]{0,24})(\\$\\s?[\\d.,]+|[\\d.,]+)`, "gi"),
      (_, prefix) => `${prefix}$${resistance}`,
    );
  }

  return result.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function pickActiveTickers(tickers = [], focusSymbols = []) {
  const focusSet = new Set((focusSymbols || []).map((s) => String(s).toUpperCase()));
  return (tickers || []).filter((ticker) => {
    const symbol = String(ticker.symbol || "").toUpperCase();
    if (!symbol) return false;
    if (focusSet.size && !focusSet.has(symbol)) return false;
    return Number.isFinite(Number(ticker.price)) && Number(ticker.price) > 0;
  });
}

function formatChangePercent(changePercent) {
  const changePct = Number(changePercent);
  if (!Number.isFinite(changePct)) return "";
  return `${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%`;
}

function replaceLabeledOhlc(text, ticker) {
  const price = formatUsdPrice(ticker.price);
  const open = formatUsdPrice(ticker.openPrice || ticker.price);
  const high = formatUsdPrice(ticker.highPrice || ticker.price);
  const low = formatUsdPrice(ticker.lowPrice || ticker.price);
  const change = formatChangePercent(ticker.changePercent) || "+0.00%";
  let result = String(text || "");

  // 只填占位符（XX / $XX）；允许后接空格与下一字段（如「开盘:$XX 最高:」）
  const fillMoney = (labelPattern, value) => {
    result = result.replace(
      new RegExp(
        `(${labelPattern}\\s*[:：]?\\s*)(?:\\$\\s*)?X{1,6}(?:\\.X{1,4})?\\b`,
        "gi",
      ),
      (_, prefix) => `${prefix}$${value}`,
    );
  };

  fillMoney("开盘(?:价)?", open);
  fillMoney("最高(?:价)?", high);
  fillMoney("最低(?:价)?", low);
  fillMoney("收盘(?:价)?|最新(?:价)?|现价", price);

  result = result.replace(
    /(涨跌幅|涨幅|跌幅)\s*[:：]?\s*%?\s*[+-]?X{1,6}%?/gi,
    (_, label) => `${label}: ${change}`,
  );
  return result;
}

function tickerKnownLevels(ticker) {
  const levels = new Set();
  for (const key of ["price", "openPrice", "highPrice", "lowPrice"]) {
    const n = Number(ticker?.[key]);
    if (n > 0) {
      levels.add(Number(n.toFixed(6)));
      levels.add(Number(formatUsdPrice(n)));
    }
  }
  return levels;
}

function isOhlcOrLevelLabelPrefix(prefix) {
  return /(开盘|最高|最低|支撑|压力|阻力)\s*[:：]?\s*$/i.test(String(prefix || ""));
}

/** 在价格左侧窗口内找最近出现的代币（解决「BTC 开盘:$x 现价 $错价」只校正到第一处的问题） */
function findNearestTickerBefore(beforeText, tickers = []) {
  let best = null;
  let bestPos = -1;
  for (const ticker of tickers) {
    const symbol = String(ticker.symbol || "").toUpperCase();
    if (!symbol) continue;
    for (const alias of getTokenAliases(symbol)) {
      const re =
        /^[A-Z0-9]{2,10}$/i.test(alias)
          ? new RegExp(`\\$?\\b${escapeRegExp(alias)}\\b`, "gi")
          : new RegExp(escapeRegExp(alias), "gi");
      let m;
      while ((m = re.exec(beforeText)) !== null) {
        if (m.index >= bestPos) {
          bestPos = m.index;
          best = ticker;
        }
      }
    }
  }
  return best;
}

/** 清掉范文占位符残留：XXXX / XX.XX / $XX / 开盘价:$XX 等，并强制校正离谱价格 */
function fillPlaceholderArtifacts(text, tickers = [], focusSymbols = []) {
  if (!text) return text;
  let result = String(text);

  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const dateFull = `${y}.${m}.${d}`;
  const dateMd = `${m}.${d}`;

  result = result.replace(/\b20\d{2}\s*[.／/\s]\s*XX\s*[.／/]\s*XX\b/gi, dateFull);
  result = result.replace(/\b20\d{2}\.XX\.XX\b/gi, dateFull);
  result = result.replace(/\b20\d{2}\s+XX\.XX\b/gi, dateFull);
  result = result.replace(/(^|[^\d$])XX\.XX(?![\d%])/g, `$1${dateMd}`);

  const ordered = pickActiveTickers(tickers, focusSymbols);
  const primary = ordered[0];

  // 先用主推代币填 OHLC / 支撑压力 / 涨跌幅占位，再按币种就近填 $XX
  if (primary) {
    result = replaceLabeledOhlc(result, primary);
    const actual = Number(primary.price);
    const price = formatUsdPrice(actual);
    const support = formatUsdPrice(actual * 0.97);
    const resistance = formatUsdPrice(actual * 1.03);
    const change = formatChangePercent(primary.changePercent);

    result = result.replace(
      /关键支撑\s*[:：]?\s*\$?\s*(?:X{1,6}|x{1,6})\b/gi,
      () => `关键支撑:$${support}`,
    );
    result = result.replace(
      /关键压力\s*[:：]?\s*\$?\s*(?:X{1,6}|x{1,6})\b/gi,
      () => `关键压力:$${resistance}`,
    );
    result = result.replace(/支撑(?:位)?\s*[:：]?\s*\$?\s*(?:X{1,6}|x{1,6})\b/gi, () => `支撑:$${support}`);
    result = result.replace(/(?:压力|阻力)(?:位)?\s*[:：]?\s*\$?\s*(?:X{1,6}|x{1,6})\b/gi, () => `压力:$${resistance}`);

    // 涨跌幅占位必须先于裸 XX→价格，否则「涨跌幅:%XX」「+X%」会被当成价格
    if (change) {
      result = result.replace(
        /(涨跌幅|涨幅|跌幅)\s*[:：]?\s*%?\s*[+-]?[Xx]{1,6}%?/gi,
        (_, label) => `${label}: ${change}`,
      );
      result = result.replace(/(^|[^\d$])[+-]?[Xx]{1,4}\s*%/gi, `$1${change}`);
      result = result.replace(/(^|[^\d])%[Xx]{1,4}%?/g, `$1${change}`);
      result = result.replace(/([:：]\s*)%[Xx]*\b/g, `$1${change}`);
    }

    // 按代币就近填充「SYMBOL…$XX」，避免 ETH 段被主币现价覆盖
    for (const ticker of ordered) {
      const symbol = String(ticker.symbol || "").toUpperCase();
      const tickerPrice = formatUsdPrice(ticker.price);
      const aliases = getTokenAliases(symbol);
      const aliasPattern = aliases.map(escapeRegExp).join("|");
      result = result.replace(
        new RegExp(
          `((?:\\$?${escapeRegExp(symbol)}\\b|${aliasPattern})(?:(?!关键支撑|关键压力|支撑|压力|阻力)[^\\n$]){0,100}?)(\\$\\s*X{1,6}\\b)`,
          "gi",
        ),
        (_, prefix) => `${prefix}$${tickerPrice}`,
      );
    }

    // 残留 $XX / XX → 主币现价
    result = result.replace(/\$\s*X{1,6}\b/gi, () => `$${price}`);
    result = result.replace(/(^|[^\dA-Z$])X{2,6}(?:\.X{1,4})?\b/gi, (_, prefix) => `${prefix}$${price}`);
  }

  // 强制把符号附近的美元价改成币安真价（覆盖 AI 记忆中的 26000 等过时价）
  result = forceCorrectNearbyPrices(result, ordered);

  // 仍残留的纯 X 占位去掉
  result = result.replace(/\b20\d{2}\s*[.／/]\s*X+\s*[.／/]\s*X+\b/gi, dateFull);
  result = result.replace(/\$\s*X{1,6}\b/gi, "");
  result = result.replace(/(^|[^\dA-Z$])X{2,6}(?:\.X{1,4})?\b/gi, "$1");
  result = result.replace(/([:：])\s*(?=\s|[，。,.!]|$)/g, "$1");
  result = result.replace(
    /(\b[A-Z0-9]{2,10}[（(][^）)]+[）)]\s*[:：]\s*)\1+/g,
    "$1",
  );
  return result.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function forceCorrectNearbyPrices(text, tickers = []) {
  if (!tickers.length || !text) return text;
  const active = tickers.filter((t) => Number(t?.price) > 0);
  if (!active.length) return text;

  // 从每个 $价格 向前找最近代币，避免「BTC 开盘:$真价 … 现价 $幻觉」因首次匹配被跳过而漏改
  let result = String(text).replace(/\$\s?[\d,]+(?:\.\d+)?/g, (priceToken, offset, full) => {
    const prefix = full.slice(Math.max(0, offset - 180), offset);
    if (isOhlcOrLevelLabelPrefix(prefix)) return priceToken;

    const ticker = findNearestTickerBefore(prefix, active);
    if (!ticker) return priceToken;

    const actual = Number(ticker.price);
    const written = Number(String(priceToken).replace(/[$,\s]/g, ""));
    if (!Number.isFinite(written) || !(actual > 0)) return priceToken;

    const levels = tickerKnownLevels(ticker);
    if (levels.has(Number(written.toFixed(6))) || Math.abs(written - actual) / actual <= 0.01) {
      return priceToken;
    }
    return `$${formatUsdPrice(actual)}`;
  });

  // 无 $ 的「现价/约 1800 美元」等
  result = result.replace(
    /((?:价格|现价|报价|约|在)\s*)(\d{3,7}(?:\.\d+)?)(?=\s*(?:USDT|美元|附近|左右|美金)?)/gi,
    (full, label, num, offset, whole) => {
      const prefix = whole.slice(Math.max(0, offset - 180), offset) + label;
      if (isOhlcOrLevelLabelPrefix(prefix)) return full;
      const ticker = findNearestTickerBefore(prefix, active);
      if (!ticker) return full;
      const actual = Number(ticker.price);
      const written = Number(num);
      if (!Number.isFinite(written) || !(actual > 0)) return full;
      const levels = tickerKnownLevels(ticker);
      if (levels.has(Number(written.toFixed(6))) || Math.abs(written - actual) / actual <= 0.01) {
        return full;
      }
      return `${label}${formatUsdPrice(actual)}`;
    },
  );

  return result;
}

function scrubRemainingPlaceholders(text, tickers = [], focusSymbols = []) {
  if (!text) return text;
  let result = String(text);
  const ordered = pickActiveTickers(tickers, focusSymbols);
  if (!ordered.length) return result;

  if (/\$\s*X{1,6}\b|开盘(?:价)?\s*[:：]?\s*\$?\s*X{1,6}|涨跌幅\s*[:：]?\s*%|[+-]?X{1,4}\s*%/i.test(result)) {
    result = replaceLabeledOhlc(result, ordered[0]);
    const change = formatChangePercent(ordered[0].changePercent);
    if (change) {
      result = result.replace(/(^|[^\d$])[+-]?[Xx]{1,4}\s*%/gi, `$1${change}`);
      result = result.replace(/(^|[^\d])%[Xx]{1,4}%?/g, `$1${change}`);
    }
    const price = formatUsdPrice(ordered[0].price);
    result = result.replace(/\$\s*X{1,6}\b/gi, () => `$${price}`);
    result = result.replace(/(^|[^\dA-Z$])X{2,6}\b/gi, (_, p) => `${p}$${price}`);
  }

  // 仍出现明显过时 BTC/ETH 幻觉价时再扫一轮
  result = forceCorrectNearbyPrices(result, ordered);
  return result.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

/** 供本地测试：后处理正文价格与占位符 */
export function sanitizeGeneratedPrices(text, tickers = [], focusSymbols = []) {
  let result = enforceTickerPrices(text, tickers, focusSymbols);
  result = fillPlaceholderArtifacts(result, tickers, focusSymbols);
  return scrubRemainingPlaceholders(result, tickers, focusSymbols);
}

function buildUserPrompt({
  topic,
  contextText,
  recentTexts = [],
  contentStyle = "casual",
  styleReferences = [],
  marketSentiment = "auto",
  tickers = [],
}) {
  const parts = [`请写一条币安广场短帖。`];
  if (topic) parts.push(`主题方向：${topic}`);
  if (contextText) parts.push(`\n${contextText}`);
  parts.push(`\n要求：${getContentStyleUserHint(contentStyle, styleReferences, { tickers })}`);
  if (marketSentiment === "bullish") {
    parts.push("本篇必须明确表达看多观点，语气积极但不过度夸张。");
  } else if (marketSentiment === "bearish") {
    parts.push("本篇必须明确表达看空或谨慎观点，语气理性但不制造恐慌。");
  }
  parts.push("注意：只能使用【本篇重点代币】中的代币标签，不要使用其他 $代币。");
  parts.push("若背景提供了【24h 行情】，正文中的价格、涨跌幅必须与该数据完全一致，禁止编造或使用其他同名代币价格。");
  parts.push("若背景未提供具体价格，正文中不要出现具体美元价格、支撑位、阻力位等数字。");
  parts.push("严禁输出 XXXX、XX、XX.XX、$XX、XXX、2026.XX.XX 等占位符；开盘/最高/最低/收盘/涨跌幅必须写成【24h 行情】里的真实数字。");
  parts.push("禁止使用训练知识里的过时价格（例如把 BTC 写成 20000~30000）；只能抄【强制行情】。");
  if (tickers.length) {
    const priceLines = tickers
      .map((t) => {
        const sign = Number(t.changePercent) >= 0 ? "+" : "";
        return `${t.symbol} 必须使用币安报价 $${formatUsdPrice(t.price)}（24h ${sign}${Number(t.changePercent || 0).toFixed(2)}%）`;
      })
      .join("；");
    parts.push(`【强制行情】${priceLines}。不要引用其他来源或记忆中的价格。`);
  }
  if (recentTexts.length) {
    parts.push(`\n请避免与以下近期内容重复：\n${recentTexts.map((t, i) => `${i + 1}. ${t}`).join("\n")}`);
  }
  return parts.join("\n");
}

function splitMessages(messages = []) {
  const systemParts = [];
  const chatMessages = [];
  for (const message of messages) {
    if (message.role === "system") systemParts.push(message.content);
    else chatMessages.push(message);
  }
  return {
    system: systemParts.join("\n\n").trim(),
    messages: chatMessages,
  };
}

function mapHttpError(status, data, text, requestUrl = "") {
  if (status === 401) return new Error("AI API Key 无效或已过期");
  if (status === 429) return new Error("AI 调用频率超限，请稍后再试");
  const msg =
    data?.error?.message ||
    data?.message ||
    data?.error?.msg ||
    (typeof data?.error === "string" ? data.error : "") ||
    text?.slice(0, 200);
  const where = requestUrl ? ` → ${requestUrl}` : "";
  const detail = String(msg || "");

  if (/not supported by any configured account|no available channel|无可用渠道|模型.*不支持|Group .* not|分组/i.test(detail)) {
    return new Error(
      `当前 API Key 所在分组不支持该模型${where}。请到小宇宙后台查看该 Key 分组「可用模型」，把模型名改成列表里的原名（你的 Key 是 Codex 分组，不一定有 gpt-4o-mini）。详情：${detail}`,
    );
  }
  if (status === 404) {
    return new Error(
      `接口返回 404${where}。若提示模型不被支持，请更换模型名；若提示 Invalid URL，请检查 Base URL。详情：${detail || "无"}`,
    );
  }
  if (status === 502 || /Upstream service temporarily unavailable/i.test(detail)) {
    return new Error(
      `上游 AI 服务暂时不可用（502）${where}。多半是中转站该模型通道异常，不是本机代理问题。可换模型或稍后再试。详情：${detail || "无"}`,
    );
  }
  return new Error(`AI 调用失败 (${status})${where}: ${detail || "未知错误"}`);
}

async function callOpenAiCompatibleChat({ apiKey, baseUrl, model, messages, temperature = 0.92, maxTokens = 680 }) {
  const response = await requestJson(baseUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
    }),
  });

  if (response.status < 200 || response.status >= 300) {
    throw mapHttpError(response.status, response.data, response.text, `${baseUrl} [model=${model}]`);
  }

  const text = extractContent(response.data, "openai");
  if (!text) throw new Error("AI 未返回有效内容");
  return { text, finishReason: extractFinishReason(response.data, "openai"), raw: response.data };
}

async function callAnthropicChat({ apiKey, baseUrl, model, messages, temperature = 0.92, maxTokens = 680 }) {
  const { system, messages: chatMessages } = splitMessages(messages);
  const response = await requestJson(baseUrl, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature,
      ...(system ? { system } : {}),
      messages: chatMessages.map((message) => ({
        role: message.role === "assistant" ? "assistant" : "user",
        content: message.content,
      })),
    }),
  });

  if (response.status < 200 || response.status >= 300) {
    throw mapHttpError(response.status, response.data, response.text);
  }

  const text = extractContent(response.data, "anthropic");
  if (!text) throw new Error("AI 未返回有效内容");
  return { text, finishReason: extractFinishReason(response.data, "anthropic"), raw: response.data };
}

async function callGeminiChat({ apiKey, baseUrl, model, messages, temperature = 0.92, maxTokens = 680 }) {
  const { system, messages: chatMessages } = splitMessages(messages);
  const contents = chatMessages.map((message) => ({
    role: message.role === "assistant" ? "model" : "user",
    parts: [{ text: message.content }],
  }));

  const response = await requestJson(buildGeminiUrl(baseUrl, model, apiKey), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      contents,
      generationConfig: {
        temperature,
        maxOutputTokens: maxTokens,
      },
    }),
  });

  if (response.status < 200 || response.status >= 300) {
    throw mapHttpError(response.status, response.data, response.text);
  }

  const text = extractContent(response.data, "gemini");
  if (!text) throw new Error("AI 未返回有效内容");
  return { text, finishReason: extractFinishReason(response.data, "gemini"), raw: response.data };
}

export async function callAiChat({
  provider,
  baseUrl,
  apiKey,
  model,
  messages,
  temperature = 0.92,
  maxTokens = 680,
} = {}) {
  const runtime = resolveProviderRuntime({ provider, model, baseUrl });
  const payload = {
    apiKey,
    baseUrl: runtime.baseUrl,
    model: runtime.model,
    messages,
    temperature,
    maxTokens,
  };

  if (runtime.apiType === "anthropic") return callAnthropicChat(payload);
  if (runtime.apiType === "gemini") return callGeminiChat(payload);
  return callOpenAiCompatibleChat(payload);
}

/** @deprecated 保留旧名称，内部已走统一适配层 */
export async function callZhipuChat(options = {}) {
  return callAiChat({ ...options, provider: "zhipu" });
}

function isFatalAuthError(err) {
  const msg = String(err?.message || err || "");
  return /401|无效|过期|Unauthorized|Invalid API key|INVALID_API_KEY|未授权|Forbidden|403/i.test(msg);
}

function isGroupModelUnsupportedError(err) {
  const msg = String(err?.message || err || "");
  return /not supported by any configured account|no available channel|无可用渠道|模型.*不支持|Group .* not|分组不支持|所在分组不支持/i.test(
    msg,
  );
}

function shouldTryNextModel(err) {
  if (isFatalAuthError(err)) return false;
  const msg = String(err?.message || err || "");
  // 单个模型通道 502/不可用：继续试下一个模型（中转站常见）
  if (/上游 AI 服务暂时不可用|Upstream service temporarily unavailable|\(502\)|502\b/i.test(msg)) {
    return true;
  }
  // 真·全局网络/鉴权类问题才停（避免误匹配文案里的「不是本机代理问题」）
  if (
    /429|quota|余额|insufficient|rate limit|超时|timeout|ECONN|ENOTFOUND|network|证书|TLS|代理连接|代理失败|Socks5? 代理|VPN\/代理/i.test(
      msg,
    )
  ) {
    return false;
  }
  return /not supported by any configured account|no available channel|无可用渠道|模型.*不支持|Group .* not|分组不支持|所在分组不支持|接口返回 404|接口不存在（404）|model_not_found|does not exist|unknown model|invalid model|模型不存在|模型不可用|400|404|invalid_request|Parameter .+ model/i.test(
    msg,
  );
}

async function fetchRemoteModelIds(apiKey, chatCompletionsUrl) {
  const modelsUrl = toOpenAiModelsUrl(chatCompletionsUrl);
  if (!modelsUrl) return [];
  try {
    const response = await requestJson(modelsUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    });
    if (response.status < 200 || response.status >= 300) return [];
    const rows = Array.isArray(response.data?.data)
      ? response.data.data
      : Array.isArray(response.data)
        ? response.data
        : [];
    return rows
      .map((item) => String(item?.id || item?.model || "").trim())
      .filter(Boolean)
      .slice(0, 40);
  } catch {
    return [];
  }
}

async function buildAutoMatchCandidates(apiKey, baseUrl, preferredModel = "", providerId = "") {
  const provider = getAiProvider(providerId);
  const preferred = String(preferredModel || "").trim();
  const ordered = [];
  const push = (id) => {
    const model = String(id || "").trim();
    if (!model || ordered.includes(model)) return;
    ordered.push(model);
  };

  // 1) 用户刚输入/选中的
  push(preferred);
  // 2) 该服务商默认与官方列表（智谱/DeepSeek/通义等）
  push(provider.defaultModel);
  (provider.models || []).forEach((item) => push(item.id));

  // 3) 自定义 / OpenAI 兼容：优先用中转站返回的模型列表（对上 Key 分组）
  const useRemoteFallback =
    provider.id === "custom" ||
    provider.allowCustomModel ||
    provider.id === "openai" ||
    provider.id === "siliconflow";
  if (useRemoteFallback) {
    const remote = (await fetchRemoteModelIds(apiKey, baseUrl || provider.baseUrl)).filter(
      (id) => !/image|embedding|whisper|tts|dall-?e|moderation/i.test(id),
    );
    if (remote.length) {
      remote.forEach(push);
    } else {
      // 拉不到远程列表时，再退回通用候选
      AUTO_MATCH_MODEL_CANDIDATES.forEach(push);
    }
  }

  return ordered.slice(0, 24);
}

async function runConnectionProbe({ apiKey, provider, baseUrl, model }) {
  const result = await callAiChat({
    apiKey,
    provider,
    model,
    baseUrl,
    messages: [
      { role: "system", content: "你是一个测试助手。" },
      { role: "user", content: "请回复：连接成功" },
    ],
    temperature: 0.2,
    maxTokens: 32,
  });
  return { text: result.text, model };
}

export async function testAiApiKey(
  apiKey,
  { provider, model, baseUrl, autoMatch = true } = {},
) {
  const settings = readAiSettings();
  const resolvedProvider = provider || settings.provider;
  const providerMeta = getAiProvider(resolvedProvider);
  const resolvedBaseUrl = baseUrl ?? settings.baseUrl ?? providerMeta.baseUrl;
  const preferred = String(model || "").trim() || providerMeta.defaultModel || "";
  const shouldAutoMatch = autoMatch !== false;
  let preferredError = null;

  if (preferred) {
    try {
      const hit = await runConnectionProbe({
        apiKey,
        provider: resolvedProvider,
        baseUrl: resolvedBaseUrl,
        model: preferred,
      });
      return {
        ok: true,
        message: "AI API 连接成功",
        preview: hit.text,
        model: preferred,
        matchedModel: preferred,
        autoSwitched: false,
        provider: resolvedProvider,
      };
    } catch (err) {
      if (!shouldAutoMatch || !shouldTryNextModel(err)) {
        throw err;
      }
      preferredError = err;
    }
  } else if (!shouldAutoMatch) {
    throw new Error("请填写 AI 模型名");
  }

  const candidates = await buildAutoMatchCandidates(
    apiKey,
    resolvedBaseUrl,
    preferred,
    resolvedProvider,
  );
  const tried = [];
  for (const candidate of candidates) {
    if (preferred && candidate === preferred) continue;
    try {
      const hit = await runConnectionProbe({
        apiKey,
        provider: resolvedProvider,
        baseUrl: resolvedBaseUrl,
        model: candidate,
      });
      return {
        ok: true,
        message: preferred
          ? `已自动切换到可用模型 ${candidate}`
          : `已自动匹配可用模型 ${candidate}`,
        preview: hit.text,
        model: candidate,
        matchedModel: candidate,
        autoSwitched: true,
        preferredModel: preferred || "",
        triedModels: tried,
        provider: resolvedProvider,
      };
    } catch (err) {
      if (isFatalAuthError(err)) throw err;
      if (!shouldTryNextModel(err)) throw err;
      tried.push({ model: candidate, error: String(err.message || err).slice(0, 160) });
    }
  }

  const triedText = tried.length
    ? tried.map((item) => item.model).join("、")
    : "（无候选）";
  // 全部候选失败时：若用户指定模型是「分组不支持」，把该说明放前面，避免只看到最后一个 502
  if (preferredError && isGroupModelUnsupportedError(preferredError)) {
    throw new Error(
      `${preferredError.message}；已自动尝试其它模型仍失败：${triedText || "（无候选）"}。请到中转站后台把模型改成该 Key 分组「可用模型」列表中的原名。`,
    );
  }
  throw new Error(
    `自动匹配失败：当前 ${providerMeta.label} Key 下未找到可用模型。已尝试：${triedText}。请确认 Key 权限/分组后手动选择模型。`,
  );
}

export async function generateSquarePost({
  apiKey,
  provider,
  baseUrl,
  model,
  topic,
  systemPrompt,
  recentTexts = [],
  useNews = true,
  focusTokens = [],
  recentPairs = null,
  contentStyle = null,
  contentStyles = null,
  recentContentStyles = [],
  selectedTokens = null,
  marketSentiment = null,
  tokenIndex = 0,
  styleReferencesOverride = null,
  prepareImages = null,
} = {}) {
  const settings = readAiSettings();
  const styleReferences = styleReferencesOverride ?? settings.styleReferences ?? [];
  const shouldUseNews = useNews ?? settings.useNews !== false;
  const stylePool = resolveStylePoolForGeneration(contentStyles ?? settings.contentStyles, styleReferences);
  const resolvedStyle =
    contentStyle &&
    contentStyle !== RANDOM_CONTENT_STYLE_ID &&
    stylePool.includes(contentStyle)
      ? contentStyle
      : pickContentStyle(stylePool, recentContentStyles, styleReferences);
  const resolvedTokens = selectedTokens ?? settings.selectedTokens ?? [];
  const resolvedSentiment = marketSentiment ?? settings.marketSentiment ?? "auto";

  let context = null;
  let contextText = "";
  // 无论是否抓新闻，都必须拉取币安真实行情；无指定代币时默认 BTC/ETH，避免 AI 用训练记忆瞎编价格
  const explicitTokens = normalizeUserTokens(resolvedTokens);
  const defaultPreviewTokens = explicitTokens.length ? explicitTokens : ["BTC", "ETH"];

  if (shouldUseNews) {
    setAiRunProgress("market", "正在拉取行情与资讯…");
    // selectedTokens 只传用户真实选择；未选时交给 buildCryptoContext 按新闻选 focus，并预热 BTC/ETH 行情
    context = await buildCryptoContext({
      preferredTokens: focusTokens.length ? focusTokens : explicitTokens,
      selectedTokens: explicitTokens,
      recentPairs: recentPairs ?? settings.recentTokenPairs,
      marketSentiment: resolvedSentiment,
      tokenIndex,
    });
    // 参考范文风格：保留真实行情，弱化新闻，避免写成资讯长文而偏离范文结构
    if (isReferenceStyleId(resolvedStyle) && context) {
      const oneHeadline = context.leadArticle?.title || context.headlines?.[0] || "";
      context = {
        ...context,
        headlines: oneHeadline ? [oneHeadline] : [],
        leadArticle: oneHeadline
          ? { title: oneHeadline, imageUrl: context.leadArticle?.imageUrl || "" }
          : null,
      };
    }
  } else {
    setAiRunProgress("market", "正在拉取币安真实行情…");
    const focus =
      pickTokensFromUserSelection(defaultPreviewTokens, {
        index: tokenIndex,
        recentPairs: recentPairs ?? settings.recentTokenPairs,
      }) || defaultPreviewTokens.slice(0, 2);
    const { tickers, missing: missingTickers } = await fetchMarketTickers(focus);
    context = {
      focusTokens: focus,
      selectedTokens: explicitTokens,
      marketSentiment: resolvedSentiment,
      tickers,
      missingTickers,
      headlines: [],
      leadArticle: null,
      topic: `围绕 ${focus.map((t) => `$${t}`).join(" 和 ")} 的最新行情写帖`,
    };
  }

  // 行情拉取失败时再强补一轮（避免空行情导致出现 $26000 / $XX）
  if (!context?.tickers?.length) {
    const fallbackSymbols = [
      ...new Set([
        ...(context?.focusTokens || []),
        ...defaultPreviewTokens,
        ...(focusTokens || []),
        "BTC",
        "ETH",
      ]),
    ].filter(Boolean);
    const { tickers, missing: missingTickers } = await fetchMarketTickers(fallbackSymbols);
    context = {
      ...(context || {}),
      focusTokens: context?.focusTokens?.length ? context.focusTokens : fallbackSymbols.slice(0, 2),
      tickers,
      missingTickers,
    };
  }

  if (!context?.tickers?.length) {
    throw new Error("无法获取币安真实行情，请检查网络/代理后再生成（已阻止发出虚假价格）");
  }

  contextText = formatContextForPrompt(context);

  // 配图与 AI 写作并行：重点代币在写帖前已知，不必等全文写完
  const imageTask =
    typeof prepareImages === "function"
      ? prepareImages({
          focusTokens: context.focusTokens || [],
          newsImageUrl: context.leadArticle?.imageUrl || "",
        }).catch(() => [])
      : null;

  const resolvedTopic = topic || context?.topic || pickAiTopic(settings);
  const stylePrompt = getContentStylePrompt(resolvedStyle, styleReferences);
  setAiRunProgress(
    "ai",
    imageTask
      ? "正在请求 AI 写稿，并同步准备走势图/新闻配图…"
      : "正在请求 AI 写稿（主要耗时在此，请稍候）…",
  );
  const aiMessages = [
    { role: "system", content: systemPrompt || settings.systemPrompt || stylePrompt },
    {
      role: "user",
      content: buildUserPrompt({
        topic: resolvedTopic,
        contextText,
        recentTexts,
        contentStyle: resolvedStyle,
        styleReferences,
        marketSentiment: resolvedSentiment,
        tickers: context?.tickers || [],
      }),
    },
  ];
  let result = await callAiChat({
    apiKey: apiKey || settings.apiKey,
    provider: provider || settings.provider,
    baseUrl: baseUrl ?? settings.baseUrl,
    model: model || settings.model,
    messages: aiMessages,
  });

  let completionRecovered = false;
  if (isLikelyIncompletePost(result.text, result.finishReason)) {
    setAiRunProgress("ai", "检测到文案未写完，正在自动补全…");
    const continuation = await callAiChat({
      apiKey: apiKey || settings.apiKey,
      provider: provider || settings.provider,
      baseUrl: baseUrl ?? settings.baseUrl,
      model: model || settings.model,
      temperature: 0.68,
      maxTokens: 420,
      messages: [
        ...aiMessages,
        { role: "assistant", content: result.text },
        {
          role: "user",
          content:
            "上条文案没有完整收尾。只续写缺失部分，不要重复开头，不要引入新的代币或价格；补齐观点、风险提醒或结论，并用完整句子结束。",
        },
      ],
    });
    const completedText = mergeAiContinuation(result.text, continuation.text);
    if (isLikelyIncompletePost(completedText, continuation.finishReason)) {
      throw new Error("AI 文案连续两次未完整收尾，请稍后重试或更换模型");
    }
    result = { ...result, text: completedText, finishReason: continuation.finishReason };
    completionRecovered = true;
  }

  const tokens = context?.focusTokens || focusTokens;
  let text = ensureTokenTags(result.text, tokens);
  text = enforceTickerPrices(text, context?.tickers || [], tokens);
  text = fillPlaceholderArtifacts(text, context?.tickers || [], tokens);
  // 最终兜底：若仍含 $XX / XX 占位，直接用真实行情重写相关行情段
  text = scrubRemainingPlaceholders(text, context?.tickers || [], tokens);
  const styleMeta = getContentStyleMeta(resolvedStyle, styleReferences);
  if (imageTask) setAiRunProgress("images", "AI 写稿完成，等待配图收尾…");
  const imagePaths = imageTask ? await imageTask : [];

  return {
    text,
    topic: resolvedTopic,
    provider: provider || settings.provider,
    model: model || settings.model,
    focusTokens: tokens,
    contentStyle: resolvedStyle,
    contentStyleLabel: styleMeta.label,
    marketSentiment: context?.marketSentiment || resolvedSentiment,
    selectedTokens: context?.selectedTokens || normalizeUserTokens(resolvedTokens),
    newsHeadline: context?.leadArticle?.title || null,
    imagePaths,
    context,
    completionRecovered,
  };
}
