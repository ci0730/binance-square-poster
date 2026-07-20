import fs from "fs";
import path from "path";
import { getConfigDir } from "./app-paths.js";
import {
  DEFAULT_CONTENT_STYLES,
  normalizeContentStyles,
  normalizeStyleReferences,
  listContentStyleOptions,
} from "./ai-content-styles.js";
import {
  MAINSTREAM_POOL,
  normalizeUserTokens,
  splitPresetAndCustomTokens,
  normalizeTokenMode,
  TOKEN_MODE_RANDOM_ALL,
} from "./crypto-context.js";
import {
  getAiProvider,
  listAiProvidersPublic,
  normalizeAiModel,
  normalizeAiProviderId,
} from "./ai-providers.js";
import { listAccountsPublic } from "./accounts.js";
import { getAccountsPostMetricsMap } from "./post-cache.js";

export const MARKET_SENTIMENT_OPTIONS = [
  { id: "auto", label: "自动（跟随行情）" },
  { id: "bullish", label: "看多" },
  { id: "bearish", label: "看空" },
];

const aiSettingsFile = () => path.join(getConfigDir(), "ai-settings.json");

export const DEFAULT_AI_SETTINGS = {
  enabled: false,
  provider: "zhipu",
  baseUrl: "",
  apiKey: "",
  model: "glm-4-flash",
  topic: "结合最新加密资讯，分享代币观点并引导用户关注行情",
  topics: [],
  systemPrompt: "",
  useNews: true,
  contentStyles: [...DEFAULT_CONTENT_STYLES],
  selectedTokens: [],
  customTokens: [],
  marketSentiment: "auto",
  accountId: null,
  hostedAccounts: [],
  hostRotationIndex: 0,
  hostConcurrency: 3,
  aiProfiles: [],
  defaultAiProfileId: null,
  autoPublish: true,
  attachRelatedImages: true,
  preventDuplicatePosts: true,
  styleReferences: [],
  intervalMinutes: 60,
  intervalMinMinutes: 30,
  intervalMaxMinutes: 60,
  /** 本轮等待已抽取的分钟数（min～max 随机），避免每次探测都重抽 */
  nextIntervalMinutes: null,
  postsPerRun: 1,
  publishDelayMinSeconds: 30,
  publishDelayMaxSeconds: 60,
  maxPostsPerDay: 10,
  lastRunAt: null,
  lastSuccessAt: null,
  lastError: null,
  /** API 连接探测结果（与托管任务 lastError / lastSuccessAt 分离） */
  lastConnectionTestAt: null,
  lastConnectionTestOk: null,
  lastConnectionTestError: null,
  lastConnectionTestProfileId: null,
  todayPublished: 0,
  /** 各账号今日已发条数，key=accountId */
  todayPublishedByAccount: {},
  todayDate: null,
  totalPublished: 0,
  recentTokenPairs: [],
};

