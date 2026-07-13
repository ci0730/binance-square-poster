export const PROXY_TYPES = [
  { value: "global", label: "使用全局代理" },
  { value: "direct", label: "直连模式（不设置代理）" },
  { value: "http", label: "HTTP" },
  { value: "https", label: "HTTPS" },
  { value: "socks5", label: "Socks5" },
  { value: "ssh", label: "SSH" },
];

export const DEFAULT_PROXY_HOST = "127.0.0.1";
export const DEFAULT_PROXY_PORT = "7897";

export const DEFAULT_PROXY_CONFIG = {
  type: "global",
  host: "",
  port: "",
  username: "",
  password: "",
};

function decodePart(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return String(value || "");
  }
}

export function parseProxyQuickInput(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  const colonFormat = raw.match(/^(https?|socks5|ssh):\/\/([^:/]+):(\d+)(?::([^:]*))?(?::(.*))?$/i);
  if (colonFormat) {
    const [, type, host, port, username = "", password = ""] = colonFormat;
    return {
      type: type.toLowerCase() === "ssh" ? "ssh" : type.toLowerCase(),
      host: host.trim(),
      port: String(port).trim(),
      username: decodePart(username),
      password: decodePart(password),
    };
  }

  try {
    const url = new URL(raw);
    const type = url.protocol.replace(":", "").toLowerCase();
    if (!["http", "https", "socks5", "ssh"].includes(type)) return null;
    return {
      type: type === "ssh" ? "ssh" : type,
      host: url.hostname,
      port: String(url.port || defaultPortForType(type)).trim(),
      username: decodePart(url.username),
      password: decodePart(url.password),
    };
  } catch {
    return null;
  }
}

function defaultPortForType(type) {
  if (type === "https") return "443";
  if (type === "ssh") return "22";
  return "80";
}

export function parseProxyUrl(url) {
  const parsed = parseProxyQuickInput(url);
  if (!parsed) return null;
  if (parsed.type === "direct" || parsed.type === "global") return { ...DEFAULT_PROXY_CONFIG, type: parsed.type };
  return parsed;
}

export function normalizeProxyConfig(raw = {}, legacyUrl = "") {
  if (raw && typeof raw === "object" && raw.type) {
    const type = String(raw.type || "global").toLowerCase();
    return {
      type: PROXY_TYPES.some((item) => item.value === type) ? type : "global",
      host: String(raw.host || "").trim(),
      port: String(raw.port || "").trim(),
      username: String(raw.username || "").trim(),
      password: String(raw.password || "").trim(),
    };
  }

  const legacy = String(legacyUrl || "").trim();
  if (!legacy) return { ...DEFAULT_PROXY_CONFIG };
  if (legacy === "direct" || legacy === "__direct__") {
    return { type: "direct", host: "", port: "", username: "", password: "" };
  }

  const parsed = parseProxyUrl(legacy);
  if (parsed) return parsed;
  return { ...DEFAULT_PROXY_CONFIG };
}

export function isCustomProxyConfig(config = DEFAULT_PROXY_CONFIG) {
  return ["http", "https", "socks5", "ssh"].includes(config.type);
}

export function buildProxyUrl(config = DEFAULT_PROXY_CONFIG) {
  if (!isCustomProxyConfig(config)) return "";
  if (!config.host || !config.port) return "";

  const runtimeType = config.type === "ssh" ? "socks5" : config.type;
  const auth =
    config.username || config.password
      ? `${encodeURIComponent(config.username)}:${encodeURIComponent(config.password)}@`
      : "";
  return `${runtimeType}://${auth}${config.host}:${config.port}`;
}

export function getProxyDisplayLabel(config = DEFAULT_PROXY_CONFIG) {
  if (config.type === "direct") return "直连";
  if (config.type === "global") return "全局";
  if (!isCustomProxyConfig(config) || !config.host || !config.port) return "未配置";
  const typeLabel = config.type.toUpperCase();
  const auth = config.username ? ` (${config.username})` : "";
  return `${typeLabel} ${config.host}:${config.port}${auth}`;
}

export function parseProxyRuntime(proxyUrl) {
  const raw = String(proxyUrl || "").trim();
  if (!raw) return null;

  const parsed = parseProxyUrl(raw);
  if (parsed && isCustomProxyConfig(parsed)) {
    return {
      type: parsed.type === "ssh" ? "socks5" : parsed.type,
      host: parsed.host,
      port: parseInt(parsed.port, 10) || defaultPortForType(parsed.type),
      username: parsed.username,
      password: parsed.password,
    };
  }

  try {
    const url = new URL(raw);
    const type = url.protocol.replace(":", "").toLowerCase();
    return {
      type: type === "socks5" ? "socks5" : "http",
      host: url.hostname,
      port: parseInt(url.port, 10) || 80,
      username: decodePart(url.username),
      password: decodePart(url.password),
    };
  } catch {
    return null;
  }
}

export function toPlaywrightProxy(proxyUrl) {
  const runtime = parseProxyRuntime(proxyUrl);
  if (!runtime) {
    const raw = String(proxyUrl || "").trim();
    return raw ? { server: raw } : null;
  }

  const server = `${runtime.type}://${runtime.host}:${runtime.port}`;
  const proxy = { server };
  if (runtime.username) proxy.username = runtime.username;
  if (runtime.password) proxy.password = runtime.password;
  return proxy;
}

export function maskProxyPassword(config = DEFAULT_PROXY_CONFIG) {
  return {
    ...config,
    password: config.password ? "******" : "",
    hasPassword: Boolean(config.password),
  };
}
