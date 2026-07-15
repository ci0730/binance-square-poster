import fs from "fs";
import path from "path";
import { getConfigDir } from "./app-paths.js";

const registryFile = () => path.join(getConfigDir(), "token-registry.json");

const DEFAULT_SYMBOLS = [
  "BTC", "ETH", "BNB", "SOL", "XRP", "DOGE", "ADA", "AVAX", "LINK",
  "DOT", "NEAR", "APT", "TON", "TRX", "SHIB", "MATIC", "LTC", "UNI", "FIL", "BCH",
];

const DEFAULT_CHAINS = [
  { id: "", label: "未指定" },
  { id: "binance-spot", label: "币安现货" },
  { id: "binance-alpha", label: "币安 Alpha" },
  { id: "binance-futures", label: "币安 U 本位合约" },
  { id: "bsc", label: "BSC" },
  { id: "eth", label: "Ethereum" },
  { id: "sol", label: "Solana" },
  { id: "base", label: "Base" },
  { id: "arb", label: "Arbitrum" },
];

const DEFAULT_REFRESH_INTERVAL_SEC = 60;
const MIN_REFRESH_INTERVAL_SEC = 15;
const MAX_REFRESH_INTERVAL_SEC = 3600;

function generateId() {
  return `tok_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeSymbol(symbol) {
  return String(symbol || "")
    .trim()
    .replace(/^\$/, "")
    .toUpperCase();
}

function normalizeAddress(address) {
  return String(address || "").trim();
}

export function normalizeRefreshIntervalSec(value) {
  let sec = Number(value);
  if (!Number.isFinite(sec)) sec = DEFAULT_REFRESH_INTERVAL_SEC;
  sec = Math.floor(sec);
  if (sec <= 0) return 0;
  if (sec < MIN_REFRESH_INTERVAL_SEC) return MIN_REFRESH_INTERVAL_SEC;
  if (sec > MAX_REFRESH_INTERVAL_SEC) return MAX_REFRESH_INTERVAL_SEC;
  return sec;
}

function normalizeSettings(raw = {}) {
  return {
    refreshIntervalSec: normalizeRefreshIntervalSec(
      raw.refreshIntervalSec ?? DEFAULT_REFRESH_INTERVAL_SEC,
    ),
  };
}

function normalizeListingType(value, chain = "") {
  if (value === "alpha" || value === "spot" || value === "futures") return value;
  if (chain === "binance-alpha") return "alpha";
  if (chain === "binance-futures") return "futures";
  return "spot";
}

function normalizeEntry(raw = {}) {
  const symbol = normalizeSymbol(raw.symbol);
  if (!symbol) return null;
  const source = ["auto", "spot", "alpha", "futures"].includes(raw.source) ? raw.source : "auto";
  const pair = String(raw.binanceSymbol || `${symbol}USDT`)
    .trim()
    .replace(/^\$/, "")
    .toUpperCase()
    .replace(/\s+/g, "");
  const chain = String(raw.chain || "").trim();
  return {
    id: String(raw.id || generateId()),
    symbol,
    name: String(raw.name || symbol).trim() || symbol,
    binanceSymbol: pair || `${symbol}USDT`,
    contractAddress: normalizeAddress(raw.contractAddress),
    contractNetwork: String(raw.contractNetwork || "").trim(),
    contractUserEdited: Boolean(raw.contractUserEdited),
    listingType: normalizeListingType(raw.listingType, chain),
    chain,
    source,
    enabled: raw.enabled !== false,
    notes: String(raw.notes || "").trim(),
    updatedAt: Number(raw.updatedAt) || Date.now(),
  };
}

function defaultEntry(symbol, extra = {}) {
  return normalizeEntry({
    id: generateId(),
    symbol,
    name: extra.name || symbol,
    binanceSymbol: extra.binanceSymbol || `${normalizeSymbol(symbol)}USDT`,
    contractAddress: extra.contractAddress || "",
    contractNetwork: extra.contractNetwork || "",
    contractUserEdited: Boolean(extra.contractUserEdited),
    listingType: extra.listingType || "spot",
    chain: extra.chain || "binance-spot",
    source: extra.source || "auto",
    enabled: extra.enabled !== false,
    notes: extra.notes || "",
    updatedAt: Date.now(),
  });
}

function emptyStore() {
  return {
    tokens: DEFAULT_SYMBOLS.map((symbol) => defaultEntry(symbol)),
    settings: normalizeSettings({}),
  };
}

function readStore() {
  if (!fs.existsSync(registryFile())) {
    const store = emptyStore();
    writeStore(store);
    return store;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(registryFile(), "utf8"));
    const tokens = Array.isArray(raw.tokens)
      ? raw.tokens.map(normalizeEntry).filter(Boolean)
      : [];
    if (!tokens.length) {
      const store = emptyStore();
      writeStore(store);
      return store;
    }
    return {
      tokens,
      settings: normalizeSettings(raw.settings || {}),
    };
  } catch {
    return emptyStore();
  }
}

function writeStore(store) {
  fs.mkdirSync(getConfigDir(), { recursive: true, mode: 0o700 });
  const payload = {
    tokens: store.tokens || [],
    settings: normalizeSettings(store.settings || {}),
  };
  fs.writeFileSync(registryFile(), JSON.stringify(payload), { mode: 0o600 });
}

export function listTokenRegistryPublic() {
  const store = readStore();
  return {
    tokens: store.tokens,
    settings: store.settings,
    chainOptions: DEFAULT_CHAINS,
    sourceOptions: [
      { id: "auto", label: "自动（现货 → Alpha → U本位合约）" },
      { id: "spot", label: "仅币安现货" },
      { id: "alpha", label: "仅币安 Alpha" },
      { id: "futures", label: "仅币安 U 本位合约" },
    ],
    refreshLimits: {
      min: MIN_REFRESH_INTERVAL_SEC,
      max: MAX_REFRESH_INTERVAL_SEC,
      default: DEFAULT_REFRESH_INTERVAL_SEC,
    },
    seedCount: DEFAULT_SYMBOLS.length,
  };
}

export function getTokenRegistrySettings() {
  return readStore().settings;
}

export function saveTokenRegistrySettings(patch = {}) {
  const store = readStore();
  store.settings = normalizeSettings({ ...store.settings, ...patch });
  writeStore(store);
  return store.settings;
}

export function getTokenRegistryMap() {
  const map = new Map();
  for (const item of readStore().tokens) {
    if (!item.enabled) continue;
    map.set(item.symbol, item);
  }
  return map;
}

export function listAllTokenRegistryEntries() {
  return readStore().tokens;
}

export function getTokenRegistryEntry(symbol) {
  const sym = normalizeSymbol(symbol);
  if (!sym) return null;
  return getTokenRegistryMap().get(sym) || null;
}

export function upsertTokenRegistryEntry(payload = {}) {
  const store = readStore();
  const next = normalizeEntry(payload);
  if (!next) throw new Error("请填写代币符号");

  const index = store.tokens.findIndex(
    (item) => item.id === next.id || item.symbol === next.symbol,
  );
  if (index >= 0) {
    const prev = store.tokens[index];
    next.id = prev.id;
    // 用户改过合约：一旦标记就必须保留；本次若改了地址则标记
    if (prev.contractUserEdited) next.contractUserEdited = true;
    if (
      payload.contractUserEdited === true ||
      (Object.prototype.hasOwnProperty.call(payload, "contractAddress") &&
        normalizeAddress(payload.contractAddress) !== prev.contractAddress)
    ) {
      next.contractUserEdited = true;
    }
    next.updatedAt = Date.now();
    store.tokens[index] = next;
  } else {
    if (payload.contractUserEdited) next.contractUserEdited = true;
    store.tokens.push(next);
  }
  writeStore(store);
  return next;
}

export function updateTokenRegistryEntry(id, patch = {}) {
  const store = readStore();
  const index = store.tokens.findIndex((item) => item.id === id);
  if (index < 0) throw new Error("代币不存在");
  const prev = store.tokens[index];
  const merged = normalizeEntry({ ...prev, ...patch, id: prev.id });
  if (!merged) throw new Error("请填写代币符号");
  const conflict = store.tokens.find((item, i) => i !== index && item.symbol === merged.symbol);
  if (conflict) throw new Error(`代币 ${merged.symbol} 已存在`);

  if (prev.contractUserEdited) merged.contractUserEdited = true;
  if (
    patch.contractUserEdited === true ||
    (Object.prototype.hasOwnProperty.call(patch, "contractAddress") &&
      normalizeAddress(patch.contractAddress) !== prev.contractAddress)
  ) {
    merged.contractUserEdited = true;
  }

  merged.updatedAt = Date.now();
  store.tokens[index] = merged;
  writeStore(store);
  return merged;
}

export function deleteTokenRegistryEntry(id) {
  const store = readStore();
  const index = store.tokens.findIndex((item) => item.id === id);
  if (index < 0) throw new Error("代币不存在");
  const [removed] = store.tokens.splice(index, 1);
  writeStore(store);
  return removed;
}

/**
 * 合并币安同步：新增缺失项。
 * 合约地址：未标记「用户修改」的可写；用户改过的永不覆盖。
 */
export function applySyncedTokenBatch(syncedItems = []) {
  const store = readStore();
  const bySymbol = new Map(store.tokens.map((item) => [item.symbol, item]));
  let added = 0;
  let contractFilled = 0;
  let contractUpdated = 0;
  let updatedMeta = 0;

  for (const raw of syncedItems) {
    const symbol = normalizeSymbol(raw?.symbol);
    if (!symbol) continue;
    const incomingContract = normalizeAddress(raw.contractAddress);
    const existing = bySymbol.get(symbol);

    if (!existing) {
      const created = defaultEntry(symbol, {
        name: raw.name || symbol,
        binanceSymbol: raw.binanceSymbol || `${symbol}USDT`,
        contractAddress: incomingContract,
        contractNetwork: raw.contractNetwork || "",
        contractUserEdited: false,
        listingType:
          raw.listingType ||
          (raw.chain === "binance-alpha" ? "alpha" : raw.chain === "binance-futures" ? "futures" : "spot"),
        chain:
          raw.chain ||
          (raw.listingType === "alpha"
            ? "binance-alpha"
            : raw.listingType === "futures"
              ? "binance-futures"
              : "binance-spot"),
        source: raw.source || "auto",
        enabled: raw.enabled !== false,
        notes: raw.notes || "",
      });
      store.tokens.push(created);
      bySymbol.set(symbol, created);
      added += 1;
      if (incomingContract) contractFilled += 1;
      continue;
    }

    let changed = false;

    if (!existing.contractUserEdited && incomingContract) {
      if (!existing.contractAddress) {
        existing.contractAddress = incomingContract;
        if (raw.contractNetwork) existing.contractNetwork = String(raw.contractNetwork).trim();
        contractFilled += 1;
        changed = true;
      } else if (existing.contractAddress !== incomingContract) {
        existing.contractAddress = incomingContract;
        if (raw.contractNetwork) existing.contractNetwork = String(raw.contractNetwork).trim();
        contractUpdated += 1;
        changed = true;
      }
    }

    if (raw.listingType && existing.listingType !== raw.listingType && raw.listingType === "spot") {
      // 现货上市优先标记为现货
      existing.listingType = "spot";
      if (!existing.chain || existing.chain === "binance-alpha") existing.chain = "binance-spot";
      changed = true;
    } else if (!existing.listingType && raw.listingType) {
      existing.listingType = raw.listingType;
      changed = true;
    }

    if ((!existing.name || existing.name === existing.symbol) && raw.name && raw.name !== existing.symbol) {
      existing.name = String(raw.name).trim();
      changed = true;
    }
    if (raw.binanceSymbol && !existing.binanceSymbol) {
      existing.binanceSymbol = String(raw.binanceSymbol).trim().toUpperCase();
      changed = true;
    }
    if (changed) {
      existing.updatedAt = Date.now();
      updatedMeta += 1;
    }
  }

  writeStore(store);
  return {
    added,
    contractFilled,
    contractUpdated,
    updatedMeta,
    total: store.tokens.length,
  };
}

export function ensureTokenRegistrySeed() {
  return listTokenRegistryPublic();
}

export function isDefaultSeedOnly() {
  const tokens = readStore().tokens;
  if (tokens.length > DEFAULT_SYMBOLS.length) return false;
  const set = new Set(DEFAULT_SYMBOLS);
  return tokens.every((t) => set.has(t.symbol));
}