function maskApiKey(apiKey) {
  if (!apiKey) return "";
  if (apiKey.length <= 9) return `${apiKey.slice(0, 2)}...`;
  return `${apiKey.slice(0, 5)}...${apiKey.slice(-4)}`;
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function generateAiProfileId() {
  return `aip_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeAiProfile(raw = {}) {
  const provider = normalizeAiProviderId(raw.provider || "zhipu");
  const baseUrl = String(raw.baseUrl || "").trim();
  const model = normalizeAiModel(provider, raw.model, baseUrl);
  const id = String(raw.id || generateAiProfileId()).trim();
  const name = String(raw.name || getAiProvider(provider).label).trim() || getAiProvider(provider).label;
  return {
    id,
    name,
    enabled: raw.enabled !== false,
    provider,
    baseUrl,
    apiKey: String(raw.apiKey || "").trim(),
    model,
    createdAt: raw.createdAt || Date.now(),
  };
}

function migrateAiProfiles(settings) {
  let profiles = [];
  if (Array.isArray(settings.aiProfiles) && settings.aiProfiles.length) {
    profiles = settings.aiProfiles.map((item) => normalizeAiProfile(item)).filter(Boolean);
  } else if (settings.apiKey || settings.provider) {
    profiles = [
      normalizeAiProfile({
        id: settings.defaultAiProfileId || generateAiProfileId(),
        name: `${getAiProvider(settings.provider || "zhipu").label}（默认）`,
        enabled: true,
        provider: settings.provider,
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        model: settings.model,
      }),
    ];
  }

  const legacyKey = String(settings.apiKey || "").trim();
  if (legacyKey && !profiles.some((item) => item.apiKey)) {
    if (!profiles.length) {
      profiles = [
        normalizeAiProfile({
          id: settings.defaultAiProfileId || generateAiProfileId(),
          name: `${getAiProvider(settings.provider || "zhipu").label}（默认）`,
          enabled: true,
          provider: settings.provider,
          baseUrl: settings.baseUrl,
          apiKey: legacyKey,
          model: settings.model,
        }),
      ];
    } else {
      const index = profiles.findIndex((item) => item.id === settings.defaultAiProfileId);
      const targetIndex = index >= 0 ? index : 0;
      profiles[targetIndex] = normalizeAiProfile({
        ...profiles[targetIndex],
        apiKey: legacyKey,
        provider: profiles[targetIndex].provider || settings.provider,
        baseUrl: profiles[targetIndex].baseUrl || settings.baseUrl,
        model: profiles[targetIndex].model || settings.model,
      });
    }
  }

  return profiles;
}

function syncLegacyFieldsFromDefaultProfile(settings) {
  const profile = resolveAiProfile(settings.defaultAiProfileId, settings);
  if (!profile) return;
  settings.provider = profile.provider;
  settings.baseUrl = profile.baseUrl;
  settings.model = profile.model;
  if (profile.apiKey) settings.apiKey = profile.apiKey;
}

export function getEnabledAiProfiles(settings = readAiSettings()) {
  return (settings.aiProfiles || []).filter((item) => item.enabled && item.apiKey);
}

export function hasAnyAiProfileConfigured(settings = readAiSettings()) {
  return (settings.aiProfiles || []).some((item) => item.apiKey);
}

export function resolveAiProfile(profileId, settings = readAiSettings()) {
  const profiles = settings.aiProfiles || [];
  if (profileId) return profiles.find((item) => item.id === profileId) || null;
  if (settings.defaultAiProfileId) {
    return profiles.find((item) => item.id === settings.defaultAiProfileId) || null;
  }
  return getEnabledAiProfiles(settings)[0] || profiles[0] || null;
}

export function resolveAiCredentials({
  profileId,
  hostConfig,
  settings = readAiSettings(),
  overrides = {},
  allowEmptyModel = false,
} = {}) {
  const targetId = overrides.aiProfileId || hostConfig?.aiProfileId || profileId || null;
  let profile = targetId ? resolveAiProfile(targetId, settings) : null;
  if (!profile?.apiKey && !String(overrides.apiKey || "").trim()) {
    profile = getEnabledAiProfiles(settings)[0] || resolveAiProfile(settings.defaultAiProfileId, settings);
  }

  const apiKey = String(overrides.apiKey || "").trim() || profile?.apiKey || settings.apiKey;
  if (!apiKey) throw new Error("请先配置 AI API Key");

  // 弹窗「测试连接」会显式传 provider/baseUrl/model：不要再偷偷回落到默认智谱模型
  const hasExplicitProvider = Object.prototype.hasOwnProperty.call(overrides, "provider") && overrides.provider;
  const useProfileCreds = Boolean(targetId && profile?.id === targetId) && !hasExplicitProvider;

  const provider = normalizeAiProviderId(
    useProfileCreds
      ? profile?.provider || settings.provider
      : overrides.provider || profile?.provider || settings.provider,
  );

  const overrideBase = Object.prototype.hasOwnProperty.call(overrides, "baseUrl")
    ? String(overrides.baseUrl || "").trim()
    : "";
  const baseUrl = useProfileCreds
    ? profile?.baseUrl ?? settings.baseUrl ?? ""
    : overrideBase || profile?.baseUrl || settings.baseUrl || "";

  const overrideModel = Object.prototype.hasOwnProperty.call(overrides, "model")
    ? String(overrides.model || "").trim()
    : "";
  let model = useProfileCreds
    ? String(profile?.model || settings.model || "").trim()
    : overrideModel || (!hasExplicitProvider ? String(profile?.model || settings.model || "").trim() : "");

  model = normalizeAiModel(provider, model, baseUrl);
  if (!model && !allowEmptyModel) {
    throw new Error("请选择或填写 AI 模型");
  }

  return {
    aiProfileId: profile?.id || null,
    apiKey,
    provider,
    baseUrl,
    model,
    providerLabel: getAiProvider(provider).label,
    profileName: profile?.name || getAiProvider(provider).label,
  };
}

function normalizeHostedAccount(raw = {}, legacyDefaults = {}, styleReferences = []) {
  const accountId = String(raw.accountId || "").trim();
  if (!accountId) return null;

  const selectedTokens = normalizeUserTokens(raw.selectedTokens ?? legacyDefaults.selectedTokens ?? []);
  let customTokens = normalizeUserTokens(raw.customTokens ?? legacyDefaults.customTokens ?? []);
  if (!customTokens.length && selectedTokens.length) {
    customTokens = splitPresetAndCustomTokens(selectedTokens, MAINSTREAM_POOL).custom;
  }

  const tokenMode = normalizeTokenMode(
    raw.tokenMode ?? legacyDefaults.tokenMode,
    selectedTokens,
  );
  // 每次全市场随机时不保留固定列表，避免误当成指定币
  const tokensForMode =
    tokenMode === TOKEN_MODE_RANDOM_ALL ? [] : selectedTokens;

  return {
    accountId,
    enabled: Boolean(raw.enabled),
    aiProfileId: String(raw.aiProfileId || "").trim() || null,
    tokenMode,
    selectedTokens: tokensForMode,
    customTokens: tokenMode === TOKEN_MODE_RANDOM_ALL ? [] : customTokens,
    marketSentiment: ["auto", "bullish", "bearish"].includes(raw.marketSentiment)
      ? raw.marketSentiment
      : legacyDefaults.marketSentiment || "auto",
    contentStyles: normalizeContentStyles(
      raw.contentStyles ?? legacyDefaults.contentStyles ?? DEFAULT_CONTENT_STYLES,
      styleReferences,
    ),
  };
}

function migrateHostedAccounts(settings) {
  const refs = normalizeStyleReferences(settings.styleReferences);
  if (Array.isArray(settings.hostedAccounts) && settings.hostedAccounts.length) {
    return settings.hostedAccounts
      .map((item) => normalizeHostedAccount(item, {}, refs))
      .filter(Boolean);
  }

  const legacyDefaults = {
    tokenMode: settings.tokenMode,
    selectedTokens: settings.selectedTokens,
    customTokens: settings.customTokens,
    marketSentiment: settings.marketSentiment,
    contentStyles: settings.contentStyles,
  };
  const accountId = settings.accountId || listAccountsPublic().defaultAccountId;
  if (!accountId) return [];
  const migrated = normalizeHostedAccount(
    { accountId, enabled: true, ...legacyDefaults },
    legacyDefaults,
    refs,
  );
  return migrated ? [migrated] : [];
}

function syncHostedAccountsWithAccountList(hostedAccounts, accounts, styleReferences = []) {
  const map = new Map(hostedAccounts.map((item) => [item.accountId, item]));
  return accounts
    .map((acc) => {
      const existing = map.get(acc.id);
      if (existing) return normalizeHostedAccount(existing, {}, styleReferences);
      return normalizeHostedAccount({ accountId: acc.id, enabled: false }, {}, styleReferences);
    })
    .filter(Boolean);
}

export function getEnabledHostedAccounts(settings = readAiSettings()) {
  const refs = normalizeStyleReferences(settings.styleReferences);
  return syncHostedAccountsWithAccountList(
    migrateHostedAccounts(settings),
    listAccountsPublic().accounts,
    refs,
  ).filter((item) => item.enabled);
}

export function getHostedAccountConfig(accountId, settings = readAiSettings()) {
  const accounts = listAccountsPublic().accounts;
  const refs = normalizeStyleReferences(settings.styleReferences);
  const hosted = syncHostedAccountsWithAccountList(migrateHostedAccounts(settings), accounts, refs);
  return hosted.find((item) => item.accountId === accountId) || null;
}

export function peekNextHostedAccount(settings = readAiSettings()) {
  const enabled = getEnabledHostedAccounts(settings);
  if (!enabled.length) return null;
  const index = Math.abs(parseInt(settings.hostRotationIndex, 10) || 0) % enabled.length;
  return enabled[index];
}

/** 预览下一批托管账号（不推进旋转下标） */
export function peekNextHostedBatch(settings = readAiSettings(), count = 1) {
  const enabled = getEnabledHostedAccounts(settings);
  if (!enabled.length) return [];
  const n = Math.max(1, Math.min(Number(count) || 1, enabled.length));
  const start = Math.abs(parseInt(settings.hostRotationIndex, 10) || 0) % enabled.length;
  const batch = [];
  for (let i = 0; i < n; i++) {
    batch.push(enabled[(start + i) % enabled.length]);
  }
  return batch;
}

/** 按轮询取下一批并推进旋转（兼容旧调用；优先用 peek + advance） */
export function takeNextHostedBatch(settings = readAiSettings(), count = 1) {
  const batch = peekNextHostedBatch(settings, count);
  if (batch.length) advanceHostRotationBy(batch.length, settings);
  return batch;
}

export function advanceHostRotationBy(steps = 1, settings = readAiSettings()) {
  const enabled = getEnabledHostedAccounts(settings);
  if (!enabled.length) return;
  const n = Math.max(0, parseInt(steps, 10) || 0);
  if (!n) return;
  const start = Math.abs(parseInt(settings.hostRotationIndex, 10) || 0) % enabled.length;
  settings.hostRotationIndex = (start + n) % enabled.length;
  writeSettings(settings);
}

export function advanceHostRotation(settings = readAiSettings()) {
  advanceHostRotationBy(1, settings);
}

export function pickNextHostedAccount(settings = readAiSettings()) {
  const picked = peekNextHostedAccount(settings);
  if (picked) advanceHostRotation(settings);
  return picked;
}

function normalizeSettings(raw = {}) {
  const settings = { ...DEFAULT_AI_SETTINGS, ...raw };
  settings.provider = normalizeAiProviderId(settings.provider);
  settings.baseUrl = String(settings.baseUrl || "").trim();
  settings.model = normalizeAiModel(settings.provider, settings.model, settings.baseUrl);
  settings.topic = String(settings.topic || "").trim() || DEFAULT_AI_SETTINGS.topic;
  settings.topics = Array.isArray(settings.topics)
    ? settings.topics.map((t) => String(t).trim()).filter(Boolean)
    : [];
  let intervalMin = parseInt(settings.intervalMinMinutes, 10);
  let intervalMax = parseInt(settings.intervalMaxMinutes, 10);
  if (!Number.isFinite(intervalMin) || !Number.isFinite(intervalMax)) {
    const legacy = Math.max(5, Math.min(parseInt(settings.intervalMinutes, 10) || 60, 24 * 60));
    intervalMin = legacy;
    intervalMax = legacy;
  }
  intervalMin = Math.max(5, Math.min(intervalMin, 24 * 60));
  intervalMax = Math.max(5, Math.min(intervalMax, 24 * 60));
  if (intervalMax < intervalMin) [intervalMin, intervalMax] = [intervalMax, intervalMin];
  settings.intervalMinMinutes = intervalMin;
  settings.intervalMaxMinutes = intervalMax;
  settings.intervalMinutes = intervalMax;
  const nextInterval = parseInt(settings.nextIntervalMinutes, 10);
  settings.nextIntervalMinutes =
    Number.isFinite(nextInterval) && nextInterval >= intervalMin && nextInterval <= intervalMax
      ? nextInterval
      : null;
  settings.postsPerRun = Math.max(1, Math.min(parseInt(settings.postsPerRun, 10) || 1, 5));
  let delayMin = parseInt(settings.publishDelayMinSeconds, 10);
  let delayMax = parseInt(settings.publishDelayMaxSeconds, 10);
  if (!Number.isFinite(delayMin)) {
    delayMin = parseInt(settings.publishIntervalSeconds, 10) || DEFAULT_AI_SETTINGS.publishDelayMinSeconds;
  }
  if (!Number.isFinite(delayMax)) {
    delayMax = Number.isFinite(parseInt(settings.publishIntervalSeconds, 10))
      ? parseInt(settings.publishIntervalSeconds, 10)
      : delayMin;
  }
  delayMin = Math.max(1, Math.min(delayMin, 600));
  delayMax = Math.max(1, Math.min(delayMax, 600));
  if (delayMax < delayMin) [delayMin, delayMax] = [delayMax, delayMin];
  settings.publishDelayMinSeconds = delayMin;
  settings.publishDelayMaxSeconds = delayMax;
  settings.maxPostsPerDay = Math.max(1, Math.min(parseInt(settings.maxPostsPerDay, 10) || 10, 100));
  settings.enabled = Boolean(settings.enabled);
  settings.autoPublish = settings.autoPublish !== false;
  settings.attachRelatedImages = settings.attachRelatedImages !== false;
  settings.preventDuplicatePosts = settings.preventDuplicatePosts !== false;
  settings.useNews = settings.useNews !== false;
  settings.styleReferences = normalizeStyleReferences(settings.styleReferences);
  settings.contentStyles = normalizeContentStyles(settings.contentStyles, settings.styleReferences);
  settings.selectedTokens = normalizeUserTokens(settings.selectedTokens);
  if (Array.isArray(settings.customTokens) && settings.customTokens.length) {
    settings.customTokens = normalizeUserTokens(settings.customTokens);
  } else {
    settings.customTokens = splitPresetAndCustomTokens(settings.selectedTokens, MAINSTREAM_POOL).custom;
  }
  settings.marketSentiment = ["auto", "bullish", "bearish"].includes(settings.marketSentiment)
    ? settings.marketSentiment
    : "auto";
  settings.recentTokenPairs = Array.isArray(settings.recentTokenPairs)
    ? settings.recentTokenPairs
        .filter((p) => Array.isArray(p) && p.length === 2)
        .map((p) => p.map((s) => String(s).toUpperCase()))
    : [];
  if (settings.todayDate !== todayKey()) {
    settings.todayPublished = 0;
    settings.todayPublishedByAccount = {};
    settings.todayDate = todayKey();
  } else {
    settings.todayPublishedByAccount = normalizeTodayPublishedByAccount(
      settings.todayPublishedByAccount,
    );
    // 合计与分账号保持一致（兼容旧数据）
    const summed = sumTodayPublishedByAccount(settings.todayPublishedByAccount);
    if (!summed && settings.todayPublished > 0) {
      // 旧全局计数无法拆到账号，保留合计展示，分账号从 0 起计新发
      settings.todayPublished = Math.max(0, parseInt(settings.todayPublished, 10) || 0);
    } else {
      settings.todayPublished = summed;
    }
  }

  const accounts = listAccountsPublic().accounts;
  settings.aiProfiles = migrateAiProfiles(settings);
  if (
    !settings.defaultAiProfileId ||
    !settings.aiProfiles.some((item) => item.id === settings.defaultAiProfileId)
  ) {
    settings.defaultAiProfileId = settings.aiProfiles[0]?.id || null;
  }
  syncLegacyFieldsFromDefaultProfile(settings);

  settings.hostedAccounts = syncHostedAccountsWithAccountList(
    migrateHostedAccounts(settings),
    accounts,
    settings.styleReferences,
  );
  settings.hostRotationIndex = Math.max(0, parseInt(settings.hostRotationIndex, 10) || 0);
  settings.hostConcurrency = Math.max(1, Math.min(parseInt(settings.hostConcurrency, 10) || 3, 8));
  if (settings.hostedAccounts.some((item) => item.enabled)) {
    const firstEnabled = settings.hostedAccounts.find((item) => item.enabled);
    settings.accountId = firstEnabled?.accountId || settings.accountId;
  }

  return settings;
}

function writeSettings(settings) {
  const file = aiSettingsFile();
  fs.mkdirSync(getConfigDir(), { recursive: true, mode: 0o700 });
  // 先写临时文件再 rename，避免并行写到一半读到半截 JSON
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function needsMigrationPersist(raw, normalized) {
  if (!raw || typeof raw !== "object") return false;
  const hasMigratedProfiles = (normalized.aiProfiles || []).some((item) => item.apiKey);
  const hasMigratedHosted = (normalized.hostedAccounts || []).length > 0;
  const rawProfiles = Array.isArray(raw.aiProfiles) ? raw.aiProfiles : [];
  const rawHosted = Array.isArray(raw.hostedAccounts) ? raw.hostedAccounts : [];

  if (hasMigratedProfiles && (!rawProfiles.length || !rawProfiles.some((item) => item.apiKey))) {
    return true;
  }
  if (hasMigratedHosted && !rawHosted.length) {
    return true;
  }
  return false;
}

export function readAiSettings() {
  if (!fs.existsSync(aiSettingsFile())) return normalizeSettings();
  try {
    const raw = JSON.parse(fs.readFileSync(aiSettingsFile(), "utf8"));
    const normalized = normalizeSettings(raw);
    let dirty = needsMigrationPersist(raw, normalized);
    // 托管已关闭时清掉残留错误，避免一打开软件就整栏血红
    if (!normalized.enabled && normalized.lastError) {
      normalized.lastError = null;
      dirty = true;
    }
    if (dirty) {
      writeSettings(normalized);
    }
    return normalized;
  } catch {
    return normalizeSettings();
  }
}

export function getAiSettingsPublic() {
  const settings = readAiSettings();
  const provider = getAiProvider(settings.provider);
  const accounts = listAccountsPublic().accounts;
  // 最新账号排在第一行，方便多号时优先看到刚加的号
  const accountsNewestFirst = [...accounts].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const metricsMap = getAccountsPostMetricsMap(accountsNewestFirst.map((a) => a.id));
  const hostedById = new Map(settings.hostedAccounts.map((item) => [item.accountId, item]));

  const hostedAccounts = accountsNewestFirst.map((account) => {
    const item =
      hostedById.get(account.id) ||
      normalizeHostedAccount({ accountId: account.id, enabled: false }, {}, settings.styleReferences);
    const metrics = metricsMap[account.id] || {
      articleCount: 0,
      viewCount: 0,
      likeCount: 0,
      commentCount: 0,
      shareCount: 0,
      commission: null,
      lastPublishedAt: null,
    };
    return {
      ...item,
      accountName: account.name || "未知账号",
      isDefault: Boolean(account.isDefault),
      createdAt: account.createdAt || null,
      articleCount: metrics.articleCount,
      viewCount: metrics.viewCount,
      likeCount: metrics.likeCount,
      commentCount: metrics.commentCount,
      shareCount: metrics.shareCount,
      commission: metrics.commission,
      lastPublishedAt: metrics.lastPublishedAt,
      todayPublished: getAccountTodayPublished(settings, account.id),
      maxPostsPerDay: settings.maxPostsPerDay,
    };
  });
  const enabledHosted = hostedAccounts.filter((item) => item.enabled);
  const aiProfiles = settings.aiProfiles.map((item) => {
    const provider = getAiProvider(item.provider);
    return {
      id: item.id,
      name: item.name,
      enabled: item.enabled,
      provider: item.provider,
      providerLabel: provider.label,
      baseUrl: item.baseUrl,
      model: item.model,
      hasApiKey: Boolean(item.apiKey),
      maskedKey: maskApiKey(item.apiKey),
      keyHint: provider.keyHint,
      keyUrl: provider.keyUrl,
      allowCustomBaseUrl: Boolean(provider.allowCustomBaseUrl),
      allowCustomModel: Boolean(provider.allowCustomModel),
      models: provider.models,
      defaultModel: provider.defaultModel,
      createdAt: item.createdAt,
    };
  });
  const enabledAiProfiles = aiProfiles.filter((item) => item.enabled && item.hasApiKey);
  let nextRunAt = null;
  if (settings.enabled && hasAnyAiProfileConfigured(settings)) {
    nextRunAt = settings.lastRunAt
      ? settings.lastRunAt + resolveWaitIntervalMinutes(settings) * 60 * 1000
      : Date.now();
  }
  return {
    enabled: settings.enabled,
    provider: settings.provider,
    baseUrl: settings.baseUrl,
    model: settings.model,
    topic: settings.topic,
    topics: settings.topics,
    systemPrompt: settings.systemPrompt,
    useNews: settings.useNews !== false,
    accountId: settings.accountId,
    hostedAccounts,
    enabledHostedCount: enabledHosted.length,
    aiProfiles,
    defaultAiProfileId: settings.defaultAiProfileId,
    enabledAiProfileCount: enabledAiProfiles.length,
    hostRotationIndex: settings.hostRotationIndex,
    hostConcurrency: settings.hostConcurrency || 3,
    autoPublish: settings.autoPublish,
    attachRelatedImages: settings.attachRelatedImages !== false,
    preventDuplicatePosts: settings.preventDuplicatePosts !== false,
    styleReferences: settings.styleReferences || [],
    intervalMinutes: settings.intervalMinutes,
    intervalMinMinutes: settings.intervalMinMinutes,
    intervalMaxMinutes: settings.intervalMaxMinutes,
    nextIntervalMinutes: settings.nextIntervalMinutes,
    postsPerRun: settings.postsPerRun,
    publishDelayMinSeconds: settings.publishDelayMinSeconds,
    publishDelayMaxSeconds: settings.publishDelayMaxSeconds,
    maxPostsPerDay: settings.maxPostsPerDay,
    hasApiKey: hasAnyAiProfileConfigured(settings),
    maskedKey: maskApiKey(resolveAiProfile(settings.defaultAiProfileId, settings)?.apiKey || settings.apiKey),
    lastRunAt: settings.lastRunAt,
    lastSuccessAt: settings.lastSuccessAt,
    lastError: settings.lastError,
    lastConnectionTestAt: settings.lastConnectionTestAt,
    lastConnectionTestOk: settings.lastConnectionTestOk,
    lastConnectionTestError: settings.lastConnectionTestError,
    lastConnectionTestProfileId: settings.lastConnectionTestProfileId,
    todayPublished: settings.todayPublished,
    todayPublishedByAccount: settings.todayPublishedByAccount || {},
    totalPublished: settings.totalPublished,
    nextRunAt,
    providerLabel: provider.label,
    keyHint: provider.keyHint,
    keyUrl: provider.keyUrl,
    providers: listAiProvidersPublic(),
    models: provider.models.map((item) => item.id),
    modelOptions: provider.models,
    allowCustomBaseUrl: Boolean(provider.allowCustomBaseUrl),
    allowCustomModel: Boolean(provider.allowCustomModel),
    contentStyles: settings.contentStyles,
    contentStyleOptions: listContentStyleOptions(settings.styleReferences),
    selectedTokens: settings.selectedTokens,
    customTokens: settings.customTokens,
    marketSentiment: settings.marketSentiment,
    availableTokens: MAINSTREAM_POOL,
    marketSentimentOptions: MARKET_SENTIMENT_OPTIONS,
  };
}

function syncDefaultProfileFromLegacyPatch(patch, current) {
  if (Array.isArray(patch.aiProfiles)) return patch;
  const legacyKeys = ["provider", "baseUrl", "model", "apiKey"];
  const hasLegacyChange = legacyKeys.some((key) => Object.prototype.hasOwnProperty.call(patch, key));
  if (!hasLegacyChange) return patch;

  const profiles = [...(current.aiProfiles || [])];
  const defaultId = patch.defaultAiProfileId || current.defaultAiProfileId || profiles[0]?.id;
  if (!profiles.length) {
    const created = normalizeAiProfile({
      id: defaultId || generateAiProfileId(),
      name: `${getAiProvider(patch.provider || current.provider || "zhipu").label}（默认）`,
      enabled: true,
      provider: patch.provider ?? current.provider,
      baseUrl: patch.baseUrl ?? current.baseUrl,
      apiKey: patch.apiKey ?? current.apiKey,
      model: patch.model ?? current.model,
    });
    return {
      ...patch,
      aiProfiles: [created],
      defaultAiProfileId: created.id,
    };
  }

  const index = profiles.findIndex((item) => item.id === defaultId);
  const targetIndex = index >= 0 ? index : 0;
  const existing = profiles[targetIndex];
  const updated = normalizeAiProfile({
    ...existing,
    provider: patch.provider ?? existing.provider,
    baseUrl: patch.baseUrl ?? existing.baseUrl,
    model: patch.model ?? existing.model,
    apiKey: patch.apiKey ?? existing.apiKey,
    id: existing.id,
    name: existing.name,
  });
  if (!updated.apiKey && existing.apiKey) updated.apiKey = existing.apiKey;
  profiles[targetIndex] = updated;
  return {
    ...patch,
    aiProfiles: profiles,
    defaultAiProfileId: existing.id,
  };
}

export function saveAiSettings(patch = {}) {
  const current = readAiSettings();
  const nextPatch = syncDefaultProfileFromLegacyPatch(patch, current);

  if (Array.isArray(patch.aiProfiles)) {
    const existingMap = new Map((current.aiProfiles || []).map((item) => [item.id, item]));
    nextPatch.aiProfiles = patch.aiProfiles
      .map((item) => {
        const normalized = normalizeAiProfile(item);
        const existing = existingMap.get(normalized.id);
        if (!normalized.apiKey && existing?.apiKey) normalized.apiKey = existing.apiKey;
        return normalized;
      })
      .filter(Boolean);
    if (nextPatch.aiProfiles.length && !nextPatch.defaultAiProfileId) {
      nextPatch.defaultAiProfileId =
        nextPatch.aiProfiles.find((item) => item.id === current.defaultAiProfileId)?.id ||
        nextPatch.aiProfiles[0].id;
    }
  }

  if (Object.prototype.hasOwnProperty.call(patch, "styleReferences")) {
    nextPatch.styleReferences = normalizeStyleReferences(patch.styleReferences);
  }

  if (Array.isArray(patch.hostedAccounts)) {
    const refsForHost = normalizeStyleReferences(nextPatch.styleReferences ?? current.styleReferences);
    nextPatch.hostedAccounts = patch.hostedAccounts
      .map((item) =>
        normalizeHostedAccount(
          item,
          {
            tokenMode: current.tokenMode,
            selectedTokens: current.selectedTokens,
            customTokens: current.customTokens,
            marketSentiment: current.marketSentiment,
            contentStyles: current.contentStyles,
          },
          refsForHost,
        ),
      )
      .filter(Boolean);
  }
  const next = normalizeSettings({ ...current, ...nextPatch });
  if (Object.prototype.hasOwnProperty.call(patch, "apiKey")) {
    const key = String(patch.apiKey || "").trim();
    if (key) next.apiKey = key;
    else if (patch.apiKey === "") next.apiKey = "";
  }
  // 关闭托管时清掉上次错误，避免下次打开仍显示「最近错误」
  if (current.enabled && !next.enabled) {
    next.lastError = null;
  }
  writeSettings(next);
  return getAiSettingsPublic();
}

export function resolveAiApiKey(overrideKey, profileId) {
  return resolveAiCredentials({
    profileId,
    overrides: { apiKey: overrideKey },
  }).apiKey;
}

/** 在区间内抽取下一轮等待分钟数并写入 settings（调用方负责 write） */
function rollNextIntervalMinutes(settings) {
  const min = Math.max(5, parseInt(settings.intervalMinMinutes, 10) || 30);
  const max = Math.max(min, parseInt(settings.intervalMaxMinutes, 10) || min);
  settings.nextIntervalMinutes =
    min === max ? min : min + Math.floor(Math.random() * (max - min + 1));
  return settings.nextIntervalMinutes;
}

/**
 * 当前已承诺的等待分钟数（用于 shouldRunNow / nextRunAt）。
 * 尚未抽取时回退到区间上限，避免每次读状态都重抽。
 */
export function resolveWaitIntervalMinutes(settings = readAiSettings()) {
  const min = Math.max(5, parseInt(settings.intervalMinMinutes, 10) || 30);
  const max = Math.max(min, parseInt(settings.intervalMaxMinutes, 10) || min);
  const next = parseInt(settings.nextIntervalMinutes, 10);
  if (Number.isFinite(next) && next >= min && next <= max) return next;
  return max;
}

export function markRunStarted() {
  const settings = readAiSettings();
  settings.lastRunAt = Date.now();
  rollNextIntervalMinutes(settings);
  writeSettings(settings);
  return settings.lastRunAt;
}

export function recordTokenPair(pair = []) {
  const tokens = pair.map((s) => String(s).replace(/^\$/, "").toUpperCase()).filter(Boolean);
  if (tokens.length < 2) return;
  const settings = readAiSettings();
  const key = [...tokens].sort().join(",");
  const history = settings.recentTokenPairs.filter((p) => [...p].sort().join(",") !== key);
  history.unshift(tokens.slice(0, 2));
  settings.recentTokenPairs = history.slice(0, 12);
  writeSettings(settings);
}

export function getRecentTokenPairs() {
  return readAiSettings().recentTokenPairs || [];
}

export function recordAiRun({
  success,
  error,
  skipped = false,
  tokenPair = null,
  tokenPairs = null,
} = {}) {
  const settings = readAiSettings();
  settings.lastRunAt = Date.now();
  if (settings.todayDate !== todayKey()) {
    settings.todayDate = todayKey();
    settings.todayPublished = 0;
    settings.todayPublishedByAccount = {};
  }
  if (success) {
    settings.lastSuccessAt = Date.now();
    // 全失败才钉错误；有成功时清空，避免状态栏一直血红
    settings.lastError = error ? String(error) : null;
    const pairsToRecord = [];
    if (Array.isArray(tokenPairs) && tokenPairs.length) {
      for (const pair of tokenPairs) {
        if (Array.isArray(pair) && pair.length >= 2) pairsToRecord.push(pair);
      }
    } else if (tokenPair?.length === 2) {
      pairsToRecord.push(tokenPair);
    }
    let history = Array.isArray(settings.recentTokenPairs) ? [...settings.recentTokenPairs] : [];
    for (const pair of pairsToRecord) {
      const tokens = pair.map((s) => String(s).replace(/^\$/, "").toUpperCase()).filter(Boolean);
      if (tokens.length < 2) continue;
      const key = [...tokens].sort().join(",");
      history = history.filter((p) => [...p].sort().join(",") !== key);
      history.unshift(tokens.slice(0, 2));
    }
    if (pairsToRecord.length) {
      settings.recentTokenPairs = history.slice(0, 24);
    }
  } else if (skipped) {
    // 额度满/取消空轮等：只更新 lastRunAt，不改 lastError
  } else if (error) {
    settings.lastError = String(error);
  }
  rollNextIntervalMinutes(settings);
  writeSettings(settings);
  return getAiSettingsPublic();
}

/** 记录 AI API 连接探测结果（API 管理页「连接状态」用，与托管任务状态无关） */
export function recordAiConnectionTest({ ok, error = null, profileId = null } = {}) {
  const settings = readAiSettings();
  settings.lastConnectionTestAt = Date.now();
  settings.lastConnectionTestOk = Boolean(ok);
  settings.lastConnectionTestError = ok ? null : String(error || "连接失败").slice(0, 300);
  settings.lastConnectionTestProfileId = profileId ? String(profileId) : null;
  writeSettings(settings);
  return getAiSettingsPublic();
}

function normalizeTodayPublishedByAccount(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  for (const [id, value] of Object.entries(raw)) {
    const key = String(id || "").trim();
    if (!key) continue;
    const n = Math.max(0, parseInt(value, 10) || 0);
    if (n > 0) out[key] = n;
  }
  return out;
}

function sumTodayPublishedByAccount(map) {
  return Object.values(map || {}).reduce((sum, n) => sum + (parseInt(n, 10) || 0), 0);
}

function ensureTodayCounters(settings) {
  if (settings.todayDate !== todayKey()) {
    settings.todayDate = todayKey();
    settings.todayPublished = 0;
    settings.todayPublishedByAccount = {};
  } else {
    settings.todayPublishedByAccount = normalizeTodayPublishedByAccount(
      settings.todayPublishedByAccount,
    );
  }
  return settings;
}

export function getAccountTodayPublished(settings = readAiSettings(), accountId) {
  const normalized = normalizeSettings(settings);
  const id = String(accountId || "").trim();
  if (!id) return 0;
  return Math.max(0, parseInt(normalized.todayPublishedByAccount?.[id], 10) || 0);
}

export function tryClaimTodayPublishSlot(count = 1, accountId = null) {
  const n = Math.max(1, parseInt(count, 10) || 1);
  const id = String(accountId || "").trim();
  if (!id) return false;
  const settings = ensureTodayCounters(readAiSettings());
  const current = settings.todayPublishedByAccount[id] || 0;
  if (current + n > settings.maxPostsPerDay) return false;
  settings.todayPublishedByAccount[id] = current + n;
  settings.todayPublished = sumTodayPublishedByAccount(settings.todayPublishedByAccount);
  settings.totalPublished += n;
  writeSettings(settings);
  return true;
}

export function releaseTodayPublishSlot(count = 1, accountId = null) {
  const n = Math.max(1, parseInt(count, 10) || 1);
  const id = String(accountId || "").trim();
  const settings = ensureTodayCounters(readAiSettings());
  if (!id) return settings.todayPublished;
  const current = settings.todayPublishedByAccount[id] || 0;
  const next = Math.max(0, current - n);
  if (next > 0) settings.todayPublishedByAccount[id] = next;
  else delete settings.todayPublishedByAccount[id];
  settings.todayPublished = sumTodayPublishedByAccount(settings.todayPublishedByAccount);
  settings.totalPublished = Math.max(0, (settings.totalPublished || 0) - n);
  writeSettings(settings);
  return settings.todayPublished;
}

export function pickAiTopic(settings = readAiSettings()) {
  const pool = settings.topics.length ? settings.topics : [settings.topic];
  if (pool.length === 1) return pool[0];
  const index = Math.floor(Math.random() * pool.length);
  return pool[index];
}

export function getPublishDelayMs(settings = readAiSettings()) {
  const min = Math.max(1, parseInt(settings.publishDelayMinSeconds, 10) || 30);
  const max = Math.max(min, parseInt(settings.publishDelayMaxSeconds, 10) || min);
  const seconds = min === max ? min : min + Math.floor(Math.random() * (max - min + 1));
  return seconds * 1000;
}

/** 指定账号今日是否仍有额度 */
export function canAccountRunAiToday(settings = readAiSettings(), accountId) {
  const normalized = normalizeSettings(settings);
  const id = String(accountId || "").trim();
  if (!id) return false;
  return getAccountTodayPublished(normalized, id) < normalized.maxPostsPerDay;
}

/**
 * 是否还有可跑的托管账号额度。
 * - 有启用托管账号：任一账号未达单账号上限即可
 * - 有托管列表但一个都没启用：不可跑
 * - 无托管配置：回退为合计 < 上限
 */
export function canRunAiToday(settings = readAiSettings()) {
  const normalized = normalizeSettings(settings);
  const hosted = normalized.hostedAccounts || [];
  const enabled = hosted.filter((item) => item.enabled);
  if (enabled.length) {
    return enabled.some((item) => canAccountRunAiToday(normalized, item.accountId));
  }
  if (hosted.length) return false;
  return normalized.todayPublished < normalized.maxPostsPerDay;
}
