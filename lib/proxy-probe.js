/**
 * 代理出网检测（不访问币安）——尽量快：
 * - 短超时
 * - 多个 IP 查询站竞速，谁先返回用谁
 * - 当前协议优先；失败后再并行试其他协议
 */
import net from "net";
import { transportFetch, measureProxyConnectLatency } from "./http-transport.js";
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

function decodeHttpChunked(body) {
  let out = Buffer.alloc(0);
  let i = 0;
  while (i < body.length) {
    const lineEnd = body.indexOf("\r\n", i);
    if (lineEnd < 0) break;
    const size = parseInt(body.slice(i, lineEnd).toString("utf8"), 16);
    if (!Number.isFinite(size) || size <= 0) break;
    const start = lineEnd + 2;
    out = Buffer.concat([out, body.slice(start, start + size)]);
    i = start + size + 2;
  }
  return out;
}

function parseHttpResponse(buf) {
  const sep = buf.indexOf("\r\n\r\n");
  if (sep < 0) throw new Error("无效 HTTP 响应");
  const head = buf.slice(0, sep).toString("utf8");
  let body = buf.slice(sep + 4);
  const status = Number(/HTTP\/\d\.\d\s+(\d+)/i.exec(head)?.[1] || 0);
  const cl = /Content-Length:\s*(\d+)/i.exec(head);
  if (cl) body = body.slice(0, Number(cl[1]));
  else if (/Transfer-Encoding:\s*chunked/i.test(head)) body = decodeHttpChunked(body);
  return { status, body: body.toString("utf8") };
}

/** Clash Verge / Mihomo：外部控制口常关，改走命名管道 */
function clashHttpOverPipe(pipePath, reqPath, { timeoutMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipePath);
    let buf = Buffer.alloc(0);
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error("管道超时")), timeoutMs);

    const tryParse = () => {
      const sep = buf.indexOf("\r\n\r\n");
      if (sep < 0) return false;
      const head = buf.slice(0, sep).toString("utf8");
      const cl = /Content-Length:\s*(\d+)/i.exec(head);
      if (!cl) return false;
      const need = sep + 4 + Number(cl[1]);
      if (buf.length < need) return false;
      try {
        finish(resolve, parseHttpResponse(buf.slice(0, need)));
      } catch (err) {
        finish(reject, err);
      }
      return true;
    };

    socket.on("connect", () => {
      socket.write(
        `GET ${reqPath} HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept: application/json\r\nConnection: close\r\n\r\n`,
      );
    });
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      tryParse();
    });
    socket.on("end", () => {
      if (settled) return;
      try {
        finish(resolve, parseHttpResponse(buf));
      } catch (err) {
        finish(reject, err);
      }
    });
    socket.on("error", (err) => finish(reject, err));
  });
}

async function clashHttpGet(base, reqPath, { timeoutMs = 3000 } = {}) {
  if (base.kind === "pipe") {
    return clashHttpOverPipe(base.path, reqPath, { timeoutMs });
  }
  const res = await transportFetch(`http://127.0.0.1:${base.port}${reqPath}`, {
    method: "GET",
    proxyUrl: "",
    timeoutMs,
    retries: false,
    headers: base.secret ? { Authorization: `Bearer ${base.secret}` } : undefined,
  });
  return { status: res.status, body: await res.text() };
}

function isClashGroupType(type) {
  return /^(Selector|URLTest|Fallback|LoadBalance)$/i.test(String(type || ""));
}

function walkClashNowChain(proxies, startName) {
  const deny = new Set(["DIRECT", "REJECT", "REJECT-DROP", "PASS", "COMPATIBLE"]);
  let name = String(startName || "").trim();
  if (!name || deny.has(name)) return "";
  for (let depth = 0; depth < 8; depth += 1) {
    const node = proxies[name];
    if (!node?.now || deny.has(node.now)) break;
    name = node.now;
  }
  if (!name || deny.has(name)) return "";
  return name;
}

/**
 * 解析 Clash/Mihomo「实际出站节点」。
 * GLOBAL 常被单独点成某个节点，但规则流量多半走订阅主分组（如「三毛机场」→「自动选择」）。
 * 因此优先非 GLOBAL 的 Selector / URLTest，GLOBAL 仅作最后兜底。
 */
function resolveClashLeafName(proxies) {
  if (!proxies || typeof proxies !== "object") return "";

  const preferredEntries = [
    "PROXY",
    "Proxy",
    "proxy",
    "节点选择",
    "手动选择",
    "♻️ 手动选择",
    "🚀 节点选择",
    "最终节点",
    "Final",
  ];
  for (const key of preferredEntries) {
    const leaf = walkClashNowChain(proxies, proxies[key]?.now);
    if (leaf) return leaf;
  }

  const groups = Object.entries(proxies).filter(
    ([name, node]) => name !== "GLOBAL" && isClashGroupType(node?.type),
  );

  // 主分组常指向「自动选择」URLTest
  for (const [, node] of groups) {
    const now = String(node?.now || "");
    if (proxies[now]?.type === "URLTest" || /自动选择|auto\s*select|url.?test/i.test(now)) {
      const leaf = walkClashNowChain(proxies, now);
      if (leaf) return leaf;
    }
  }

  // 直接读 URLTest 当前节点（与界面「自动选择」一致）
  for (const [, node] of groups) {
    if (node?.type === "URLTest" && node?.now) {
      const leaf = walkClashNowChain(proxies, node.now);
      if (leaf) return leaf;
    }
  }

  // 其它非 GLOBAL Selector
  for (const [name, node] of groups) {
    if (node?.type !== "Selector") continue;
    const leaf = walkClashNowChain(proxies, node.now || name);
    if (leaf) return leaf;
  }

  // 最后才用 GLOBAL（容易与界面当前节点不一致）
  return walkClashNowChain(proxies, proxies.GLOBAL?.now);
}

