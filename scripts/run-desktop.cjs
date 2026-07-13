const { spawnSync } = require("child_process");
const path = require("path");
const { ensureElectron } = require("./ensure-electron.cjs");

const electronPkg = ensureElectron();
const cli = path.join(electronPkg, "cli.js");
const args = process.argv.slice(2);

const launch = spawnSync(process.execPath, [cli, ...args], {
  stdio: "inherit",
  env: process.env,
  cwd: path.join(__dirname, ".."),
});

process.exit(launch.status ?? 1);
