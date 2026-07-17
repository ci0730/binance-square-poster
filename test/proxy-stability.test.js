import test from "node:test";
import assert from "node:assert/strict";
import {
  assertProxyCircuitClosed,
  recordProxyFailure,
  recordProxySuccess,
  getProxyCircuitState,
  resetProxyCircuit,
} from "../lib/proxy-circuit.js";
import { canUseFallbackProxy } from "../lib/proxy-health.js";
import {
  findClashSwitchableSelector,
  pickClashFailoverCandidates,
} from "../lib/proxy-probe.js";

test("proxy circuit opens after consecutive failures and blocks publish preflight", () => {
  const key = "socks5://127.0.0.1:17997";
  resetProxyCircuit(key);
  recordProxyFailure(key, "timeout");
  recordProxyFailure(key, "timeout");
  assert.equal(getProxyCircuitState(key).open, false);
  recordProxyFailure(key, "timeout");
  assert.equal(getProxyCircuitState(key).open, true);
  assert.throws(() => assertProxyCircuitClosed(key), /熔断/);
  recordProxySuccess(key);
  assert.equal(getProxyCircuitState(key).open, false);
  assert.doesNotThrow(() => assertProxyCircuitClosed(key));
});

test("canUseFallbackProxy only when URLs differ", () => {
  assert.equal(canUseFallbackProxy("socks5://a:1", "socks5://a:1"), false);
  assert.equal(canUseFallbackProxy("socks5://a:1", "http://127.0.0.1:7897"), true);
  assert.equal(canUseFallbackProxy("", "http://127.0.0.1:7897"), true);
  assert.equal(canUseFallbackProxy("socks5://a:1", ""), false);
});

test("findClashSwitchableSelector prefers 节点选择 Selector over URLTest", () => {
  const proxies = {
    GLOBAL: { type: "Selector", now: "节点选择", all: ["节点选择", "DIRECT"] },
    节点选择: {
      type: "Selector",
      now: "专线-新加坡-1",
      all: ["专线-新加坡-1", "专线-香港-2", "自动选择", "DIRECT"],
    },
    自动选择: {
      type: "URLTest",
      now: "专线-日本-3",
      all: ["专线-日本-3", "专线-美国-4"],
    },
    "专线-新加坡-1": { type: "Shadowsocks" },
    "专线-香港-2": { type: "Shadowsocks" },
    "专线-日本-3": { type: "Shadowsocks" },
    "专线-美国-4": { type: "Shadowsocks" },
    DIRECT: { type: "Direct" },
  };
  const selector = findClashSwitchableSelector(proxies);
  assert.equal(selector?.group, "节点选择");
  assert.equal(selector?.current, "专线-新加坡-1");
  const candidates = pickClashFailoverCandidates(selector);
  assert.deepEqual(candidates, ["专线-香港-2"]);
  assert.ok(!candidates.includes("自动选择"));
  assert.ok(!candidates.includes("DIRECT"));
  assert.ok(!candidates.includes("专线-新加坡-1"));
});

test("pickClashFailoverCandidates respects excludeNames", () => {
  const selector = {
    group: "PROXY",
    current: "A",
    all: ["A", "B", "C"],
  };
  assert.deepEqual(pickClashFailoverCandidates(selector, { excludeNames: ["B"] }), ["C"]);
});
