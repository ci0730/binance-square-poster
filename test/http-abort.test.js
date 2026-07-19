import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { transportFetch } from "../lib/http-transport.js";

test("transportFetch aborts in-flight request via AbortSignal", async () => {
  let hit = 0;
  const server = http.createServer((req, res) => {
    hit += 1;
    // 故意挂起，等待客户端 abort
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    }, 5000);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const controller = new AbortController();

  const pending = transportFetch(`http://127.0.0.1:${port}/slow`, {
    timeoutMs: 10000,
    retries: false,
    signal: controller.signal,
  });

  await new Promise((r) => setTimeout(r, 80));
  controller.abort(new Error("已取消托管"));

  await assert.rejects(pending, (err) => /已取消托管/.test(String(err?.message || err)));
  assert.equal(hit, 1);
  await new Promise((resolve) => server.close(resolve));
});
