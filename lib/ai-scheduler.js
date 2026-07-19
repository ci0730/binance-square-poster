import { publishPost } from "./square-api.js";
import { resolveAccountApiKey, resolveAccountProxy, getAccountName, getAccountCookie } from "./accounts.js";
import { cachePublishedPost } from "./post-cache.js";
import { generateSquarePost, abortActiveAiRequest } from "./ai-generator.js";
import {
  readAiSettings,
  recordAiRun,
  tryClaimTodayPublishSlot,
  releaseTodayPublishSlot,
  getPublishDelayMs,
  canAccountRunAiToday,
  canRunAiToday,
  pickAiTopic,
  markRunStarted,
  getRecentTokenPairs,
  getEnabledHostedAccounts,
  peekNextHostedBatch,
  advanceHostRotationBy,
  getHostedAccountConfig,
  resolveAiCredentials,
  hasAnyAiProfileConfigured,
} from "./ai-settings.js";
import { appendSystemLog } from "./system-log.js";
import { toChineseError } from "./error-zh.js";
import { prepareRelatedPostImages } from "./ai-post-images.js";
import { setAiRunProgress, scheduleClearAiRunProgress } from "./ai-run-progress.js";
import {
  getAccountPublishedTexts,
  isDuplicatePostText,
} from "./ai-duplicate.js";
import {
  pickRandomAllBinanceTokenPair,
  TOKEN_MODE_RANDOM_ALL,
  normalizeTokenMode,
  beginRandomAllTokenSession,
  endRandomAllTokenSession,
  warmupMarketTickerCaches,
} from "./crypto-context.js";

let timer = null;
let running = false;
let cancelRequested = false;
let lastStatus = { running: false, lastTickAt: null, lastResult: null };

const RUN_COOLDOWN_MS = 120000;

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 可被取消打断的等待（取消托管时不用干等到条间间隔结束） */
async function delayCancellable(ms, stepMs = 200) {
  const total = Math.max(0, Number(ms) || 0);
  const step = Math.max(50, Number(stepMs) || 200);
  let waited = 0;
  while (waited < total) {
    if (cancelRequested) return false;
    const chunk = Math.min(step, total - waited);
    await delay(chunk);
    waited += chunk;
  }
  return !cancelRequested;
}

/** 请求结束当前托管轮次（账号循环会尽快停下；进行中的 AI 请求也会打断） */
export function requestAiHostCancel() {
  cancelRequested = true;
  abortActiveAiRequest("已取消托管");
  try {
    setAiRunProgress("cancel", "已取消托管，正在结束当前任务…");
  } catch {
    // ignore
  }
}

export function isAiHostRunActive() {
  return running;
}

export function isAiHostCancelRequested() {
  return cancelRequested;
}

function shouldRunNow(settings, now = Date.now()) {
  if (!settings.enabled || !hasAnyAiProfileConfigured(settings)) return false;
  if (!canRunAiToday(settings)) return false;
  if (!settings.lastRunAt) return true;
  const intervalMs = settings.intervalMinutes * 60 * 1000;
  return now - settings.lastRunAt >= intervalMs;
}

/** 状态栏用：简要说明哪些账号失败、为什么（过长则截断） */
function formatAccountFailHint(accountErrors = [], maxLen = 120) {
  if (!accountErrors.length) return "";
  const briefs = accountErrors.map((item) => {
    const name = getAccountName(item.accountId) || "账号";
    const reason = String(item.error || "未知错误").replace(/\s+/g, " ").trim();
    const short =
      reason.length > maxLen ? `${reason.slice(0, maxLen).replace(/[，。；、\s]+$/, "")}…` : reason;
    return `「${name}」${short}`;
  });
  return `，${accountErrors.length} 个账号失败：${briefs.join("；")}`;
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

  // 定时任务：先预览下一批（成功跑完后再推进），避免失败也跳号
  const concurrency = Math.max(1, Math.min(parseInt(settings.hostConcurrency, 10) || 3, 8));
  return peekNextHostedBatch(settings, concurrency);
}

