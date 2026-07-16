import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { transportFetch } from "../lib/http-transport.js";
import { isDefinitelyUnsentPublishError } from "../lib/square-api.js";

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
}

test("GET retries a temporary upstream response", async () => {
  let requests = 0;
  await withServer(
    (_req, res) => {
      requests += 1;
      if (requests === 1) {
        res.writeHead(503, { "Content-Type": "text/plain" });
        res.end("busy");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
    },
    async (baseUrl) => {
      const response = await transportFetch(`${baseUrl}/health`, {
        method: "GET",
        retryDelaysMs: [0, 1],
      });
      assert.equal(response.status, 200);
      assert.equal(await response.text(), "ok");
    },
  );
  assert.equal(requests, 2);
});

test("POST does not retry unless the caller marks it safe", async () => {
  let requests = 0;
  await withServer(
    (_req, res) => {
      requests += 1;
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end('{"error":"busy"}');
    },
    async (baseUrl) => {
      const response = await transportFetch(`${baseUrl}/publish`, {
        method: "POST",
        retryDelaysMs: [0, 1, 1],
      });
      assert.equal(response.status, 503);
    },
  );
  assert.equal(requests, 1);
});

test("safe POST queries can opt into retry", async () => {
  let requests = 0;
  await withServer(
    (_req, res) => {
      requests += 1;
      res.writeHead(requests === 1 ? 503 : 200, { "Content-Type": "application/json" });
      res.end(requests === 1 ? '{"error":"busy"}' : '{"ok":true}');
    },
    async (baseUrl) => {
      const response = await transportFetch(`${baseUrl}/query`, {
        method: "POST",
        retryUnsafe: true,
        retryDelaysMs: [0, 1],
      });
      assert.equal(response.status, 200);
      assert.equal(await response.text(), '{"ok":true}');
    },
  );
  assert.equal(requests, 2);
});

test("classifies preflight proxy failures as definitely unsent", () => {
  const refused = new Error("连接被拒绝：代理未开启或端口错误");
  refused.code = "ECONNREFUSED";
  const wrapped = new Error("当前走代理访问币安失败");
  wrapped.cause = refused;

  assert.equal(isDefinitelyUnsentPublishError(wrapped), true);
  assert.equal(isDefinitelyUnsentPublishError(new Error("读取响应时连接被重置")), false);
});
