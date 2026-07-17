/**
 * 发帖前网络就绪检测 + 隧道预热。
 * 对标依赖 VPN 的桌面工具：先确认出口可用，再做不可幂等业务，而不是撞上再补救。
 * 预检失败时尝试 Clash 自动换节点后再预热。
 */
import { transportFetch, measureProxyConnectLatency, isTransientNetworkError } from "./http-transport.js";
import {
  assertProxyCircuitClosed,
  recordProxySuccess,
  recordProxyFailure,
  getProxyCircuitState,
  resetProxyCircuit,
} from "./proxy-circuit.js";
import { measureProxyLatency, tryFailoverClashNode, refreshClashUrlTestDelay } from "./proxy-probe.js";

const BINANCE_WARM_URL = "https://www.binance.com/bapi/composite/v2/public/pgc/openApi/image/presignedUrl";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function canUseFallbackProxy(primaryUrl = "", fallbackUrl = "") {
  const a = String(primaryUrl || "").trim();
  const b = String(fallbackUrl || "").trim();
  return Boolean(b) && b !== a;
}

/**
 * 预热到币安的代理隧道（CONNECT/SOCKS + 一次轻量请求），降低发帖首包冷启动超时。
 */
export async function warmPublishPath(proxyUrl = "", { timeoutMs = 12000 } = {}) {
  const connectTimeout = Math.min(8000, Math.max(3000, Number(timeoutMs) || 12000));
  if (proxyUrl) {
    await measureProxyConnectLatency(proxyUrl, { timeoutMs: connectTimeout });
  }

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
  return true;
}

async function tryRecoverWithClashFailover(proxyUrl, onProgress) {
  onProgress?.({ stage: "network_failover", message: "当前节点不通，正在尝试自动切换 VPN 节点…" });
  let switched = null;
  try {
    switched = await tryFailoverClashNode({ timeoutMs: 4500, maxCandidates: 6 });
  } catch {
    switched = null;
  }

  if (switched?.to) {
    onProgress?.({
      stage: "network_failover",
      message: `已自动切换 VPN 节点：${switched.from || "原节点"} → ${switched.to}`,
    });
    resetProxyCircuit(proxyUrl || "");
    resetProxyCircuit("");
    await sleep(600);
    return switched;
  }

  // Selector 切不动时，触发一次 URLTest 测速刷新（由 Clash 自己选优）
  onProgress?.({ stage: "network_failover", message: "正在刷新 Clash 自动选择组延迟…" });
  try {
    await refreshClashUrlTestDelay({ timeoutMs: 4500 });
    resetProxyCircuit(proxyUrl || "");
    await sleep(500);
  } catch {
    // ignore
  }
  return null;
}

/**
 * 发帖前硬门禁：连通性 + 预热。失败时抛错，此时尚未提交帖子，可安全重试。
 * 熔断打开时仍会尝试 Clash 换节点（避免死等 45 秒）。
 */
export async function assertPublishNetworkReady(proxyUrl = "", { timeoutMs = 14000, onProgress = null } = {}) {
  const runWarm = async ({ skipCircuitCheck = false } = {}) => {
    if (!skipCircuitCheck) assertProxyCircuitClosed(proxyUrl);

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
        `发帖前检测失败：当前代理不可用（${detail}）。请确认 VPN/Clash 已开启并换一个节点后再发。`,
      );
      err.code = "PROXY_NOT_READY";
      err.latencyInfo = latencyInfo;
      throw err;
    }

    onProgress?.({ stage: "network_warm", message: "正在预热到币安的代理隧道…" });
    await warmPublishPath(proxyUrl, { timeoutMs });
    recordProxySuccess(proxyUrl);
    return {
      ok: true,
      latencyMs: latencyInfo?.latencyMs ?? null,
      nodeName: latencyInfo?.nodeName || latencyInfo?.clashNode || "",
      circuit: getProxyCircuitState(proxyUrl),
    };
  };

  try {
    return await runWarm();
  } catch (firstErr) {
    const circuitOpen = firstErr?.code === "PROXY_CIRCUIT_OPEN";
    // 延迟探测失败不计入发帖熔断；真正预热失败才记
    if (!circuitOpen && firstErr?.code !== "PROXY_NOT_READY") {
      recordProxyFailure(proxyUrl, firstErr);
    } else if (!circuitOpen && /预热|warm|币安/i.test(String(firstErr?.message || ""))) {
      recordProxyFailure(proxyUrl, firstErr);
    }

    const switched = await tryRecoverWithClashFailover(proxyUrl, onProgress);
    try {
      // 换节点后跳过熔断检查（刚 reset），直接预热
      const result = await runWarm({ skipCircuitCheck: true });
      if (switched?.to) {
        result.failover = switched;
      }
      return result;
    } catch (secondErr) {
      recordProxyFailure(proxyUrl, secondErr);
      const msg = String(secondErr?.message || secondErr || "");
      const next = new Error(
        isTransientNetworkError(msg) || /超时|连接|代理|TLS|socket|熔断/i.test(msg)
          ? `发帖前预热失败：已尝试自动换 VPN 节点仍不通。请在 Clash 里换节点后再发。原因：${msg}`
          : `发帖前网络检测失败（已尝试自动换节点）：${msg}`,
      );
      next.code = "PROXY_NOT_READY";
      next.cause = secondErr;
      next.failoverTried = Boolean(switched?.to);
      throw next;
    }
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
