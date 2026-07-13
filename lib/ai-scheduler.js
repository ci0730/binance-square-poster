import { publishPost } from "./square-api.js";
import { resolveAccountApiKey, resolveAccountProxy } from "./accounts.js";
import { cachePublishedPost } from "./post-cache.js";
import { generateSquarePost } from "./ai-generator.js";
import {
  readAiSettings,
  recordAiRun,
  canRunAiToday,
  pickAiTopic,
  markRunStarted,
  getRecentTokenPairs,
  getEnabledHostedAccounts,
  pickNextHostedAccount,
  getHostedAccountConfig,
  resolveAiCredentials,
  hasAnyAiProfileConfigured,
} from "./ai-settings.js";

let timer = null;
let running = false;
let lastStatus = { running: false, lastTickAt: null, lastResult: null };

const RUN_COOLDOWN_MS = 120000;

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function shouldRunNow(settings, now = Date.now()) {
  if (!settings.enabled || !hasAnyAiProfileConfigured(settings)) return false;
  if (!canRunAiToday(settings)) return false;
  if (!settings.lastRunAt) return true;
  const intervalMs = settings.intervalMinutes * 60 * 1000;
  return now - settings.lastRunAt >= intervalMs;
}

function isInCooldown() {
  const settings = readAiSettings();
  if (!settings.lastRunAt) return false;
  return Date.now() - settings.lastRunAt < RUN_COOLDOWN_MS;
}

function resolveHostedTargets(settings, overrides = {}) {
  const enabledHosted = getEnabledHostedAccounts(settings);
  if (!enabledHosted.length) {
    throw new Error("请至少启用一个托管账号");
  }

  if (overrides.allAccounts) {
    return enabledHosted;
  }

  if (overrides.accountId) {
    const matched = getHostedAccountConfig(overrides.accountId, settings);
    if (matched?.enabled) return [matched];
    throw new Error("所选账号未启用托管");
  }

  const picked = pickNextHostedAccount(settings);
  if (!picked) throw new Error("请至少启用一个托管账号");
  return [picked];
}

function buildRuntimeSettings(settings, hostConfig, overrides = {}) {
  const creds = resolveAiCredentials({ hostConfig, settings, overrides });
  return {
    selectedTokens: overrides.selectedTokens ?? hostConfig.selectedTokens,
    customTokens: overrides.customTokens ?? hostConfig.customTokens,
    marketSentiment: overrides.marketSentiment ?? hostConfig.marketSentiment,
    contentStyles: overrides.contentStyles ?? hostConfig.contentStyles,
    aiProfileId: creds.aiProfileId,
    provider: creds.provider,
    baseUrl: creds.baseUrl,
    model: creds.model,
    apiKey: creds.apiKey,
    topic: overrides.topic ?? settings.topic,
  };
}

export function getAiSchedulerStatus() {
  const settings = readAiSettings();
  const nextRunAt =
    settings.enabled && hasAnyAiProfileConfigured(settings) && settings.lastRunAt
      ? settings.lastRunAt + settings.intervalMinutes * 60 * 1000
      : null;
  return {
    ...lastStatus,
    running,
    enabled: settings.enabled,
    canRunToday: canRunAiToday(settings),
    nextRunAt,
    enabledHostedCount: getEnabledHostedAccounts(settings).length,
    settings: {
      intervalMinutes: settings.intervalMinutes,
      postsPerRun: settings.postsPerRun,
      autoPublish: settings.autoPublish,
      todayPublished: settings.todayPublished,
      maxPostsPerDay: settings.maxPostsPerDay,
    },
  };
}

