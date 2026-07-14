import fs from "fs";
import path from "path";
import { getConfigDir } from "./app-paths.js";
import {
  DEFAULT_CONTENT_STYLES,
  normalizeContentStyles,
  normalizeStyleReferences,
  listContentStyleOptions,
} from "./ai-content-styles.js";
import { MAINSTREAM_POOL, normalizeUserTokens, splitPresetAndCustomTokens } from "./crypto-context.js";
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
  aiProfiles: [],
  defaultAiProfileId: null,
  autoPublish: true,
  attachRelatedImages: true,
  preventDuplicatePosts: true,
  styleReferences: [],
  intervalMinutes: 60,
  postsPerRun: 1,
  publishDelayMinSeconds: 3,
  publishDelayMaxSeconds: 8,
  maxPostsPerDay: 10,
  lastRunAt: null,
  lastSuccessAt: null,
  lastError: null,
  todayPublished: 0,
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

export function resolveAiCredentials({ profileId, hostConfig, settings = readAiSettings(), overrides = {} } = {}) {
  const targetId = overrides.aiProfileId || hostConfig?.aiProfileId || profileId || null;
  let profile = targetId ? resolveAiProfile(targetId, settings) : null;
  if (!profile?.apiKey) {
    profile = getEnabledAiProfiles(settings)[0] || resolveAiProfile(settings.defaultAiProfileId, settings);
  }

  const apiKey = String(overrides.apiKey || "").trim() || profile?.apiKey || settings.apiKey;
  if (!apiKey) throw new Error("请先配置 AI API Key");

  const useProfileCreds = Boolean(targetId && profile?.id === targetId);
  const provider = normalizeAiProviderId(
    useProfileCreds
      ? profile?.provider || settings.provider
      : overrides.provider || profile?.provider || settings.provider,
  );
  const baseUrl = useProfileCreds
    ? profile?.baseUrl ?? settings.baseUrl ?? ""
    : overrides.baseUrl ?? profile?.baseUrl ?? settings.baseUrl ?? "";
  const model = normalizeAiModel(
    provider,
    useProfileCreds ? profile?.model || settings.model : overrides.model || profile?.model || settings.model,
    baseUrl,
  );

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

  return {
    accountId,
    enabled: Boolean(raw.enabled),
    aiProfileId: String(raw.aiProfileId || "").trim() || null,
    selectedTokens,
    customTokens,
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

export function advanceHostRotation(settings = readAiSettings()) {
  const enabled = getEnabledHostedAccounts(settings);
  if (!enabled.length) return;
  const index = Math.abs(parseInt(settings.hostRotationIndex, 10) || 0) % enabled.length;
  settings.hostRotationIndex = (index + 1) % enabled.length;
  writeSettings(settings);
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
  settings.intervalMinutes = Math.max(5, Math.min(parseInt(settings.intervalMinutes, 10) || 60, 24 * 60));
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
    settings.todayDate = todayKey();
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
  if (settings.hostedAccounts.some((item) => item.enabled)) {
    const firstEnabled = settings.hostedAccounts.find((item) => item.enabled);
    settings.accountId = firstEnabled?.accountId || settings.accountId;
  }

  return settings;
}

function writeSettings(settings) {
  fs.mkdirSync(getConfigDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(aiSettingsFile(), JSON.stringify(settings, null, 2), { mode: 0o600 });
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
  if (hasMigratedHosted && (!rawHosted.length || Boolean(raw.accountId))) {
    return true;
  }
  return false;
}

export function readAiSettings() {
  if (!fs.existsSync(aiSettingsFile())) return normalizeSettings();
  try {
    const raw = JSON.parse(fs.readFileSync(aiSettingsFile(), "utf8"));
    const normalized = normalizeSettings(raw);
    if (needsMigrationPersist(raw, normalized)) {
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
      ? settings.lastRunAt + settings.intervalMinutes * 60 * 1000
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
    autoPublish: settings.autoPublish,
    attachRelatedImages: settings.attachRelatedImages !== false,
    preventDuplicatePosts: settings.preventDuplicatePosts !== false,
    styleReferences: settings.styleReferences || [],
    intervalMinutes: settings.intervalMinutes,
    postsPerRun: settings.postsPerRun,
    publishDelayMinSeconds: settings.publishDelayMinSeconds,
    publishDelayMaxSeconds: settings.publishDelayMaxSeconds,
    maxPostsPerDay: settings.maxPostsPerDay,
    hasApiKey: hasAnyAiProfileConfigured(settings),
    maskedKey: maskApiKey(resolveAiProfile(settings.defaultAiProfileId, settings)?.apiKey || settings.apiKey),
    lastRunAt: settings.lastRunAt,
    lastSuccessAt: settings.lastSuccessAt,
    lastError: settings.lastError,
    todayPublished: settings.todayPublished,
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
  writeSettings(next);
  return getAiSettingsPublic();
}

export function resolveAiApiKey(overrideKey, profileId) {
  return resolveAiCredentials({
    profileId,
    overrides: { apiKey: overrideKey },
  }).apiKey;
}

export function markRunStarted() {
  const settings = readAiSettings();
  settings.lastRunAt = Date.now();
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

export function recordAiRun({ success, error, tokenPair = null } = {}) {
  const settings = readAiSettings();
  settings.lastRunAt = Date.now();
  if (settings.todayDate !== todayKey()) {
    settings.todayDate = todayKey();
    settings.todayPublished = 0;
  }
  if (success) {
    settings.lastSuccessAt = Date.now();
    settings.lastError = null;
    if (tokenPair?.length === 2) {
      const tokens = tokenPair.map((s) => String(s).replace(/^\$/, "").toUpperCase()).filter(Boolean);
      if (tokens.length === 2) {
        const key = [...tokens].sort().join(",");
        const history = settings.recentTokenPairs.filter((p) => [...p].sort().join(",") !== key);
        history.unshift(tokens);
        settings.recentTokenPairs = history.slice(0, 12);
      }
    }
  } else if (error) {
    settings.lastError = String(error);
  }
  writeSettings(settings);
  return getAiSettingsPublic();
}

export function incrementTodayPublished(count = 1) {
  const n = Math.max(0, parseInt(count, 10) || 0);
  if (!n) return readAiSettings().todayPublished;
  const settings = readAiSettings();
  if (settings.todayDate !== todayKey()) {
    settings.todayDate = todayKey();
    settings.todayPublished = 0;
  }
  settings.todayPublished += n;
  settings.totalPublished += n;
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
  const min = Math.max(1, parseInt(settings.publishDelayMinSeconds, 10) || 3);
  const max = Math.max(min, parseInt(settings.publishDelayMaxSeconds, 10) || min);
  const seconds = min === max ? min : min + Math.floor(Math.random() * (max - min + 1));
  return seconds * 1000;
}

export function canRunAiToday(settings = readAiSettings()) {
  const normalized = normalizeSettings(settings);
  return normalized.todayPublished < normalized.maxPostsPerDay;
}