async function runPool(items, concurrency, worker) {
  const limit = Math.max(1, Math.min(Number(concurrency) || 1, items.length || 1));
  let cursor = 0;
  const runners = Array.from({ length: limit }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

function buildRuntimeSettings(settings, hostConfig, overrides = {}) {
  const creds = resolveAiCredentials({ hostConfig, settings, overrides });
  const selectedTokens = overrides.selectedTokens ?? hostConfig.selectedTokens;
  const tokenMode = normalizeTokenMode(
    overrides.tokenMode ?? hostConfig.tokenMode,
    selectedTokens,
  );
  return {
    tokenMode,
    selectedTokens,
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

async function resolveTokensForDraft(runtimeSettings) {
  if (runtimeSettings.tokenMode === TOKEN_MODE_RANDOM_ALL) {
    // 直接用软件内「代币地址列表」，不联网拉币安
    return pickRandomAllBinanceTokenPair({ recentPairs: getRecentTokenPairs() });
  }
  return runtimeSettings.selectedTokens || [];
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
  prepareImages = null,
}) {
  const avoidPool = settings.preventDuplicatePosts !== false
    ? [...existingTexts, ...recentTexts]
    : recentTexts;
  const maxAttempts = settings.preventDuplicatePosts !== false ? 3 : 1;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const topic = runtimeSettings.topic || pickAiTopic(settings);
    const selectedTokens = await resolveTokensForDraft(runtimeSettings);
    const draft = await generateSquarePost({
      apiKey: runtimeSettings.apiKey,
      provider: runtimeSettings.provider,
      baseUrl: runtimeSettings.baseUrl,
      model: runtimeSettings.model,
      topic,
      recentTexts: avoidPool,
      recentPairs: getRecentTokenPairs(),
      recentContentStyles,
      selectedTokens,
      marketSentiment: runtimeSettings.marketSentiment,
      contentStyles: runtimeSettings.contentStyles,
      tokenIndex,
      // 仅成功路径会用到配图；重试时也并行准备，总体仍比串行快
      prepareImages: attempt === 0 ? prepareImages : null,
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
    if (cancelRequested) {
      appendSystemLog(`[AI托管] 已取消，账号「${getAccountName(accountId)}」停止后续发帖`, {
        type: "info",
        source: "ai-host",
      });
      break;
    }
    if (!canAccountRunAiToday(readAiSettings(), accountId)) {
      appendSystemLog(`[AI托管] 账号「${getAccountName(accountId)}」今日额度已满，跳过后续条数`, {
        type: "info",
        source: "ai-host",
      });
      break;
    }

    setAiRunProgress("write", `正在为「${getAccountName(accountId)}」拉取行情并请求 AI 写稿…`);

    const prepareImages =
      shouldPublish && settings.attachRelatedImages !== false
        ? ({ focusTokens, newsImageUrl }) =>
            prepareRelatedPostImages({
              focusTokens,
              uploadsDir,
              maxImages: 2,
              newsImageUrl,
            })
        : null;

    const draft = await generateHostedDraft({
      settings,
      runtimeSettings,
      recentTexts,
      recentContentStyles,
      existingTexts,
      tokenIndex: i,
      prepareImages,
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

    // 配图已在写稿时并行准备；失败时再补一次
    let imagePaths = Array.isArray(draft.imagePaths) ? draft.imagePaths : [];
    if (settings.attachRelatedImages !== false && !imagePaths.length) {
      setAiRunProgress("images", "正在补生成配图（网站截图）…");
      try {
        imagePaths = await prepareRelatedPostImages({
          focusTokens: draft.focusTokens || [],
          uploadsDir,
          maxImages: 2,
          newsImageUrl: draft.context?.leadArticle?.imageUrl || "",
        });
      } catch (err) {
        appendSystemLog(`配图下载失败，将改为纯文字发布：${toChineseError(err)}`, {
          type: "warn",
          source: "ai-host",
        });
        imagePaths = [];
      }
    }
    if (settings.attachRelatedImages !== false && !imagePaths.length) {
      appendSystemLog(
        `[AI托管] 「${getAccountName(accountId)}」未拿到可用配图（新闻图/行情截图均失败），将纯文字发布`,
        { type: "warn", source: "ai-host" },
      );
    } else if (imagePaths.length) {
      appendSystemLog(
        `[AI托管] 「${getAccountName(accountId)}」已配图 ${imagePaths.length} 张，准备发布`,
        { type: "info", source: "ai-host" },
      );
    }

    setAiRunProgress("publish", `正在发布到币安广场（${getAccountName(accountId)}）…`);

    if (cancelRequested) {
      appendSystemLog(`[AI托管] 已取消，跳过账号「${getAccountName(accountId)}」剩余发布`, {
        type: "info",
        source: "ai-host",
      });
      break;
    }

    if (!tryClaimTodayPublishSlot(1, accountId)) {
      appendSystemLog(`[AI托管] 账号「${getAccountName(accountId)}」今日发帖已达上限，跳过`, {
        type: "warn",
        source: "ai-host",
      });
      break;
    }

    let result;
    try {
      // 发帖已在 publishPost 内进全局队列（含预检/退避），此处不再套一层
      const proxyUrl = resolveAccountProxy(accountId);
      const cookie = getAccountCookie(accountId);
      let pathsForPublish = imagePaths;
      try {
        if (pathsForPublish.length) {
          setAiRunProgress("images", `正在上传配图并发布（${getAccountName(accountId)}）…`);
        }
        result = await publishPost(
          apiKey,
          { text: draft.text, title: "", imagePaths: pathsForPublish },
          uploadsDir,
          (info) => {
            if (info?.message) setAiRunProgress(info.stage || "publish", info.message);
          },
          { proxyUrl, cookie },
        );
        await delay(700);
      } catch (err) {
        // 仅配图相关失败才降级纯文字；确认未知绝不能再发一次
        const isUncertain = err?.code === "PUBLISH_CONFIRMATION_UNKNOWN";
        const isImageIssue =
          pathsForPublish.length > 0 &&
          !isUncertain &&
          /图片|配图|上传|S3|presign|image|处理超时/i.test(String(err?.message || err || ""));
        if (isImageIssue) {
          appendSystemLog(`配图上传失败，改纯文字重试：${toChineseError(err)}`, {
            type: "warn",
            source: "ai-host",
          });
          pathsForPublish = [];
          imagePaths = [];
          result = await publishPost(
            apiKey,
            { text: draft.text, title: "", imagePaths: [] },
            uploadsDir,
            (info) => {
              if (info?.message) setAiRunProgress(info.stage || "publish", info.message);
            },
            { proxyUrl, cookie },
          );
          await delay(700);
        } else {
          throw err;
        }
      }
    } catch (err) {
      // 可能已发出但确认失败：保留今日额度，避免误判后继续超发
      if (err?.code !== "PUBLISH_CONFIRMATION_UNKNOWN") {
        releaseTodayPublishSlot(1, accountId);
      } else {
        appendSystemLog(
          `[AI托管] 「${getAccountName(accountId)}」发帖确认未知，已保留今日额度并建议到「已发布帖子」核对：${toChineseError(err)}`,
          { type: "warn", source: "ai-host" },
        );
      }
      throw err;
    }
    if (result?.publishStatus === "confirmed_by_fetch") {
      appendSystemLog(
        `[AI托管] 「${getAccountName(accountId)}」VPN 回包中断后已自动核对确认发布成功`,
        { type: "info", source: "ai-host" },
      );
    }
    published.push({ text: draft.text, result, accountId, imageCount: imagePaths.length });
    if (result?.id) {
      cachePublishedPost(accountId, {
        id: result.id,
        text: draft.text,
        title: "",
        shareLink: result.shareLink,
        publishedAt: Date.now(),
        source: "ai-hosted",
      });
    } else if (result) {
      appendSystemLog(
        `[AI托管] 「${getAccountName(accountId)}」提交后未拿到帖子 ID，请到「已发布帖子」核对，勿重复重发`,
        { type: "warn", source: "ai-host" },
      );
    }
    existingTexts.unshift(draft.text);

    if (i < runCount - 1) {
      await delayCancellable(getPublishDelayMs(settings));
      if (cancelRequested) break;
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
  if (!canRunAiToday(settings)) throw new Error("已达到今日 AI 发帖上限（每个启用账号均已发满）");

  const targets = resolveHostedTargets(settings, overrides);
  const shouldAdvanceRotation = !overrides.allAccounts && !overrides.accountId;
  const shouldPublish = publish ?? settings.autoPublish;
  const runCount = Math.max(1, Math.min(parseInt(count, 10) || settings.postsPerRun || 1, 5));
  const concurrency = Math.max(1, Math.min(parseInt(settings.hostConcurrency, 10) || 3, 8));

  running = true;
  cancelRequested = false;
  markRunStarted();
  beginRandomAllTokenSession();
  lastStatus = { running: true, lastTickAt: Date.now(), lastResult: null };
  setAiRunProgress(
    "start",
    targets.length > 1
      ? `已开始：${targets.length} 个账号，并行 ${Math.min(concurrency, targets.length)} 路写稿…`
      : "已开始：准备托管任务…",
  );

  // 启动托管：先拉最新行情缓存（写稿/代币列表共用）
  setAiRunProgress("market", "正在更新币安最新行情…");
  try {
    await warmupMarketTickerCaches();
  } catch {
    // 预热失败不阻断，各账号仍会自行拉取
  }

  const generated = [];
  const published = [];
  const accountErrors = [];
  let lastTokenPair = null;

  try {
    await runPool(targets, concurrency, async (hostConfig, index) => {
      if (cancelRequested) return;
      if (!canAccountRunAiToday(readAiSettings(), hostConfig.accountId)) return;
      // 轻微错开启动，进一步削峰
      if (index > 0 && concurrency > 1) {
        await delay(Math.min(800, 120 * index));
      }
      setAiRunProgress(
        "write",
        `并行 ${Math.min(concurrency, targets.length)} 路 · 账号 ${index + 1}/${targets.length}「${getAccountName(hostConfig.accountId)}」…`,
      );
      try {
        const runtimeSettings = buildRuntimeSettings(settings, hostConfig, overrides);
        const pair = await runHostedAccountCycle({
          settings,
          hostConfig,
          runtimeSettings,
          uploadsDir,
          shouldPublish,
          runCount,
          generated,
          published,
        });
        if (pair) lastTokenPair = pair;
      } catch (err) {
        const zh = toChineseError(err);
        const cancelled =
          cancelRequested || /已取消托管|socket hang up|ECONNRESET|aborted|AbortError/i.test(zh);
        if (cancelled) {
          appendSystemLog(`[AI托管] 账号「${getAccountName(hostConfig.accountId)}」因取消而中止`, {
            type: "info",
            source: "ai-host",
          });
          return;
        }
        accountErrors.push({ accountId: hostConfig.accountId, error: zh });
        appendSystemLog(`[AI托管] 账号「${getAccountName(hostConfig.accountId)}」失败：${zh}`, {
          type: "err",
          source: "ai-host",
        });
      }
    });

    if (shouldAdvanceRotation && targets.length && !cancelRequested) {
      // 按本轮实际触达账号推进（成功发布 + 明确失败），取消中止时不跳号
      const touched = new Set([
        ...published.map((p) => p.accountId).filter(Boolean),
        ...accountErrors.map((e) => e.accountId).filter(Boolean),
      ]);
      if (touched.size) advanceHostRotationBy(Math.min(targets.length, touched.size));
    }

    if (!generated.length && !published.length && accountErrors.length) {
      throw new Error(accountErrors.map((item) => item.error).filter(Boolean).join("；") || "托管运行失败");
    }

    // 全员跳过（额度满/取消等）且无产出：只记运行时间，不钉 lastError（避免整栏误报红）
    if (!generated.length && !published.length && !accountErrors.length) {
      const skipMsg = cancelRequested
        ? "本轮已取消，未生成内容"
        : "本轮无可发账号（可能已达每日上限或未启用托管账号）";
      recordAiRun({ success: false, skipped: true });
      const result = {
        ok: true,
        skipped: true,
        generated,
        published,
        errors: accountErrors,
        autoPublish: shouldPublish,
        cancelled: cancelRequested,
        concurrency: Math.min(concurrency, targets.length),
        accountIds: targets.map((item) => item.accountId),
        message: skipMsg,
      };
      lastStatus = { running: false, lastTickAt: Date.now(), lastResult: result };
      setAiRunProgress("done", result.message);
      appendSystemLog(`[AI托管] ${result.message}`, { type: "info", source: "ai-host" });
      return result;
    }

    const failHint = formatAccountFailHint(accountErrors);
    const cancelHint = cancelRequested ? "（已取消，本轮提前结束）" : "";
    const allPairs = generated
      .map((item) => item.focusTokens)
      .filter((p) => Array.isArray(p) && p.length >= 2);
    // 部分失败时：有成功发布就不把错误钉死在状态栏（避免整栏一直红）；详情已在本轮结果与日志里
    recordAiRun({
      success: true,
      tokenPair: lastTokenPair,
      tokenPairs: allPairs,
      error:
        accountErrors.length && !published.length
          ? `部分账号失败：${accountErrors.map((item) => item.error).filter(Boolean).join("；")}`
          : null,
    });
    const result = {
      ok: true,
      generated,
      published,
      errors: accountErrors,
      autoPublish: shouldPublish,
      cancelled: cancelRequested,
      concurrency: Math.min(concurrency, targets.length),
      accountIds: targets.map((item) => item.accountId),
      message: shouldPublish
        ? `已为 ${targets.length} 个账号生成 ${generated.length} 条，成功发布 ${published.length} 条（并行 ${Math.min(concurrency, targets.length)}）${failHint}${cancelHint}`
        : `已为 ${targets.length} 个账号生成 ${generated.length} 条草稿（并行 ${Math.min(concurrency, targets.length)}）${failHint}${cancelHint}`,
    };
    lastStatus = { running: false, lastTickAt: Date.now(), lastResult: result };
    setAiRunProgress("done", result.message);
    appendSystemLog(`[AI托管] ${result.message}`, {
      type: accountErrors.length ? "warn" : "ok",
      source: "ai-host",
    });
    return result;
  } catch (err) {
    const zh = toChineseError(err);
    recordAiRun({ success: false, error: zh });
    lastStatus = { running: false, lastTickAt: Date.now(), lastResult: { ok: false, error: zh } };
    const names = targets.map((item) => getAccountName(item.accountId)).filter(Boolean).join("、");
    setAiRunProgress("error", zh);
    appendSystemLog(`[AI托管] 失败${names ? `（${names}）` : ""}：${zh}`, {
      type: "err",
      source: "ai-host",
    });
    throw new Error(zh);
  } finally {
    endRandomAllTokenSession();
    // 托管完整一轮后再刷一次行情，供下次写稿 / 代币列表使用
    warmupMarketTickerCaches().catch(() => {});
    running = false;
    cancelRequested = false;
    scheduleClearAiRunProgress(8000);
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
