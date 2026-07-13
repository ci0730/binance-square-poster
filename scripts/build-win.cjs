const { spawnSync, spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");
const { ensureElectron } = require("./ensure-electron.cjs");

const root = path.join(__dirname, "..");
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

process.env.ELECTRON_MIRROR =
  process.env.ELECTRON_MIRROR || "https://npmmirror.com/mirrors/electron/";
process.env.npm_config_electron_mirror = process.env.ELECTRON_MIRROR;
process.env.ELECTRON_BUILDER_BINARIES_MIRROR =
  process.env.ELECTRON_BUILDER_BINARIES_MIRROR ||
  "https://npmmirror.com/mirrors/electron-builder-binaries/";
process.env.npm_config_electron_builder_binaries_mirror = process.env.ELECTRON_BUILDER_BINARIES_MIRROR;
process.env.CSC_IDENTITY_AUTO_DISCOVERY = "false";

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    stdio: "inherit",
    cwd: root,
    env: { ...process.env, ...opts.env },
    shell: process.platform === "win32",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function sleep(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {}
}

function probeServer(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/api/config`, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(1500, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function verifyWindowsBuild(outDir) {
  if (process.platform !== "win32") return;

  const winUnpacked = path.join(root, outDir, "win-unpacked");
  const appRoot = path.join(winUnpacked, "resources", "app.asar.unpacked");
  const exeName = fs
    .readdirSync(winUnpacked)
    .find((f) => f.endsWith(".exe") && !f.toLowerCase().includes("uninstall"));
  if (!exeName) {
    console.error("构建校验失败: 找不到应用 exe");
    process.exit(1);
  }

  const required = [
    path.join(winUnpacked, "ffmpeg.dll"),
    path.join(appRoot, "package.json"),
    path.join(appRoot, "server.js"),
  ];
  for (const file of required) {
    if (!fs.existsSync(file)) {
      console.error(`构建校验失败: 缺少 ${file}`);
      process.exit(1);
    }
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(appRoot, "package.json"), "utf8"));
  if (pkg.type !== "module") {
    console.error('构建校验失败: app.asar.unpacked/package.json 需要 "type": "module"');
    process.exit(1);
  }

  const testRoot = path.join(os.tmpdir(), `bsp-pack-test-${Date.now()}`);
  const testData = path.join(testRoot, "data");
  const port = 35678;
  console.log("正在校验打包产物（模拟他人电脑上的独立安装目录）...");

  try {
    fs.cpSync(winUnpacked, testRoot, { recursive: true });
    fs.mkdirSync(testData, { recursive: true });

    const testExe = path.join(testRoot, exeName);
    const testAppRoot = path.join(testRoot, "resources", "app.asar.unpacked");
    let stderr = "";

    const child = spawn(testExe, ["server.js"], {
      cwd: testAppRoot,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        BINANCE_SQUARE_DATA_DIR: testData,
        PORT: String(port),
      },
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    const deadline = Date.now() + 20000;
    let ok = false;
    while (Date.now() < deadline) {
      if (child.exitCode != null) break;
      if (await probeServer(port)) {
        ok = true;
        break;
      }
      sleep(400);
    }

    if (!child.killed) child.kill();

    if (!ok) {
      console.error("构建校验失败: 后台服务未能在独立目录中启动");
      if (stderr.trim()) console.error(stderr.trim());
      process.exit(1);
    }
    console.log("打包产物校验通过。");
  } finally {
    try {
      fs.rmSync(testRoot, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

ensureElectron();

const electronInRoot = path.join(root, "node_modules", "electron", "package.json");
if (!fs.existsSync(electronInRoot)) {
  console.log("正在安装打包依赖（electron / electron-builder）...");
  run(npmCmd, ["install", "electron@33.2.1", "electron-builder@25.1.8", "--save-dev"]);
}

const builderBin = path.join(root, "node_modules", "electron-builder", "cli.js");
const outDir = process.env.BUILD_OUTPUT_DIR || `release-${Date.now()}`;
const prepackaged = process.env.BUILD_PREPACKAGED;
const args = ["--win", `--config.directories.output=${outDir}`];
if (prepackaged) args.push(`--prepackaged=${prepackaged}`);
console.log(`输出目录: ${outDir}`);
run(process.execPath, [builderBin, ...args]);
(async () => {
  await verifyWindowsBuild(outDir);
  console.log(`\n构建完成。安装包位于: ${path.join(root, outDir)}`);
})().catch((err) => {
  console.error("构建校验失败:", err.message);
  process.exit(1);
});
