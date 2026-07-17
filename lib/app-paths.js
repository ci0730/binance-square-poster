import fs from "fs";
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
import { migrateUserConfigIntoDataDir, importUserConfigFromDir } from "./config-migrate.js";

let cachedConfigDir = null;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Windows may not support chmod
  }
}

function tryMigrateFromLegacyDir(targetDir) {
  const installDataDir = String(process.env.BINANCE_SQUARE_INSTALL_DATA_DIR || "").trim() || null;
  migrateUserConfigIntoDataDir(targetDir, { installDataDir });
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
    // 先按缺失拷贝整目录，再智能合并账号 / AI 等配置，避免空壳挡住旧数据
    const copied = migrateDataDirectory(currentDir, nextDir);
    const merged = importUserConfigFromDir(currentDir, nextDir);
    migration = {
      migrated: copied.migrated || merged.migrated,
      files: (copied.files || 0) + (merged.files || 0),
    };
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
    const copied = migrateDataDirectory(currentDir, defaultDir);
    const merged = importUserConfigFromDir(currentDir, defaultDir);
    migration = {
      migrated: copied.migrated || merged.migrated,
      files: (copied.files || 0) + (merged.files || 0),
    };
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
