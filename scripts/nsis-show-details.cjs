/**
 * electron-builder 默认 SetDetailsPrint none，安装页不滚动文件列表。
 * 打包前改成 both，配合 installer.nsh 的 ShowInstDetails show。
 */
const fs = require("fs");
const path = require("path");

function patchFile(relPath, from, to, label) {
  const file = path.join(__dirname, "..", "node_modules", "app-builder-lib", "templates", "nsis", relPath);
  if (!fs.existsSync(file)) {
    console.warn(`[nsis] skip missing ${relPath}`);
    return;
  }
  const text = fs.readFileSync(file, "utf8");
  if (!text.includes(from)) {
    if (text.includes(to)) {
      console.log(`[nsis] ${label}: already patched`);
      return;
    }
    console.warn(`[nsis] ${label}: pattern not found in ${relPath}`);
    return;
  }
  fs.writeFileSync(file, text.split(from).join(to));
  console.log(`[nsis] ${label}: patched ${relPath}`);
}

exports.default = async function enableNsisInstallDetails() {
  patchFile("installSection.nsh", "SetDetailsPrint none", "SetDetailsPrint both", "install details");
};