function delayFromHistory(node) {
  const hist = Array.isArray(node?.history) ? node.history : [];
  for (let i = hist.length - 1; i >= 0; i -= 1) {
    const delay = Number(hist[i]?.delay);
    if (Number.isFinite(delay) && delay > 0) return delay;
  }
  return null;
}

/** 常见 Clash 兼容控制面（Verge / Meta / CFW / sing-box Clash API / v2rayN 等） */
function clashControllerBases() {
  const pipes =
    process.platform === "win32"
      ? [
          "verge-mihomo",
          "mihomo",
          "clash-meta",
          "clash-verge",
          "ClashMetaCore",
          "sing-box-clash",
        ].map((name) => ({ kind: "pipe", path: `\\\\.\\pipe\\${name}` }))
      : [];
  const ports = [9097, 9090, 9091, 9092, 9093, 8787, 33211, 9080, 6170];
  return [...pipes, ...ports.map((port) => ({ kind: "tcp", port }))];
}

async function delayFromClashBase(base, timeoutMs) {
  const ms = Math.max(2000, Math.min(Number(timeoutMs) || 5000, 8000));
  const testUrl = encodeURIComponent("http://www.gstatic.com/generate_204");
  const listRes = await clashHttpGet(base, "/proxies", { timeoutMs: 1200 });
  if (listRes.status === 401 || listRes.status === 403) return null;
  if (listRes.status < 200 || listRes.status >= 300) return null;
  let proxies = {};
  try {
    proxies = JSON.parse(listRes.body)?.proxies || {};
  } catch {
    return null;
  }
  const name = resolveClashLeafName(proxies);
  if (!name) return null;

  try {
    const delayRes = await clashHttpGet(
      base,
      `/proxies/${encodeURIComponent(name)}/delay?timeout=${ms}&url=${testUrl}`,
      { timeoutMs: ms + 1500 },
    );
    if (delayRes.status >= 200 && delayRes.status < 300) {
      let delay = NaN;
      try {
        delay = Number(JSON.parse(delayRes.body)?.delay);
      } catch {
        delay = NaN;
      }
      if (Number.isFinite(delay) && delay > 0) {
        return {
          ok: true,
          latencyMs: delay,
          error: null,
          source: "clash",
          nodeName: name,
          kindLabel: "节点测速",
        };
      }
    }
  } catch {
    // fall through to history
  }

  const histDelay = delayFromHistory(proxies[name]);
  if (histDelay == null) return null;
  return {
    ok: true,
    latencyMs: histDelay,
    error: null,
    source: "clash",
    nodeName: name,
    kindLabel: "节点测速",
  };
}

/**
 * 读取 Clash 兼容内核「当前节点」延迟（与 VPN 软件列表同口径）。
 * 覆盖：Clash Verge / Mihomo 命名管道、常见外部控制口；其它软件无接口时走出网回退。
 */
async function measureClashNodeDelay(timeoutMs = 5000) {
  const bases = clashControllerBases();
  // 管道优先串行（几乎必中 Verge）；TCP 端口并行竞速
  for (const base of bases.filter((b) => b.kind === "pipe")) {
    try {
      const hit = await delayFromClashBase(base, timeoutMs);
      if (hit) return hit;
    } catch {
      // next
    }
  }

  const tcpBases = bases.filter((b) => b.kind === "tcp");
  // 无 Clash 控制口时并行探测会拖慢回退；整体再加一层竞速上限
  const tcpProbe = Promise.all(
    tcpBases.map(async (base) => {
      try {
        return await delayFromClashBase(base, Math.min(timeoutMs, 3500));
      } catch {
        return null;
      }
    }),
  ).then((results) => results.find(Boolean) || null);

  try {
    return await Promise.race([
      tcpProbe,
      new Promise((resolve) => setTimeout(() => resolve(null), 4200)),
    ]);
  } catch {
    return null;
  }
}

/**
 * 测本地 VPN 延迟：
 * 1) 优先 Clash 当前节点 delay（与 VPN 软件同口径）
 * 2) 否则测经全局代理的轻量出网延迟（可能与列表某节点不一致）
 */
export async function measureProxyLatency(proxyUrl = "", { timeoutMs = 5000 } = {}) {
  const ms = Math.max(2000, Math.min(Number(timeoutMs) || 5000, 8000));

  const fromClash = await measureClashNodeDelay(ms);
  if (fromClash) return fromClash;

  const probeUrls = ["http://1.0.0.1/", "http://1.1.1.1/"];
  const started = Date.now();
  try {
    await Promise.any(
      probeUrls.map(async (url) => {
        const res = await transportFetch(url, {
          method: "GET",
          proxyUrl: proxyUrl || "",
          timeoutMs: ms,
          retries: false,
        });
        if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
        try {
          await res.text();
        } catch {
          // ignore
        }
        return true;
      }),
    );
    return {
      ok: true,
      latencyMs: Date.now() - started,
      error: null,
      source: "outbound",
      nodeName: null,
      kindLabel: "出网测速",
    };
  } catch (err) {
    try {
      const latencyMs = await measureProxyConnectLatency(proxyUrl, { timeoutMs: ms });
      return {
        ok: true,
        latencyMs,
        error: null,
        source: "connect",
        nodeName: null,
        kindLabel: "出网测速",
      };
    } catch {
      const errors = err?.errors || [];
      const first = errors[0] || err;
      return {
        ok: false,
        latencyMs: null,
        error: toChineseError(first) || first?.message || "测速失败",
        source: "none",
        nodeName: null,
        kindLabel: "测速失败",
      };
    }
  }
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
