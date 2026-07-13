const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

function ensureElectron() {
  process.env.ELECTRON_MIRROR =
    process.env.ELECTRON_MIRROR || "https://npmmirror.com/mirrors/electron/";

  const vendorRoot = path.join(__dirname, "..", ".electron-vendor");
  const electronPkg = path.join(vendorRoot, "node_modules", "electron");

  if (!fs.existsSync(path.join(electronPkg, "package.json"))) {
    console.log("正在安装 Electron...");
    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
    const install = spawnSync(
      npmCmd,
      ["install", "electron@33.2.1", "--prefix", vendorRoot, "--no-save"],
      { stdio: "inherit", env: process.env, shell: process.platform === "win32" }
    );
    if (install.status !== 0) process.exit(install.status ?? 1);
  }

  if (!fs.existsSync(path.join(electronPkg, "path.txt"))) {
    console.log("正在下载 Electron 运行包（国内镜像）...");
    const download = spawnSync(process.execPath, [path.join(electronPkg, "install.js")], {
      stdio: "inherit",
      env: process.env,
    });
    if (download.status !== 0) process.exit(download.status ?? 1);
  }

  return electronPkg;
}

module.exports = { ensureElectron };
