/**
 * 发帖前网络就绪检测 + 隧道预热。
 * - 代理本地连不上 / Clash 明确不可用：硬失败（可熔断）
 * - 仅「币安预热」超时、但代理延迟正常：软放行，继续发帖（避免误杀）
 * - 同一代理短时内只预热一次，避免并行账号同时打爆 Clash
 */
import { transportFetch, measureProxyConnectLatency, isTransientNetworkError } from "./http-transport.js";
import {
  assertProxyCircuitClosed,
  recordProxySuccess,
  recordProxyFailure,
  getProxyCircuitState,
} from "./proxy-circuit.js";
import { measureProxyLatency } from "./proxy-probe.js";

const BINANCE_WARM_URL = "https://www.binance.com/bapi/composite/v2/public/pgc/openApi/image/presignedUrl";
const WARM_CACHE_TTL_MS = 60_000;

/** @type {Map<string, { at: number, ok: boolean, inflight?: Promise<boolean> }>} */
const warmCache = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function proxyCacheKey(proxyUrl = "") {
  return String(proxyUrl || "").trim() || "direct";
}

export function canUseFallbackProxy(primaryUrl = "", fallbackUrl = "") {
  const a = String(primaryUrl || "").trim();
  const b = String(fallbackUrl || "").trim();
  return Boolean(b) && b !== a;
}

/**
 * 是否为「账号独立远程代理」（非本机 Clash）。
 * 用于：失败时禁止悄悄改走全局，避免页面配了独立 IP、实际却走专线-日本。
 */
export function isRemoteAccountProxy(proxyUrl = "") {
  const raw = String(proxyUrl || "").trim();
  if (!raw) return false;
  try {
    const u = new URL(raw);
    const host = String(u.hostname || "").toLowerCase();
    return host !== "127.0.0.1" && host !== "localhost" && host !== "::1";
  } catch {
    return !/127\.0\.0\.1|localhost/i.test(raw);
  }
}

/**
 * 发帖失败后是否允许改走 fallback（通常是本机全局代理）。
 * 规则：
 * - options.allowProxyFallback === false → 一律禁止（托管对独立代理会显式传 false）
 * - 主代理与 fallback 相同或 fallback 为空 → 禁止
 * - options.allowProxyFallback === true → 允许
 * - 主代理是独立远程 IP → 默认禁止回落全局
 * - 本机 Clash / 直连等 → 仍可按原逻辑回落
 */
export function shouldAllowProxyFallback(primaryUrl = "", fallbackUrl = "", options = {}) {
  if (options.allowProxyFallback === false) return false;
  if (!canUseFallbackProxy(primaryUrl, fallbackUrl)) return false;
  if (options.allowProxyFallback === true) return true;
  if (isRemoteAccountProxy(primaryUrl)) return false;
  return true;
}

/** Clash/出网延迟看起来正常时，不因币安预热超时硬拦发帖 */
export function isProxyLatencyHealthy(latencyInfo) {
  if (!latencyInfo || latencyInfo.ok === false) return false;
  const ms = Number(latencyInfo.latencyMs);
  return Number.isFinite(ms) && ms > 0 && ms < 15000;
}

/**
 * 预热到币安的代理隧道（CONNECT/SOCKS + 一次轻量请求），降低发帖首包冷启动超时。
 */
export async function warmPublishPath(proxyUrl = "", { timeoutMs = 12000 } = {}) {
  const connectTimeout = Math.min(8000, Math.max(3000, Number(timeoutMs) || 12000));
  if (proxyUrl) {
    try {
      await measureProxyConnectLatency(proxyUrl, { timeoutMs: connectTimeout });
    } catch (err) {
      const next = err instanceof Error ? err : new Error(String(err || "代理连接失败"));
      next.code = "PROXY_CONNECT_FAILED";
      throw next;
    }
  }

  try {
    const res = await transportFetch(BINANCE_WARM_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        clienttype: "binanceSkill",
      },
      body: JSON.stringify({ imageName: "warm.png" }),
      proxyUrl: proxyUrl || "",
      timeoutMs: Math.max(5000, Number(timeoutMs) || 12000),
      retries: false,
    });
    // 只要隧道通了拿到 HTTP 响应即可（Key 无效也没关系）
    await res.text().catch(() => "");
  } catch (err) {
    const next = err instanceof Error ? err : new Error(String(err || "币安预热失败"));
    if (!next.code) next.code = "BINANCE_WARM_FAILED";
    throw next;
  }
  return true;
}

/** 同一代理 60s 内复用预热结果；并发调用合并为一次 */
export async function warmPublishPathCached(proxyUrl = "", { timeoutMs = 12000 } = {}) {
  const key = proxyCacheKey(proxyUrl);
  const hit = warmCache.get(key);
  if (hit?.inflight) return hit.inflight;
  if (hit && hit.ok && Date.now() - hit.at < WARM_CACHE_TTL_MS) return true;

  const inflight = warmPublishPath(proxyUrl, { timeoutMs })
    .then(() => {
      warmCache.set(key, { at: Date.now(), ok: true });
      return true;
    })
    .catch((err) => {
      warmCache.set(key, { at: Date.now(), ok: false });
      throw err;
    });

  warmCache.set(key, { at: Date.now(), ok: false, inflight });
  return inflight;
}

