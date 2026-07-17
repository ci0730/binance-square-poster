import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { importUserConfigFromDir, migrateUserConfigIntoDataDir } from "../lib/config-migrate.js";

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJson(dir, name, data) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), JSON.stringify(data, null, 2));
}

function readJson(dir, name) {
  return JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
}

test("importUserConfigFromDir merges richer accounts over empty shell", () => {
  const from = makeTempDir("bsp-from-");
  const to = makeTempDir("bsp-to-");
  try {
    writeJson(from, "accounts.json", {
      defaultAccountId: "acc_1",
      accounts: [{ id: "acc_1", name: "主号", apiKey: "key-aaa", cookie: "", createdAt: 1 }],
    });
    writeJson(to, "accounts.json", { defaultAccountId: null, accounts: [] });

    const result = importUserConfigFromDir(from, to);
    assert.equal(result.migrated, true);
    assert.ok(result.details.includes("accounts.json"));

    const accounts = readJson(to, "accounts.json");
    assert.equal(accounts.accounts.length, 1);
    assert.equal(accounts.accounts[0].apiKey, "key-aaa");
  } finally {
    fs.rmSync(from, { recursive: true, force: true });
    fs.rmSync(to, { recursive: true, force: true });
  }
});

test("importUserConfigFromDir merges missing account ids without dropping existing", () => {
  const from = makeTempDir("bsp-from-");
  const to = makeTempDir("bsp-to-");
  try {
    writeJson(from, "accounts.json", {
      defaultAccountId: "acc_2",
      accounts: [{ id: "acc_2", name: "新号", apiKey: "key-bbb", createdAt: 2 }],
    });
    writeJson(to, "accounts.json", {
      defaultAccountId: "acc_1",
      accounts: [{ id: "acc_1", name: "旧号", apiKey: "key-aaa", createdAt: 1 }],
    });

    const result = importUserConfigFromDir(from, to);
    assert.equal(result.migrated, true);
    const accounts = readJson(to, "accounts.json");
    assert.equal(accounts.accounts.length, 2);
    assert.ok(accounts.accounts.some((a) => a.id === "acc_1"));
    assert.ok(accounts.accounts.some((a) => a.id === "acc_2"));
  } finally {
    fs.rmSync(from, { recursive: true, force: true });
    fs.rmSync(to, { recursive: true, force: true });
  }
});

test("migrateUserConfigIntoDataDir rescues empty accounts even after marker", () => {
  const from = makeTempDir("bsp-legacy-");
  const to = makeTempDir("bsp-appdata-");
  try {
    writeJson(from, "accounts.json", {
      defaultAccountId: "acc_9",
      accounts: [{ id: "acc_9", name: "救援", apiKey: "key-rescue", createdAt: 9 }],
    });
    writeJson(to, "accounts.json", { defaultAccountId: null, accounts: [] });
    fs.writeFileSync(path.join(to, ".migrated-config-import-v2"), "already\n");

    const result = migrateUserConfigIntoDataDir(to, { sourceDirs: [from] });
    assert.equal(result.migrated, true);
    const accounts = readJson(to, "accounts.json");
    assert.equal(accounts.accounts.length, 1);
    assert.equal(accounts.accounts[0].apiKey, "key-rescue");
  } finally {
    fs.rmSync(from, { recursive: true, force: true });
    fs.rmSync(to, { recursive: true, force: true });
  }
});
