import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { getConfigDir } from "./app-paths.js";

const bindingFile = () => path.join(getConfigDir(), "device-binding.json");

function cryptoUuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return crypto.randomUUID();
}

function getMachineFingerprint() {
  const parts = [os.hostname(), os.platform(), os.arch(), os.userInfo().username || ""].join("|");
  return crypto.createHash("sha256").update(parts).digest("hex").slice(0, 16);
}

function maskId(id = "") {
  const text = String(id);
  if (text.length <= 8) return text;
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

function readBindingRaw() {
  if (!fs.existsSync(bindingFile())) return null;
  try {
    return JSON.parse(fs.readFileSync(bindingFile(), "utf8"));
  } catch {
    return null;
  }
}

function writeBinding(data) {
  fs.mkdirSync(getConfigDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(bindingFile(), JSON.stringify(data, null, 2), { mode: 0o600 });
}

export function getDeviceBinding() {
  const existing = readBindingRaw();
  if (existing?.status === "bound" && existing.deviceId) {
    return existing;
  }

  const next = {
    deviceId: cryptoUuid(),
    machineId: getMachineFingerprint(),
    status: "bound",
    boundAt: Date.now(),
    unboundAt: null,
  };
  writeBinding(next);
  return next;
}

export function getDeviceBindingPublic() {
  const binding = getDeviceBinding();
  return {
    deviceId: binding.deviceId,
    maskedDeviceId: maskId(binding.deviceId),
    machineId: binding.machineId,
    maskedMachineId: maskId(binding.machineId),
    status: binding.status || "bound",
    boundAt: binding.boundAt || null,
    unboundAt: binding.unboundAt || null,
  };
}

export function unbindDevice() {
  const current = readBindingRaw() || getDeviceBinding();
  const record = {
    status: "unbound",
    previousDeviceId: current.deviceId || null,
    machineId: current.machineId || getMachineFingerprint(),
    boundAt: current.boundAt || null,
    unboundAt: Date.now(),
  };
  writeBinding(record);
  try {
    fs.unlinkSync(bindingFile());
  } catch {
    // ignore
  }
  return {
    ok: true,
    message: "设备已解绑。下次启动将重新绑定本机，可在其他电脑安装使用。",
    unboundAt: record.unboundAt,
  };
}
