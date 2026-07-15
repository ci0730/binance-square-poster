import https from "https";
import { readAiSettings, pickAiTopic } from "./ai-settings.js";
import { buildCryptoContext, formatContextForPrompt, pickTokensFromUserSelection, normalizeUserTokens, fetchMarketTickers, formatUsdPrice } from "./crypto-context.js";
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

    // 用回调替换，避免 `$1$2,879` 被当成捕获组 $2 而把价格截断成 `,879`
    const nearPrice = new RegExp(
      `(\\$?${sym}\\b${notOther})(\\$\\s?[\\d,]+(?:\\.\\d+)?|[\\d,]+(?:\\.\\d+)?)`,
      "gi",
    );
    result = result.replace(nearPrice, (_, prefix) => `${prefix}$${formatted}`);

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

/** 清掉范文占位符残留：XXXX / XX.XX / 2026.XX.XX 等 */
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
  // 单独的 XX.XX：标题日期场景用月.日（不用 lookbehind，兼容旧 Node）
  result = result.replace(/(^|[^\d$])XX\.XX(?![\d%])/g, `$1${dateMd}`);

  const focusSet = new Set((focusSymbols || []).map((s) => String(s).toUpperCase()));
  const ordered = (tickers || []).filter((t) => {
    const symbol = String(t.symbol || "").toUpperCase();
    const price = Number(t.price);
    if (!symbol || !(price > 0)) return false;
    if (focusSet.size && !focusSet.has(symbol)) return false;
    return true;
  });
  const primary = ordered[0];
  if (primary) {
    const actual = Number(primary.price);
    const price = formatUsdPrice(actual);
    const support = formatUsdPrice(actual * 0.97);
    const resistance = formatUsdPrice(actual * 1.03);

    result = result.replace(
      /关键支撑\s*[:：]?\s*\$?\s*(?:X{2,4}|x{2,4})\b/gi,
      () => `关键支撑:$${support}`,
    );
    result = result.replace(
      /关键压力\s*[:：]?\s*\$?\s*(?:X{2,4}|x{2,4})\b/gi,
      () => `关键压力:$${resistance}`,
    );
    result = result.replace(/支撑(?:位)?\s*[:：]?\s*\$?\s*(?:X{2,4}|x{2,4})\b/gi, () => `支撑:$${support}`);
    result = result.replace(/(?:压力|阻力)(?:位)?\s*[:：]?\s*\$?\s*(?:X{2,4}|x{2,4})\b/gi, () => `压力:$${resistance}`);
    result = result.replace(/\$?\s*X{3,4}\b/gi, () => `$${price}`);
  }

  // 仍残留的纯 X 占位直接去掉，避免发到广场
  result = result.replace(/\b20\d{2}\s*[.／/]\s*X+\s*[.／/]\s*X+\b/gi, dateFull);
  result = result.replace(/(^|[^\d$])X{2,4}(?:\.X{1,4})?\b/gi, "$1");
  result = result.replace(/([:：])\s*(?=\s|[，。,.!]|$)/g, "$1");
  // 清理重复的「代币（市场）」标签，以及被旧逻辑截断的价格前缀
  result = result.replace(
    /(\b[A-Z0-9]{2,10}[（(][^）)]+[）)]\s*[:：]\s*)\1+/g,
    "$1",
  );
  return result.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
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
  parts.push("严禁输出 XXXX、XX.XX、XXX、2026.XX.XX 等占位符；日期与支撑/压力必须是可阅读的真实值。");
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

function mapHttpError(status, data, text) {
  if (status === 401) return new Error("AI API Key 无效或已过期");
  if (status === 429) return new Error("AI 调用频率超限，请稍后再试");
  const msg =
    data?.error?.message ||
    data?.message ||
    data?.error?.msg ||
    (typeof data?.error === "string" ? data.error : "") ||
    text?.slice(0, 200);
  return new Error(`AI 调用失败 (${status}): ${msg || "未知错误"}`);
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
    throw mapHttpError(response.status, response.data, response.text);
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
  if (shouldUseNews) {
    context = await buildCryptoContext({
      preferredTokens: focusTokens,
      selectedTokens: resolvedTokens,
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
    contextText = formatContextForPrompt(context);
  } else if (resolvedTokens.length) {
    const explicit = normalizeUserTokens(resolvedTokens);
    const focus = pickTokensFromUserSelection(explicit, { index: tokenIndex }) || explicit.slice(0, 2);
    const { tickers, missing: missingTickers } = await fetchMarketTickers([...new Set([...focus, ...explicit])]);
    context = {
      focusTokens: focus,
      selectedTokens: explicit,
      marketSentiment: resolvedSentiment,
      tickers,
      missingTickers,
      headlines: [],
      leadArticle: null,
    };
    contextText = formatContextForPrompt(context);
  }

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
