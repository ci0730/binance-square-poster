/** AI 托管单次运行进度（供前端轮询，避免长时间只显示「生成中」） */
let state = {
  stage: "idle",
  message: "",
  updatedAt: 0,
};
let clearToken = 0;

export function setAiRunProgress(stage, message = "") {
  // 新进度使待清理任务失效，避免上一轮的延时 clear 抹掉本轮状态
  clearToken += 1;
  state = {
    stage: String(stage || "idle"),
    message: String(message || ""),
    updatedAt: Date.now(),
  };
}

export function getAiRunProgress() {
  return { ...state };
}

export function clearAiRunProgress() {
  state = { stage: "idle", message: "", updatedAt: 0 };
}

export function scheduleClearAiRunProgress(delayMs = 8000) {
  const token = ++clearToken;
  setTimeout(() => {
    if (token !== clearToken) return;
    clearAiRunProgress();
  }, delayMs);
}
