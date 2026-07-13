import https from "https";
import { readAiSettings, pickAiTopic } from "./ai-settings.js";
import { buildCryptoContext, formatContextForPrompt, pickTokensFromUserSelection, normalizeUserTokens, fetchMarketTickers, formatUsdPrice } from "./crypto-context.js";
import {
  pickContentStyle,
  getContentStylePrompt,
  getContentStyleUserHint,
  getContentStyleMeta,
  normalizeContentStyles,
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
    .replace(/\s+/g, " ")
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
  body = body.replace(/\s+/g, " ").trim();

  const tail = normalized.map((t) => `$${t}`).join(" ");
  return `${body} ${tail}`.trim();
}

function isPriceConsistentWithTicker(value, tickerPrice) {
  const num = Number(value);
  const actual = Number(tickerPrice);
  if (!Number.isFinite(num) || !Number.isFinite(actual) || actual <= 0) return false;
  const ratio = num / actual;
  return ratio >= 0.5 && ratio <= 2;
}

function enforceTickerPrices(text, tickers = [], focusSymbols = []) {
  if (!tickers?.length || !text) return text;
  const focusSet = new Set((focusSymbols || []).map((s) => String(s).toUpperCase()));
  let result = text;

  for (const ticker of tickers) {
    const symbol = String(ticker.symbol || "").toUpperCase();
    if (focusSet.size && !focusSet.has(symbol)) continue;

    const actual = Number(ticker.price);
    if (!Number.isFinite(actual) || actual <= 0) continue;
    const formatted = formatUsdPrice(ticker.price);
    const support = formatUsdPrice(actual * 0.9);
    const resistance = formatUsdPrice(actual * 1.1);

    result = result.replace(/(支撑位[^\$]{0,24})\$\s?[\d.,]+/gi, `$1$${support}`);
    result = result.replace(/(阻力[^\$]{0,24})\$\s?[\d.,]+/gi, `$1$${resistance}`);
    result = result.replace(/\$\s?([\d,]+(?:\.\d+)?)/g, (match, numStr) => {
      const num = parseFloat(String(numStr).replace(/,/g, ""));
      if (!Number.isFinite(num)) return match;
      if (isPriceConsistentWithTicker(num, actual)) return `$${formatted}`;
      return `$${formatted}`;
    });
  }

  return result.replace(/\s+/g, " ").trim();
}

function buildUserPrompt({ topic, contextText, recentTexts = [], contentStyle = "casual", marketSentiment = "auto", tickers = [] }) {
  const parts = [`请写一条币安广场短帖。`];
  if (topic) parts.push(`主题方向：${topic}`);
  if (contextText) parts.push(`\n${contextText}`);
  parts.push(`\n要求：${getContentStyleUserHint(contentStyle)}`);
  if (marketSentiment === "bullish") {
    parts.push("本篇必须明确表达看多观点，语气积极但不过度夸张。");
  } else if (marketSentiment === "bearish") {
    parts.push("本篇必须明确表达看空或谨慎观点，语气理性但不制造恐慌。");
  }
  parts.push("注意：只能使用【本篇重点代币】中的代币标签，不要使用其他 $代币。");
  parts.push("若背景提供了【24h 行情】，正文中的价格、涨跌幅必须与该数据完全一致，禁止编造或使用其他同名代币价格。");
  parts.push("若背景未提供具体价格，正文中不要出现具体美元价格、支撑位、阻力位等数字。");
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
} = {}) {
  const settings = readAiSettings();
  const shouldUseNews = useNews ?? settings.useNews !== false;
  const stylePool = normalizeContentStyles(contentStyles ?? settings.contentStyles);
  const resolvedStyle = contentStyle && stylePool.includes(contentStyle)
    ? contentStyle
    : pickContentStyle(stylePool, recentContentStyles);
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
  const stylePrompt = getContentStylePrompt(resolvedStyle);
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
          marketSentiment: resolvedSentiment,
          tickers: context?.tickers || [],
        }),
      },
    ],
  });

  const tokens = context?.focusTokens || focusTokens;
  let text = ensureTokenTags(result.text, tokens);
  text = enforceTickerPrices(text, context?.tickers || [], tokens);
  const styleMeta = getContentStyleMeta(resolvedStyle);

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
