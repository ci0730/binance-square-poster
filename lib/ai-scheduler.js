import { publishPost } from "./square-api.js";
import { resolveAccountApiKey, resolveAccountProxy, getAccountName } from "./accounts.js";
import { cachePublishedPost } from "./post-cache.js";
import { generateSquarePost } from "./ai-generator.js";
import {
  readAiSettings,
  recordAiRun,
  incrementTodayPublished,
  getPublishDelayMs,
  canRunAiToday,
  pickAiTopic,
  markRunStarted,
  getRecentTokenPairs,
  getEnabledHostedAccounts,
  peekNextHostedAccount,
  advanceHostRotation,
  getHostedAccountConfig,
  resolveAiCredentials,
  hasAnyAiProfileConfigured,
} from "./ai-settings.js";
import { appendSystemLog } from "./system-log.js";
import { toChineseError } from "./error-zh.js";
import { prepareRelatedPostImages } from "./ai-post-images.js";
import {
  getAccountPublishedTexts,
  isDuplicatePostText,
} from "./ai-duplicate.js";

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

  const picked = peekNextHostedAccount(settings);
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
      attachRelatedImages: settings.attachRelatedImages !== false,
      preventDuplicatePosts: settings.preventDuplicatePosts !== false,
      todayPublished: settings.todayPublished,
      maxPostsPerDay: settings.maxPostsPerDay,
    },
  };
}

async function generateHostedDraft({
  settings,
  runtimeSettings,
  recentTexts,
  recentContentStyles,
  existingTexts,
  tokenIndex,
}) {
  const avoidPool = settings.preventDuplicatePosts !== false
    ? [...existingTexts, ...recentTexts]
    : recentTexts;
  const maxAttempts = settings.preventDuplicatePosts !== false ? 3 : 1;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const topic = runtimeSettings.topic || pickAiTopic(settings);
    const draft = await generateSquarePost({
      apiKey: runtimeSettings.apiKey,
      provider: runtimeSettings.provider,
      baseUrl: runtimeSettings.baseUrl,
      model: runtimeSettings.model,
      topic,
      recentTexts: avoidPool,
      recentPairs: getRecentTokenPairs(),
      recentContentStyles,
      selectedTokens: runtimeSettings.selectedTokens,
      marketSentiment: runtimeSettings.marketSentiment,
      contentStyles: runtimeSettings.contentStyles,
      tokenIndex,
    });

    if (settings.preventDuplicatePosts === false) return draft;
    if (!isDuplicatePostText(draft.text, existingTexts)) return draft;

    appendSystemLog(
      `[AI托管] 生成内容与已发帖子重复，正在重试 (${attempt + 1}/${maxAttempts})`,
      { type: "warn", source: "ai-host" },
    );
    avoidPool.push(draft.text);
  }
  return null;
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
  const existingTexts =
    settings.preventDuplicatePosts !== false ? getAccountPublishedTexts(accountId) : [];
  let lastTokenPair = null;

  for (let i = 0; i < runCount; i++) {
    if (!canRunAiToday(readAiSettings())) break;

    const draft = await generateHostedDraft({
      settings,
      runtimeSettings,
      recentTexts,
      recentContentStyles,
      existingTexts,
      tokenIndex: i,
    });
    if (!draft) {
      appendSystemLog(`[AI托管] 账号「${getAccountName(accountId)}」跳过发布：与历史帖重复且重试后仍相似`, {
        type: "warn",
        source: "ai-host",
      });
      continue;
    }

    generated.push({ ...draft, accountId });
    recentTexts.push(draft.text);
    if (draft.contentStyle) recentContentStyles.push(draft.contentStyle);
    lastTokenPair = draft.focusTokens;

    if (!shouldPublish) continue;

    let imagePaths = [];
    if (settings.attachRelatedImages !== false) {
      try {
        imagePaths = await prepareRelatedPostImages({
          focusTokens: draft.focusTokens || [],
          uploadsDir,
          maxImages: 2,
        });
      } catch (err) {
        appendSystemLog(`配图下载失败，将改为纯文字发布：${toChineseError(err)}`, {
          type: "warn",
          source: "ai-host",
        });
        imagePaths = [];
      }
    }

    let result;
    try {
      result = await publishPost(
        apiKey,
        { text: draft.text, title: "", imagePaths },
        uploadsDir,
        undefined,
        {
          proxyUrl: resolveAccountProxy(accountId),
        },
      );
    } catch (err) {
      // 有图时上传失败则降级为纯文字再发一次，避免整轮托管中断
      if (imagePaths.length) {
        appendSystemLog(`配图上传失败，改纯文字重试：${toChineseError(err)}`, {
          type: "warn",
          source: "ai-host",
        });
        result = await publishPost(
          apiKey,
          { text: draft.text, title: "", imagePaths: [] },
          uploadsDir,
          undefined,
          {
            proxyUrl: resolveAccountProxy(accountId),
          },
        );
        imagePaths = [];
      } else {
        throw err;
      }
    }
    published.push({ text: draft.text, result, accountId, imageCount: imagePaths.length });
    incrementTodayPublished(1);
    cachePublishedPost(accountId, {
      id: result.id,
      text: draft.text,
      title: "",
      shareLink: result.shareLink,
      publishedAt: Date.now(),
      source: "ai-hosted",
    });
    existingTexts.unshift(draft.text);

    if (i < runCount - 1) {
      await delay(getPublishDelayMs(settings));
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
  const usedRotation = !overrides.allAccounts && !overrides.accountId;
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
        await delay(getPublishDelayMs(settings));
      }
    }

    if (usedRotation) advanceHostRotation();

    recordAiRun({ success: true, tokenPair: lastTokenPair });
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
    appendSystemLog(`[AI托管] ${result.message}`, { type: "ok", source: "ai-host" });
    return result;
  } catch (err) {
    const zh = toChineseError(err);
    recordAiRun({ success: false, error: zh });
    lastStatus = { running: false, lastTickAt: Date.now(), lastResult: { ok: false, error: zh } };
    const names = targets.map((item) => getAccountName(item.accountId)).filter(Boolean).join("、");
    appendSystemLog(`[AI托管] 失败${names ? `（${names}）` : ""}：${zh}`, {
      type: "err",
      source: "ai-host",
    });
    throw new Error(zh);
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
    // 错误已在 runAiHostedCycle 写入系统日志
    console.error("[AI托管]", toChineseError(err));
  }
}

export function startAiScheduler(uploadsDir) {
  stopAiScheduler();
  appendSystemLog("[AI托管] 调度器已启动", { type: "info", source: "ai-host" });
  timer = setInterval(() => {
    tick(uploadsDir).catch((err) => {
      const zh = toChineseError(err);
      appendSystemLog(`[AI托管] 调度异常：${zh}`, { type: "err", source: "ai-host" });
      console.error("[AI托管]", zh);
    });
  }, 60 * 1000);
}

export function stopAiScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
