export const AI_PROVIDERS = [
  {
    id: "zhipu",
    label: "智谱 AI",
    apiType: "openai",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    keyHint: "智谱 AI API Key",
    keyUrl: "https://open.bigmodel.cn/usercenter/apikeys",
    defaultModel: "glm-4-flash",
    models: [
      { id: "glm-4-flash", label: "glm-4-flash（推荐，速度快）" },
      { id: "glm-4-air", label: "glm-4-air" },
      { id: "glm-4-plus", label: "glm-4-plus" },
      { id: "glm-4", label: "glm-4" },
    ],
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    apiType: "openai",
    baseUrl: "https://api.deepseek.com/chat/completions",
    keyHint: "DeepSeek API Key",
    keyUrl: "https://platform.deepseek.com/api_keys",
    defaultModel: "deepseek-chat",
    models: [
      { id: "deepseek-chat", label: "deepseek-chat（推荐）" },
      { id: "deepseek-reasoner", label: "deepseek-reasoner（推理）" },
    ],
  },
  {
    id: "openai",
    label: "OpenAI",
    apiType: "openai",
    baseUrl: "https://api.openai.com/v1/chat/completions",
    keyHint: "OpenAI API Key",
    keyUrl: "https://platform.openai.com/api-keys",
    defaultModel: "gpt-4o-mini",
    models: [
      { id: "gpt-4o-mini", label: "gpt-4o-mini（推荐，性价比高）" },
      { id: "gpt-4o", label: "gpt-4o" },
      { id: "gpt-4.1-mini", label: "gpt-4.1-mini" },
      { id: "gpt-4.1", label: "gpt-4.1" },
      { id: "o3-mini", label: "o3-mini（推理）" },
    ],
  },
  {
    id: "qwen",
    label: "通义千问",
    apiType: "openai",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    keyHint: "通义千问 API Key",
    keyUrl: "https://bailian.console.aliyun.com/",
    defaultModel: "qwen-plus",
    models: [
      { id: "qwen-turbo", label: "qwen-turbo（速度快）" },
      { id: "qwen-plus", label: "qwen-plus（推荐）" },
      { id: "qwen-max", label: "qwen-max" },
      { id: "qwen-long", label: "qwen-long（长文本）" },
    ],
  },
  {
    id: "moonshot",
    label: "Moonshot / Kimi",
    apiType: "openai",
    baseUrl: "https://api.moonshot.cn/v1/chat/completions",
    keyHint: "Moonshot API Key",
    keyUrl: "https://platform.moonshot.cn/console/api-keys",
    defaultModel: "moonshot-v1-8k",
    models: [
      { id: "moonshot-v1-8k", label: "moonshot-v1-8k" },
      { id: "moonshot-v1-32k", label: "moonshot-v1-32k" },
      { id: "moonshot-v1-128k", label: "moonshot-v1-128k" },
    ],
  },
  {
    id: "doubao",
    label: "豆包（火山方舟）",
    apiType: "openai",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
    keyHint: "火山方舟 API Key",
    keyUrl: "https://console.volcengine.com/ark",
    defaultModel: "doubao-1-5-pro-32k-250115",
    models: [
      { id: "doubao-1-5-pro-32k-250115", label: "Doubao 1.5 Pro 32K" },
      { id: "doubao-1-5-lite-32k-250115", label: "Doubao 1.5 Lite 32K" },
      { id: "deepseek-v3-250324", label: "DeepSeek V3（方舟接入）" },
    ],
  },
  {
    id: "siliconflow",
    label: "SiliconFlow",
    apiType: "openai",
    baseUrl: "https://api.siliconflow.cn/v1/chat/completions",
    keyHint: "SiliconFlow API Key",
    keyUrl: "https://cloud.siliconflow.cn/account/ak",
    defaultModel: "deepseek-ai/DeepSeek-V3",
    models: [
      { id: "deepseek-ai/DeepSeek-V3", label: "DeepSeek V3" },
      { id: "Qwen/Qwen2.5-72B-Instruct", label: "Qwen 2.5 72B" },
      { id: "THUDM/glm-4-9b-chat", label: "GLM-4 9B" },
      { id: "Pro/Qwen/Qwen2.5-7B-Instruct", label: "Qwen 2.5 7B" },
    ],
  },
  {
    id: "anthropic",
    label: "Anthropic Claude",
    apiType: "anthropic",
    baseUrl: "https://api.anthropic.com/v1/messages",
    keyHint: "Anthropic API Key",
    keyUrl: "https://console.anthropic.com/settings/keys",
    defaultModel: "claude-sonnet-4-20250514",
    models: [
      { id: "claude-sonnet-4-20250514", label: "Claude Sonnet 4（推荐）" },
      { id: "claude-3-5-haiku-20241022", label: "Claude 3.5 Haiku（快速）" },
      { id: "claude-3-5-sonnet-20241022", label: "Claude 3.5 Sonnet" },
    ],
  },
  {
    id: "gemini",
    label: "Google Gemini",
    apiType: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/models",
    keyHint: "Google AI Studio API Key",
    keyUrl: "https://aistudio.google.com/apikey",
    defaultModel: "gemini-2.0-flash",
    models: [
      { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash（推荐）" },
      { id: "gemini-2.5-flash-preview-05-20", label: "Gemini 2.5 Flash Preview" },
      { id: "gemini-1.5-pro", label: "Gemini 1.5 Pro" },
    ],
  },
  {
    id: "custom",
    label: "自定义（OpenAI 兼容）",
    apiType: "openai",
    baseUrl: "",
    keyHint: "API Key",
    keyUrl: "",
    defaultModel: "",
    models: [],
    allowCustomBaseUrl: true,
    allowCustomModel: true,
  },
];

const providerMap = new Map(AI_PROVIDERS.map((item) => [item.id, item]));

export function getAiProvider(providerId) {
  return providerMap.get(providerId) || providerMap.get("zhipu");
}

export function listAiProvidersPublic() {
  return AI_PROVIDERS.map(({ id, label, models, keyHint, keyUrl, defaultModel, allowCustomBaseUrl, allowCustomModel }) => ({
    id,
    label,
    models,
    keyHint,
    keyUrl,
    defaultModel,
    allowCustomBaseUrl: Boolean(allowCustomBaseUrl),
    allowCustomModel: Boolean(allowCustomModel),
  }));
}

export function normalizeAiProviderId(providerId) {
  return providerMap.has(providerId) ? providerId : "zhipu";
}

export function normalizeAiModel(providerId, model, baseUrl = "") {
  const provider = getAiProvider(providerId);
  const trimmed = String(model || "").trim();
  if (provider.id === "custom") {
    return trimmed;
  }
  if (trimmed && provider.models.some((item) => item.id === trimmed)) return trimmed;
  if (trimmed) return trimmed;
  return provider.defaultModel;
}

export function normalizeCustomOpenAiBaseUrl(baseUrl = "") {
  let url = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!url) return "";
  // 用户常只填官网根域名，OpenAI 兼容接口需落到 chat/completions
  if (!/\/(chat\/completions|responses|messages)(\/|$)/i.test(url)) {
    if (/\/v1$/i.test(url)) url = `${url}/chat/completions`;
    else url = `${url}/v1/chat/completions`;
  }
  return url;
}

export function resolveProviderRuntime({ provider: providerId, model, baseUrl = "" } = {}) {
  const provider = getAiProvider(providerId);
  const resolvedModel = normalizeAiModel(provider.id, model, baseUrl);
  let resolvedBaseUrl =
    provider.id === "custom"
      ? normalizeCustomOpenAiBaseUrl(baseUrl)
      : provider.baseUrl;

  if (provider.id === "custom" && !resolvedBaseUrl) {
    throw new Error("自定义服务商需填写 API Base URL");
  }
  if (!resolvedModel) {
    throw new Error("请选择或填写 AI 模型");
  }

  return {
    provider: provider.id,
    providerLabel: provider.label,
    apiType: provider.apiType,
    baseUrl: resolvedBaseUrl,
    model: resolvedModel,
  };
}

export function buildGeminiUrl(baseUrl, model, apiKey) {
  const root = String(baseUrl || "https://generativelanguage.googleapis.com/v1beta/models").replace(/\/$/, "");
  return `${root}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
}
