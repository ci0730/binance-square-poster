import test from "node:test";
import assert from "node:assert/strict";
import { findMatchingPublishedPost, confirmRecentPublish } from "../lib/square-api.js";

test("findMatchingPublishedPost matches recent identical body text", () => {
  const text = "今天看了一下比特币走势，波动还是挺大的，先观察仓位别追高。";
  const items = [
    {
      id: "post_1",
      bodyTextOnly: text,
      createTime: Date.now() - 30_000,
      webLink: "https://www.binance.com/zh-CN/square/post/post_1",
    },
  ];
  const matched = findMatchingPublishedPost(items, text);
  assert.equal(matched?.id, "post_1");
  assert.equal(matched?.publishStatus, "confirmed_by_fetch");
});

test("findMatchingPublishedPost ignores old posts outside time window", () => {
  const text = "以太坊最近回暖，不过还是得控制风险，别一口气梭哈。";
  const items = [
    {
      id: "old_post",
      bodyTextOnly: text,
      createTime: Date.now() - 2 * 60 * 60 * 1000,
    },
  ];
  const matched = findMatchingPublishedPost(items, text, { windowMs: 15 * 60 * 1000 });
  assert.equal(matched, null);
});

test("findMatchingPublishedPost matches by shared long head prefix", () => {
  const base =
    "市场情绪今天明显转暖，资金开始回流主流币，短线可以关注量能变化，但别盲目追涨。";
  const items = [
    {
      id: "post_2",
      bodyTextOnly: `${base} 补充一句：记得设止损。`,
      createTime: Date.now() - 5_000,
    },
  ];
  const matched = findMatchingPublishedPost(items, base);
  assert.equal(matched?.id, "post_2");
});

test("confirmRecentPublish skips cookie-dependent checks when cookie missing", async () => {
  const started = Date.now();
  const messages = [];
  const result = await confirmRecentPublish({
    apiKey: "test-key",
    cookie: "",
    text: "一段足够长的正文用于核对是否需要 Cookie 才会去拉广场列表。",
    onProgress: (info) => messages.push(info?.message || ""),
  });
  assert.equal(result, null);
  assert.ok(Date.now() - started < 2000, "should not spin on cookie-less confirm");
  assert.ok(messages.some((m) => /未配置 Cookie|跳过/.test(m)));
});
