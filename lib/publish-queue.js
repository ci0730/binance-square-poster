/**
 * 全局发帖队列：所有入口（批量 / 单发 / AI 托管）共用，
 * 避免多账号同时打满本地 Clash 端口；失败后指数退避。
 */
import { isTransientNetworkError } from "./http-transport.js";

let chain = Promise.resolve();
let consecutiveTransientFailures = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldBackoff(err) {
  if (!err) return false;
  if (err.code === "PROXY_CIRCUIT_OPEN" || err.code === "PROXY_NOT_READY") return true;
  const msg = String(err.message || err || "");
  return isTransientNetworkError(msg) || /超时|连接|代理|TLS|socket|重置|中断|熔断/i.test(msg);
}

/**
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function withGlobalPublishQueue(fn) {
  const run = chain.then(async () => {
    if (consecutiveTransientFailures > 0) {
      const backoffMs = Math.min(30_000, 1500 * 2 ** Math.min(consecutiveTransientFailures - 1, 4));
      await sleep(backoffMs + Math.floor(Math.random() * 400));
    }
    try {
      const result = await fn();
      consecutiveTransientFailures = 0;
      return result;
    } catch (err) {
      if (shouldBackoff(err)) consecutiveTransientFailures += 1;
      else consecutiveTransientFailures = 0;
      throw err;
    }
  });
  chain = run.then(
    () => {},
    () => {},
  );
  return run;
}

export function getPublishQueuePressure() {
  return { consecutiveTransientFailures };
}
