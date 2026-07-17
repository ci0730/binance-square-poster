const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopApi", {
  isDesktop: true,
  pickDirectory: () => ipcRenderer.invoke("pick-directory"),
  restartApp: () => ipcRenderer.invoke("restart-app"),
  setNativeTheme: (theme) => ipcRenderer.invoke("set-native-theme", theme),
  getAppVersion: () => ipcRenderer.invoke("update-get-version"),
  checkForUpdates: () => ipcRenderer.invoke("update-check"),
  downloadUpdate: () => ipcRenderer.invoke("update-download"),
  installUpdate: () => ipcRenderer.invoke("update-install"),
  onUpdateStatus: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("app-update-status", listener);
    return () => ipcRenderer.removeListener("app-update-status", listener);
  },
});