/** 测试用：清空预热缓存 */
export function clearPublishWarmCache() {
  warmCache.clear();
}

/**
 * 发帖前网络门禁。
 * 代理明确不可用 → 抛错；币安预热失败但代理延迟正常 → 软放行。
 */
export async function assertPublishNetworkReady(proxyUrl = "", { timeoutMs = 14000, onProgress = null } = {}) {
  assertProxyCircuitClosed(proxyUrl);

  onProgress?.({ stage: "network_check", message: "正在检测 VPN/代理是否可用…" });

  let latencyInfo = null;
  try {
    latencyInfo = await measureProxyLatency(proxyUrl || "", { timeoutMs: Math.min(6000, timeoutMs) });
  } catch {
    // 延迟探测失败不直接判死，继续做币安预热
  }

  if (latencyInfo && latencyInfo.ok === false && proxyUrl) {
    const detail = latencyInfo.error || "代理延迟探测失败";
    const err = new Error(
      `发帖前检测失败：当前代理不可用（${detail}）。请在 Clash/VPN 里换一个可用节点后再发。`,
    );
    err.code = "PROXY_NOT_READY";
    err.latencyInfo = latencyInfo;
    recordProxyFailure(proxyUrl, err);
    throw err;
  }

  const proxyHealthy = isProxyLatencyHealthy(latencyInfo);

  onProgress?.({ stage: "network_warm", message: "正在预热到币安的代理隧道…" });
  try {
    await warmPublishPathCached(proxyUrl, { timeoutMs });
    recordProxySuccess(proxyUrl);
    return {
      ok: true,
      warmed: true,
      softContinue: false,
      latencyMs: latencyInfo?.latencyMs ?? null,
      nodeName: latencyInfo?.nodeName || latencyInfo?.clashNode || "",
      circuit: getProxyCircuitState(proxyUrl),
    };
  } catch (warmErr) {
    const msg = String(warmErr?.message || warmErr || "");
    const connectFailed = warmErr?.code === "PROXY_CONNECT_FAILED";

    // 本地代理都连不上：硬失败
    if (connectFailed) {
      recordProxyFailure(proxyUrl, warmErr);
      const remote = isRemoteAccountProxy(proxyUrl);
      const next = new Error(
        remote
          ? `发帖前检测失败：账号独立代理连不上（${msg}）。请到「账号管理」点「检测代理」，核对 IP/端口/账号密码或换节点。`
          : `发帖前检测失败：无法连接本地代理。请确认 Clash/VPN 已开启。原因：${msg}`,
      );
      next.code = "PROXY_NOT_READY";
      next.cause = warmErr;
      throw next;
    }

    // 代理延迟正常，仅币安预热慢/超时：不熔断，继续发帖
    if (proxyHealthy) {
      onProgress?.({
        stage: "network_warm",
        message: "币安预热超时，但当前节点延迟正常，继续尝试发帖…",
      });
      return {
        ok: true,
        warmed: false,
        softContinue: true,
        latencyMs: latencyInfo?.latencyMs ?? null,
        nodeName: latencyInfo?.nodeName || latencyInfo?.clashNode || "",
        circuit: getProxyCircuitState(proxyUrl),
        warmError: msg,
      };
    }

    // 没有健康延迟信号：仍硬失败，但文案区分「VPN 挂了」vs「到币安超时」
    recordProxyFailure(proxyUrl, warmErr);
    const looksTimeout = isTransientNetworkError(msg) || /超时|timeout|ETIMEDOUT/i.test(msg);
    const next = new Error(
      looksTimeout
        ? `发帖前预热失败：经代理访问币安超时。侧栏延迟正常时也可换节点后重试。原因：${msg}`
        : `发帖前网络检测失败：${msg}`,
    );
    next.code = "PROXY_NOT_READY";
    next.cause = warmErr;
    throw next;
  }
}

/**
 * 账号代理失败时，尝试全局代理（仅用于读接口 / 明确未发出的安全重试）。
 */
export async function withProxyFallback(primaryUrl, fallbackUrl, work) {
  try {
    return await work(primaryUrl || "");
  } catch (err) {
    if (!canUseFallbackProxy(primaryUrl, fallbackUrl)) throw err;
    const msg = String(err?.message || err || "");
    const retryable =
      err?.code === "PROXY_NOT_READY" ||
      err?.code === "PROXY_CIRCUIT_OPEN" ||
      isTransientNetworkError(msg) ||
      /超时|连接|代理|TLS|socket|重置|中断|熔断/i.test(msg);
    if (!retryable) throw err;
    await sleep(400);
    return work(fallbackUrl);
  }
}
