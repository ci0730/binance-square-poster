import fs from "fs";
import os from "os";
import path from "path";

const POINTER_NAME = "data-dir.json";

export const LEGACY_CONFIG_DIR = path.join(os.homedir(), ".config", "binance-square");

const DEV_BOOTSTRAP_DIR = path.join(os.homedir(), ".config", "binance-square-app");

export function getBootstrapDir() {
  const envDir = String(process.env.BINANCE_SQUARE_BOOTSTRAP_DIR || "").trim();
  return envDir ? path.resolve(envDir) : DEV_BOOTSTRAP_DIR;
}

export function getDefaultDataDir() {
  const envDefault = String(process.env.BINANCE_SQUARE_DEFAULT_DATA_DIR || "").trim();
  if (envDefault) return path.resolve(envDefault);
  return LEGACY_CONFIG_DIR;
}

function pointerFile() {
  return path.join(getBootstrapDir(), POINTER_NAME);
}

function ensureBootstrapDir() {
  const dir = getBootstrapDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function readDataDirPointer() {
  try {
    const raw = JSON.parse(fs.readFileSync(pointerFile(), "utf8"));
    const customDir = String(raw?.customDir || "").trim();
    return customDir ? path.resolve(customDir) : null;
  } catch {
    return null;
  }
}

export function writeDataDirPointer(customDir) {
  ensureBootstrapDir();
  const resolved = path.resolve(String(customDir || "").trim());
  if (!resolved) throw new Error("数据目录路径无效");
  fs.writeFileSync(
    pointerFile(),
    JSON.stringify({ customDir: resolved, updatedAt: Date.now() }, null, 2),
    { mode: 0o600 },
  );
  return resolved;
}

export function clearDataDirPointer() {
  try {
    fs.unlinkSync(pointerFile());
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }
}

export function resolveConfiguredDataDir() {
  const pointerDir = readDataDirPointer();
  if (pointerDir) return pointerDir;
  const envDir = String(process.env.BINANCE_SQUARE_DATA_DIR || "").trim();
  if (envDir) return path.resolve(envDir);
  return getDefaultDataDir();
}

export function migrateDataDirectory(fromDir, toDir) {
  const from = path.resolve(fromDir);
  const to = path.resolve(toDir);
  if (from === to) return { migrated: false, files: 0 };
  if (!fs.existsSync(from)) return { migrated: false, files: 0 };

  fs.mkdirSync(to, { recursive: true, mode: 0o700 });
  let files = 0;
  for (const name of fs.readdirSync(from)) {
    const src = path.join(from, name);
    const dest = path.join(to, name);
    if (fs.existsSync(dest)) continue;
    fs.cpSync(src, dest, { recursive: true });
    files += 1;
  }
  return { migrated: files > 0, files };
}

export function assertWritableDataDir(dir) {
  const resolved = path.resolve(String(dir || "").trim());
  if (!resolved) throw new Error("请填写数据保存目录");
  if (!path.isAbsolute(resolved)) throw new Error("请使用绝对路径（例如 D:\\数据\\binance-square）");
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const probe = path.join(resolved, `.write-test-${Date.now()}`);
  fs.writeFileSync(probe, "ok", { mode: 0o600 });
  fs.unlinkSync(probe);
  return resolved;
}
