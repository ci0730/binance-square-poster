import { execSync } from "child_process";
import { buildProxyUrl } from "./proxy-config.js";

let cached = { at: 0, value: null };
const CACHE_MS = 30000;

function readRegValue(name) {
  try {
    const output = execSync(
      `reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ${name}`,
      { encoding: "utf8", windowsHide: true, timeout: 5000 },
    );
    const match = output.match(new RegExp(`${name}\\s+REG_\\w+\\s+(.+)`, "i"));
    return match ? match[1].trim() : "";
  } catch {
    return "";
  }
}

export function parseProxyServer(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;

  const parts = text.split(";").map((s) => s.trim()).filter(Boolean);
  const prefer = ["https", "http", "socks"];
  for (const key of prefer) {
    const part = parts.find((p) => p.toLowerCase().startsWith(`${key}=`));
    if (!part) continue;
    const value = part.slice(part.indexOf("=") + 1);
    const matched = value.match(/^([^:]+):(\d+)$/);
    if (!matched) continue;
    return {
      type: key === "socks" ? "socks5" : "http",
      host: matched[1],
      port: matched[2],
      username: "",
      password: "",
    };
  }

  const simple = text.match(/^([^:]+):(\d+)$/);
  if (simple) {
    return { type: "http", host: simple[1], port: simple[2], username: "", password: "" };
  }
  return null;
}

export function getWindowsSystemProxyConfig() {
  if (process.platform !== "win32") return null;
  if (Date.now() - cached.at < CACHE_MS) return cached.value;

  const enabled = readRegValue("ProxyEnable");
  const isEnabled = enabled === "0x1" || enabled === "1";
  if (!isEnabled) {
    cached = { at: Date.now(), value: null };
    return null;
  }

  const parsed = parseProxyServer(readRegValue("ProxyServer"));
  cached = { at: Date.now(), value: parsed };
  return parsed;
}

export function getWindowsSystemProxyUrl() {
  const config = getWindowsSystemProxyConfig();
  if (!config) return "";
  return buildProxyUrl(config);
}

export function getWindowsSystemProxyPublic() {
  const config = getWindowsSystemProxyConfig();
  if (!config) return null;
  return {
    type: config.type,
    host: config.host,
    port: config.port,
    proxyLabel: `系统代理 ${config.host}:${config.port}`,
    proxyUrl: buildProxyUrl(config),
  };
}

export function clearWindowsSystemProxyCache() {
  cached = { at: 0, value: null };
}
