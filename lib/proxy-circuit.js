/**
 * 代理熔断：连续失败后短时拒绝发帖预检，避免在死节点上反复撞墙。
 * 同类 VPN 工具常见做法：失败计数 → 打开熔断 → 冷却后半开试探。
 */
const FAILURE_THRESHOLD = 3;
const OPEN_MS = 45_000;
const states = new Map();

function keyOf(proxyUrl = "") {
  return String(proxyUrl || "").trim() || "direct";
}

export function getProxyCircuitState(proxyUrl = "") {
  const key = keyOf(proxyUrl);
  const state = states.get(key);
  if (!state) return { open: false, failures: 0, remainMs: 0, lastError: "" };
  if (state.openedAt) {
    const remainMs = Math.max(0, OPEN_MS - (Date.now() - state.openedAt));
    if (remainMs <= 0) {
      // 半开：允许下一次试探
      state.openedAt = 0;
      state.failures = Math.max(1, FAILURE_THRESHOLD - 1);
      states.set(key, state);
      return { open: false, failures: state.failures, remainMs: 0, lastError: state.lastError || "", halfOpen: true };
    }
    return {
      open: true,
      failures: state.failures,
      remainMs,
      lastError: state.lastError || "",
    };
  }
  return { open: false, failures: state.failures || 0, remainMs: 0, lastError: state.lastError || "" };
}

export function assertProxyCircuitClosed(proxyUrl = "") {
  const state = getProxyCircuitState(proxyUrl);
  if (!state.open) return state;
  const sec = Math.ceil(state.remainMs / 1000);
  const err = new Error(
    `代理链路熔断中（约 ${sec}s 后自动恢复）。当前 VPN/代理节点连续失败，请先在 Clash/VPN 换一个节点，再发帖。${
      state.lastError ? `最近原因：${state.lastError}` : ""
    }`,
  );
  err.code = "PROXY_CIRCUIT_OPEN";
  throw err;
}

export function recordProxySuccess(proxyUrl = "") {
  states.delete(keyOf(proxyUrl));
}

export function recordProxyFailure(proxyUrl = "", err = null) {
  const key = keyOf(proxyUrl);
  const prev = states.get(key) || { failures: 0, openedAt: 0, lastError: "" };
  const failures = (prev.failures || 0) + 1;
  const lastError = String(err?.message || err || prev.lastError || "").slice(0, 180);
  const next = { failures, openedAt: prev.openedAt || 0, lastError };
  if (failures >= FAILURE_THRESHOLD) {
    next.openedAt = Date.now();
  }
  states.set(key, next);
  return getProxyCircuitState(proxyUrl);
}

export function resetProxyCircuit(proxyUrl = "") {
  states.delete(keyOf(proxyUrl));
}
