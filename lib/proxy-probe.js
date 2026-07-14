/**
 * 代理出网检测（不访问币安）——尽量快：
 * - 短超时
 * - 多个 IP 查询站竞速，谁先返回用谁
 * - 当前协议优先；失败后再并行试其他协议
 */
import { transportFetch } from "./http-transport.js";
import { buildProxyUrl, normalizeProxyConfig, isCustomProxyConfig } from "./proxy-config.js";
import { toChineseError } from "./error-zh.js";

const IP_CHECK_URLS = [
  "https://api.ipify.org?format=json",
  "https://ifconfig.me/ip",
];
/** 单次请求超时；协议不对时尽快失败去试下一个 */
const PROBE_TIMEOUT_MS = 3500;
/** 备选协议整体限时，避免拖太久 */
const FALLBACK_BUDGET_MS = 4500;

function uniqueTypes(types) {
  const seen = new Set();
  const out = [];
  for (const type of types) {
    if (!type || seen.has(type)) continue;
    seen.add(type);
    out.push(type);
  }
  return out;
}

function candidateTypes(selectedType) {
  const type = String(selectedType || "http").toLowerCase();
  if (type === "socks5") return uniqueTypes(["socks5", "http"]);
  if (type === "http" || type === "https") return uniqueTypes([type, "socks5"]);
  if (type === "ssh") return uniqueTypes(["socks5", "http"]);
  return uniqueTypes([type, "http", "socks5"]);
}

function parseExitIp(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  try {
    const ip = String(JSON.parse(raw)?.ip || "").trim();
    if (ip) return ip;
  } catch {
    // plain text
  }
  const match = raw.match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/);
  return match?.[1] || "";
}

async function fetchExitIpOnce(proxyUrl, checkUrl) {
  const res = await transportFetch(checkUrl, {
    method: "GET",
    proxyUrl,
    timeoutMs: PROBE_TIMEOUT_MS,
    retries: false,
  });
  const ip = parseExitIp(await res.text());
  if (!ip) throw new Error("代理已连通，但未能识别出口 IP");
  return ip;
}

/** 多个查 IP 接口并行竞速 */
async function fetchExitIp(proxyUrl) {
  try {
    return await Promise.any(IP_CHECK_URLS.map((url) => fetchExitIpOnce(proxyUrl, url)));
  } catch (err) {
    const errors = err?.errors || [];
    const first = errors[0];
    throw first || err || new Error("无法获取出口 IP");
  }
}

function withTimeout(promise, ms, label = "检测超时") {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function typeSwitchHint(selectedType, effectiveType) {
  if (!effectiveType || effectiveType === selectedType) return "";
  return `已将可用协议识别为 ${effectiveType.toUpperCase()}（原选择 ${selectedType.toUpperCase()}），请点击「保存」固定。`;
}

function successResult(selectedType, type, exitIp) {
  const typeCorrected = type !== selectedType;
  const tip = typeSwitchHint(selectedType, type);
  return {
    ok: true,
    stage: "ok",
    selectedType,
    effectiveType: type,
    suggestedProxyType: type,
    typeCorrected,
    exitIp,
    message:
      `代理检测通过：出口 IP ${exitIp}。` +
      ` 本检测只验证代理出网，是否能访问币安请点「验证 Key」。` +
      (tip ? ` ${tip}` : ""),
  };
}

/**
 * 仅检测代理能否出网并拿到出口 IP；不连接币安。
 */
export async function probeProxy(proxyConfig = {}) {
  const base = normalizeProxyConfig(proxyConfig);
  if (!isCustomProxyConfig(base) || !base.host || !base.port) {
    return {
      ok: false,
      stage: "proxy",
      selectedType: base.type,
      message: "请先填写自定义代理的主机和端口",
    };
  }

  const selectedType = base.type;
  const types = candidateTypes(selectedType);
  const tried = [];

  // 1) 先测用户当前选的协议（通常 1～3 秒内出结果）
  const primaryUrl = buildProxyUrl({ ...base, type: selectedType });
  if (primaryUrl) {
    try {
      const exitIp = await fetchExitIp(primaryUrl);
      return successResult(selectedType, selectedType, exitIp);
    } catch (err) {
      tried.push({ type: selectedType, error: toChineseError(err) });
    }
  }

  // 2) 其余协议并行竞速，取最先成功的
  const fallbackTypes = types.filter((type) => type !== selectedType);
  if (fallbackTypes.length) {
    try {
      const winner = await withTimeout(
        Promise.any(
          fallbackTypes.map(async (type) => {
            const proxyUrl = buildProxyUrl({ ...base, type });
            if (!proxyUrl) throw new Error("代理配置无效");
            const exitIp = await fetchExitIp(proxyUrl);
            return { type, exitIp };
          }),
        ),
        FALLBACK_BUDGET_MS,
        "备选协议检测超时",
      );
      return successResult(selectedType, winner.type, winner.exitIp);
    } catch (err) {
      if (err?.errors) {
        for (let i = 0; i < fallbackTypes.length; i++) {
          const nested = err.errors[i];
          if (nested) tried.push({ type: fallbackTypes[i], error: toChineseError(nested) });
        }
      } else if (!tried.some((item) => item.type !== selectedType)) {
        for (const type of fallbackTypes) {
          tried.push({ type, error: toChineseError(err) });
        }
      }
    }
  }

  const detail = tried.map((item) => `${item.type.toUpperCase()}：${item.error}`).join("；");
  return {
    ok: false,
    stage: "proxy",
    selectedType,
    tried,
    message:
      `代理未能出网（已快速尝试 ${tried.map((t) => t.type.toUpperCase()).join(" / ") || "HTTP/Socks5"}），因此「代理方式」未切换。` +
      `请核对 IP/端口/账号密码，或换节点后重试。` +
      (detail ? ` 详情：${detail}` : ""),
  };
}
