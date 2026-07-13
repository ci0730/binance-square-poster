import fs from "fs";
import os from "os";
import path from "path";

let cachedConfigDir = null;

const LEGACY_CONFIG_DIR = path.join(os.homedir(), ".config", "binance-square");

const CACHE_FILE_NAMES = [
  "accounts.json",
  "settings.json",
  "ai-settings.json",
  "published-posts-cache.json",
  "openapi-key",
];

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Windows may not support chmod
  }
}

function copyIfMissing(src, dest) {
  if (!fs.existsSync(src) || fs.existsSync(dest)) return;
  fs.copyFileSync(src, dest);
}

function tryMigrateFromLegacyDir(targetDir) {
  if (targetDir === LEGACY_CONFIG_DIR || !fs.existsSync(LEGACY_CONFIG_DIR)) return;
  const marker = path.join(targetDir, ".migrated-from-legacy");
  if (fs.existsSync(marker)) return;

  let migrated = false;
  for (const name of CACHE_FILE_NAMES) {
    const src = path.join(LEGACY_CONFIG_DIR, name);
    const dest = path.join(targetDir, name);
    if (fs.existsSync(src) && !fs.existsSync(dest)) {
      copyIfMissing(src, dest);
      migrated = true;
    }
  }

  const legacyUploads = path.join(LEGACY_CONFIG_DIR, "uploads");
  const targetUploads = path.join(targetDir, "uploads");
  if (fs.existsSync(legacyUploads) && !fs.existsSync(targetUploads)) {
    fs.cpSync(legacyUploads, targetUploads, { recursive: true });
    migrated = true;
  }

  if (migrated) {
    fs.writeFileSync(marker, `migratedAt=${new Date().toISOString()}\n`, "utf8");
  }
}

export function resolveDataDirFromEnv() {
  const envDir = String(process.env.BINANCE_SQUARE_DATA_DIR || "").trim();
  return envDir ? path.resolve(envDir) : null;
}

export function getConfigDir() {
  if (cachedConfigDir) return cachedConfigDir;

  const envDir = resolveDataDirFromEnv();
  cachedConfigDir = envDir || LEGACY_CONFIG_DIR;
  ensureDir(cachedConfigDir);
  if (envDir) tryMigrateFromLegacyDir(cachedConfigDir);
  return cachedConfigDir;
}

export function getUploadsDir(appRoot = "") {
  const configDir = getConfigDir();
  const portableUploads = path.join(configDir, "uploads");
  if (resolveDataDirFromEnv()) {
    ensureDir(portableUploads);
    return portableUploads;
  }
  const localUploads = path.join(appRoot, "uploads");
  ensureDir(localUploads);
  return localUploads;
}

export function getLegacyConfigDir() {
  return LEGACY_CONFIG_DIR;
}
