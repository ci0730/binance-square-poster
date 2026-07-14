import fs from "fs";
import os from "os";
import path from "path";
import {
  LEGACY_CONFIG_DIR,
  readDataDirPointer,
  writeDataDirPointer,
  clearDataDirPointer,
  getBootstrapDir,
  getDefaultDataDir,
  resolveConfiguredDataDir,
  migrateDataDirectory,
  assertWritableDataDir,
} from "./data-dir-bootstrap.js";

let cachedConfigDir = null;

const CACHE_FILE_NAMES = [
  "accounts.json",
  "settings.json",
  "ai-settings.json",
  "published-posts-cache.json",
  "token-registry.json",
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

export function invalidateConfigDirCache() {
  cachedConfigDir = null;
}

export function getConfigDir() {
  if (cachedConfigDir) return cachedConfigDir;

  cachedConfigDir = resolveConfiguredDataDir();
  ensureDir(cachedConfigDir);
  if (cachedConfigDir !== LEGACY_CONFIG_DIR) tryMigrateFromLegacyDir(cachedConfigDir);
  return cachedConfigDir;
}

export function getDataDirInfo() {
  const currentDir = getConfigDir();
  const defaultDir = getDefaultDataDir();
  const customDir = readDataDirPointer();
  return {
    currentDir,
    defaultDir,
    customDir,
    bootstrapDir: getBootstrapDir(),
    isCustom: Boolean(customDir),
    canPickFolder: process.env.BINANCE_SQUARE_DESKTOP === "1",
  };
}

export function setCustomDataDir(targetDir, { migrate = true } = {}) {
  const nextDir = assertWritableDataDir(targetDir);
  const currentDir = getConfigDir();
  let migration = { migrated: false, files: 0 };
  if (migrate && currentDir !== nextDir) {
    migration = migrateDataDirectory(currentDir, nextDir);
  }
  writeDataDirPointer(nextDir);
  invalidateConfigDirCache();
  return {
    ok: true,
    requiresRestart: true,
    fromDir: currentDir,
    toDir: nextDir,
    migration,
  };
}

export function resetCustomDataDir({ migrate = true } = {}) {
  const currentDir = getConfigDir();
  const defaultDir = getDefaultDataDir();
  let migration = { migrated: false, files: 0 };
  if (migrate && currentDir !== defaultDir) {
    migration = migrateDataDirectory(currentDir, defaultDir);
  }
  clearDataDirPointer();
  invalidateConfigDirCache();
  return {
    ok: true,
    requiresRestart: true,
    fromDir: currentDir,
    toDir: defaultDir,
    migration,
  };
}

export function getUploadsDir(appRoot = "") {
  const configDir = getConfigDir();
  const configUploads = path.join(configDir, "uploads");
  if (readDataDirPointer() || resolveDataDirFromEnv()) {
    ensureDir(configUploads);
    return configUploads;
  }
  const localUploads = path.join(appRoot, "uploads");
  ensureDir(localUploads);
  return localUploads;
}

export function getLegacyConfigDir() {
  return LEGACY_CONFIG_DIR;
}

export { getBootstrapDir, getDefaultDataDir, readDataDirPointer } from "./data-dir-bootstrap.js";