async function runHostedAccountCycle({
  settings,
  hostConfig,
  runtimeSettings,
  uploadsDir,
  shouldPublish,
  runCount,
  generated,
  published,
}) {
  const accountId = hostConfig.accountId;
  const apiKey = resolveAccountApiKey(accountId);
  const recentTexts = [];
  const recentContentStyles = [];
  let lastTokenPair = null;

  for (let i = 0; i < runCount; i++) {
    if (!canRunAiToday(readAiSettings())) break;

    const topic = runtimeSettings.topic || pickAiTopic(settings);
    const draft = await generateSquarePost({
      apiKey: runtimeSettings.apiKey,
      provider: runtimeSettings.provider,
      baseUrl: runtimeSettings.baseUrl,
      model: runtimeSettings.model,
      topic,
      recentTexts,
      recentPairs: getRecentTokenPairs(),
      recentContentStyles,
      selectedTokens: runtimeSettings.selectedTokens,
      marketSentiment: runtimeSettings.marketSentiment,
      contentStyles: runtimeSettings.contentStyles,
      tokenIndex: i,
    });

    generated.push({ ...draft, accountId });
    recentTexts.push(draft.text);
    if (draft.contentStyle) recentContentStyles.push(draft.contentStyle);
    lastTokenPair = draft.focusTokens;

    if (!shouldPublish) continue;

    const result = await publishPost(apiKey, { text: draft.text, title: "", imagePaths: [] }, uploadsDir, undefined, {
      proxyUrl: resolveAccountProxy(accountId),
    });
    published.push({ text: draft.text, result, accountId });
    cachePublishedPost(accountId, {
      id: result.id,
      text: draft.text,
      title: "",
      shareLink: result.shareLink,
      publishedAt: Date.now(),
      source: "ai-hosted",
    });

    if (i < runCount - 1) {
      await delay(Math.max(1, settings.publishIntervalSeconds) * 1000);
    }
  }

  return lastTokenPair;
}

export async function runAiHostedCycle({
  uploadsDir,
  force = false,
  manual = false,
  publish = null,
  count = null,
  overrides = {},
} = {}) {
  if (running) throw new Error("AI 托管任务正在运行中");
  if (!manual && isInCooldown()) return { ok: false, skipped: true, message: "冷却中" };

  const settings = readAiSettings();
  if (!hasAnyAiProfileConfigured(settings)) throw new Error("请先在 API 管理中配置至少一个 AI API Key");
  if (!force && !settings.enabled) throw new Error("AI 托管未开启");
  if (!canRunAiToday(settings)) throw new Error("已达到今日 AI 发帖上限");

  const targets = resolveHostedTargets(settings, overrides);
  const shouldPublish = publish ?? settings.autoPublish;
  const runCount = Math.max(1, Math.min(parseInt(count, 10) || settings.postsPerRun || 1, 5));

  running = true;
  markRunStarted();
  lastStatus = { running: true, lastTickAt: Date.now(), lastResult: null };

  const generated = [];
  const published = [];
  let lastTokenPair = null;

  try {
    for (const hostConfig of targets) {
      const runtimeSettings = buildRuntimeSettings(settings, hostConfig, overrides);
      lastTokenPair = await runHostedAccountCycle({
        settings,
        hostConfig,
        runtimeSettings,
        uploadsDir,
        shouldPublish,
        runCount,
        generated,
        published,
      });

      if (targets.length > 1 && shouldPublish) {
        await delay(Math.max(1, settings.publishIntervalSeconds) * 1000);
      }
    }

    recordAiRun({ success: true, published: published.length, tokenPair: lastTokenPair });
    const result = {
      ok: true,
      generated,
      published,
      autoPublish: shouldPublish,
      accountIds: targets.map((item) => item.accountId),
      message: shouldPublish
        ? `已为 ${targets.length} 个账号生成 ${generated.length} 条，成功发布 ${published.length} 条`
        : `已为 ${targets.length} 个账号生成 ${generated.length} 条草稿`,
    };
    lastStatus = { running: false, lastTickAt: Date.now(), lastResult: result };
    return result;
  } catch (err) {
    recordAiRun({ success: false, error: err.message, published: published.length });
    lastStatus = { running: false, lastTickAt: Date.now(), lastResult: { ok: false, error: err.message } };
    throw err;
  } finally {
    running = false;
  }
}

async function tick(uploadsDir) {
  if (running || isInCooldown()) return;
  const settings = readAiSettings();
  if (!shouldRunNow(settings)) return;
  try {
    await runAiHostedCycle({ uploadsDir, force: true });
  } catch (err) {
    console.error("[AI托管]", err.message);
  }
}

export function startAiScheduler(uploadsDir) {
  stopAiScheduler();
  timer = setInterval(() => {
    tick(uploadsDir).catch((err) => console.error("[AI托管]", err.message));
  }, 60 * 1000);
}

export function stopAiScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
