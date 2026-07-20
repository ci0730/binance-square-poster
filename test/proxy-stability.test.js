import test from "node:test";
import assert from "node:assert/strict";
import {
  assertProxyCircuitClosed,
  recordProxyFailure,
  recordProxySuccess,
  getProxyCircuitState,
  resetProxyCircuit,
} from "../lib/proxy-circuit.js";
import { canUseFallbackProxy, isProxyLatencyHealthy, shouldAllowProxyFallback, isRemoteAccountProxy } from "../lib/proxy-health.js";

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

test("remote account proxy does not silently fall back to global", () => {
  assert.equal(isRemoteAccountProxy("socks5://147.1.1.1:6028"), true);
  assert.equal(isRemoteAccountProxy("http://127.0.0.1:7897"), false);
  assert.equal(
    shouldAllowProxyFallback("socks5://147.1.1.1:6028", "http://127.0.0.1:7897"),
    false,
  );
  assert.equal(
    shouldAllowProxyFallback("socks5://147.1.1.1:6028", "http://127.0.0.1:7897", {
      allowProxyFallback: true,
    }),
    true,
  );
  assert.equal(shouldAllowProxyFallback("", "http://127.0.0.1:7897"), true);
});

test("isProxyLatencyHealthy allows soft-continue when Clash delay looks fine", () => {
  assert.equal(isProxyLatencyHealthy({ ok: true, latencyMs: 199 }), true);
  assert.equal(isProxyLatencyHealthy({ ok: true, latencyMs: 0 }), false);
  assert.equal(isProxyLatencyHealthy({ ok: false, latencyMs: 199 }), false);
  assert.equal(isProxyLatencyHealthy(null), false);
});
