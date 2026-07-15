import https from "https";
import { readAiSettings, pickAiTopic } from "./ai-settings.js";
import { buildCryptoContext, formatContextForPrompt, pickTokensFromUserSelection, normalizeUserTokens, fetchMarketTickers, formatUsdPrice, getTokenAliases } from "./crypto-context.js";
import {
  pickContentStyle,
  getContentStylePrompt,
  getContentStyleUserHint,
  getContentStyleMeta,
  normalizeContentStyles,
  isReferenceStyleId,
} from "./ai-content-styles.js";
import { buildGeminiUrl, resolveProviderRuntime } from "./ai-providers.js";

const DEFAULT_SYSTEM_PROMPT = getContentStylePrompt("casual");

function requestJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const body = options.body ? Buffer.from(options.body) : null;
    const req = https.request(
      {
        hostname: target.hostname,
        port: 443,
        path: target.pathname + target.search,
        method: options.method || "GET",
        headers: {
          ...options.headers,
          ...(body ? { "Content-Length": body.length } : {}),
        },
        timeout: 90000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let data;
          try {
            data = JSON.parse(text);
          } catch {
            data = { raw: text };
          }
          resolve({ status: res.statusCode, data, text });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("AI 请求超时")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
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
  const focusSet = new Set((focusSymbols || []).map((s) => String(s).toUpperCase()));
  const activeTickers = tickers.filter((ticker) => {
    const symbol = String(ticker.symbol || "").toUpperCase();
    if (!symbol) return false;
    if (focusSet.size && !focusSet.has(symbol)) return false;
    return Number.isFinite(Number(ticker.price)) && Number(ticker.price) > 0;
  });
  if (!activeTickers.length) return text;

  let result = text;
  const allSymbols = activeTickers.map((t) => String(t.symbol).toUpperCase());

  for (const ticker of activeTickers) {
    const symbol = String(ticker.symbol || "").toUpperCase();
    const actual = Number(ticker.price);
    const formatted = formatUsdPrice(ticker.price);
    const changePct = Number(ticker.changePercent);
    const changeText = Number.isFinite(changePct)
      ? `${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%`
      : "";
    const support = formatUsdPrice(actual * 0.9);
    const resistance = formatUsdPrice(actual * 1.1);
    const sym = escapeRegExp(symbol);
    const others = allSymbols.filter((s) => s !== symbol).map(escapeRegExp);
    // 符号与价格之间不能再出现其他重点代币，避免串价
    const notOther = others.length
      ? `(?:(?!\\b(?:${others.join("|")})\\b)[\\s\\S]){0,120}?`
      : `[^$\\n]{0,120}?`;

    // 只用带 $ 的价格做邻近替换，避免把「24h」里的 24 误当成价格
    const nearPrice = new RegExp(
      `(\\$?${sym}\\b${notOther})(\\$\\s?[\\d,]+(?:\\.\\d+)?)`,
      "gi",
    );
    result = result.replace(nearPrice, (full, prefix) => {
      if (/(开盘|最高|最低|支撑|压力|阻力)\s*[:：]?\s*$/i.test(prefix)) return full;
      return `${prefix}$${formatted}`;
    });

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

  // 只填占位符（XX / $XX）
  const fillMoney = (labelPattern, value) => {
    result = result.replace(
      new RegExp(
        `(${labelPattern}\\s*[:：]?\\s*)(?:\\$\\s*)?X{1,6}(?:\\.X{1,4})?(?=\\s*[,，。.\\n]|$)`,
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
    /(涨跌幅|涨幅|跌幅)\s*[:：]?\s*(?:[+-]?X{1,6}%?|%)(?=\s*[,，。.\\n]|$)/gi,
    (_, label) => `${label}: ${change}`,
  );
  return result;
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

  // 先用主推代币填 OHLC 占位，避免 ETH 覆盖 BTC 行情段
  if (primary) {
    result = replaceLabeledOhlc(result, primary);
  }

  if (primary) {
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

    // $XX / XX / XXX / XXXX → 真实价格
    result = result.replace(/\$\s*X{1,6}\b/gi, () => `$${price}`);
    result = result.replace(/(^|[^\dA-Z$])X{2,6}(?:\.X{1,4})?\b/gi, (_, prefix) => `${prefix}$${price}`);
    if (change) {
      result = result.replace(/(^|[^\d])%[Xx]{1,4}%?/g, `$1${change}`);
      result = result.replace(/([:：]\s*)%[Xx]*\b/g, `$1${change}`);
    }
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
  let result = text;
  const allSymbols = tickers.map((t) => String(t.symbol).toUpperCase());
  const knownLevels = new Set();
  for (const ticker of tickers) {
    for (const key of ["price", "openPrice", "highPrice", "lowPrice"]) {
      const n = Number(ticker[key]);
      if (n > 0) {
        knownLevels.add(Number(n.toFixed(6)));
        knownLevels.add(Number(formatUsdPrice(n)));
      }
    }
  }

  for (const ticker of tickers) {
    const symbol = String(ticker.symbol || "").toUpperCase();
    const formatted = formatUsdPrice(ticker.price);
    const actual = Number(ticker.price);
    if (!(actual > 0)) continue;

    const aliases = getTokenAliases(symbol);
    const aliasPattern = aliases.map(escapeRegExp).join("|");
    const others = allSymbols.filter((s) => s !== symbol).map(escapeRegExp);
    const notOther = others.length
      ? `(?:(?!\\b(?:${others.join("|")})\\b)[\\s\\S]){0,160}?`
      : `[\\s\\S]{0,160}?`;

    // 跳过「开盘/最高/最低」标签后的价，避免把真 OHLC 改成现价
    const nearPrice = new RegExp(
      `((?:\\$?${escapeRegExp(symbol)}\\b|${aliasPattern})${notOther})(\\$\\s?[\\d,]+(?:\\.\\d+)?)`,
      "gi",
    );
    result = result.replace(nearPrice, (full, prefix, priceToken) => {
      if (/(开盘|最高|最低|支撑|压力|阻力)\s*[:：]?\s*$/i.test(prefix)) return full;
      const written = Number(String(priceToken).replace(/[$,\s]/g, ""));
      if (!Number.isFinite(written)) return full;
      // 已是真实行情档位（现价/开高低）则保留
      if (
        knownLevels.has(Number(written.toFixed(6))) ||
        Math.abs(written - actual) / actual <= 0.01
      ) {
        return full;
      }
      return `${prefix}$${formatted}`;
    });

    const nearBare = new RegExp(
      `((?:\\$?${escapeRegExp(symbol)}\\b|${aliasPattern})${notOther}(?:价格|现价|报价|约|在)\\s*)(\\d{3,7}(?:\\.\\d+)?)(?=\\s*(?:USDT|美元|附近|左右|美金)?)`,
      "gi",
    );
    result = result.replace(nearBare, (full, prefix, num) => {
      if (/(开盘|最高|最低|支撑|压力|阻力)\s*[:：]?\s*$/i.test(prefix)) return full;
      const written = Number(num);
      if (!Number.isFinite(written)) return full;
      if (
        knownLevels.has(Number(written.toFixed(6))) ||
        Math.abs(written - actual) / actual <= 0.01
      ) {
        return full;
      }
      return `${prefix}${formatted}`;
    });
  }

  return result;
}

function scrubRemainingPlaceholders(text, tickers = [], focusSymbols = []) {
  if (!text) return text;
  let result = String(text);
  const ordered = pickActiveTickers(tickers, focusSymbols);
  if (!ordered.length) return result;

  if (/\$\s*X{1,6}\b|开盘(?:价)?\s*[:：]?\s*\$?\s*X{1,6}|涨跌幅\s*[:：]?\s*%/i.test(result)) {
    result = replaceLabeledOhlc(result, ordered[0]);
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
  if (status === 404) {
    return new Error(
      `接口不存在（404）${where}。请确认：① Base URL 为 https://域名/v1/chat/completions；②「自定义模型名」已填写该平台支持的模型（如 gpt-4o-mini），不要留空；③ Key 分组确实开通了该模型。详情：${msg || "无"}`,
    );
  }
  return new Error(`AI 调用失败 (${status})${where}: ${msg || "未知错误"}`);
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
  return { text, raw: response.data };
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
  return { text, raw: response.data };
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
  return { text, raw: response.data };
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

export async function testAiApiKey(apiKey, { provider, model, baseUrl } = {}) {
  const settings = readAiSettings();
  const result = await callAiChat({
    apiKey,
    provider: provider || settings.provider,
    model: model || settings.model,
    baseUrl: baseUrl ?? settings.baseUrl,
    messages: [
      { role: "system", content: "你是一个测试助手。" },
      { role: "user", content: "请回复：连接成功" },
    ],
    temperature: 0.2,
    maxTokens: 32,
  });
  return { ok: true, message: "AI API 连接成功", preview: result.text };
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
} = {}) {
  const settings = readAiSettings();
  const styleReferences = styleReferencesOverride ?? settings.styleReferences ?? [];
  const shouldUseNews = useNews ?? settings.useNews !== false;
  const stylePool = normalizeContentStyles(contentStyles ?? settings.contentStyles, styleReferences);
  const resolvedStyle = contentStyle && stylePool.includes(contentStyle)
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
    context = await buildCryptoContext({
      preferredTokens: focusTokens.length ? focusTokens : defaultPreviewTokens,
      selectedTokens: explicitTokens.length ? explicitTokens : defaultPreviewTokens,
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
        leadArticle: oneHeadline ? { title: oneHeadline } : null,
      };
    }
  } else {
    const focus =
      pickTokensFromUserSelection(defaultPreviewTokens, { index: tokenIndex }) ||
      defaultPreviewTokens.slice(0, 2);
    const { tickers, missing: missingTickers } = await fetchMarketTickers([
      ...new Set([...focus, ...defaultPreviewTokens]),
    ]);
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

  const resolvedTopic = topic || context?.topic || pickAiTopic(settings);
  const stylePrompt = getContentStylePrompt(resolvedStyle, styleReferences);
  const result = await callAiChat({
    apiKey: apiKey || settings.apiKey,
    provider: provider || settings.provider,
    baseUrl: baseUrl ?? settings.baseUrl,
    model: model || settings.model,
    messages: [
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
    ],
  });

  const tokens = context?.focusTokens || focusTokens;
  let text = ensureTokenTags(result.text, tokens);
  text = enforceTickerPrices(text, context?.tickers || [], tokens);
  text = fillPlaceholderArtifacts(text, context?.tickers || [], tokens);
  // 最终兜底：若仍含 $XX / XX 占位，直接用真实行情重写相关行情段
  text = scrubRemainingPlaceholders(text, context?.tickers || [], tokens);
  const styleMeta = getContentStyleMeta(resolvedStyle, styleReferences);

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
    context,
  };
}
