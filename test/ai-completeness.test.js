import assert from "node:assert/strict";
import test from "node:test";
import {
  isLikelyIncompletePost,
  isTruncatedFinishReason,
  mergeAiContinuation,
} from "../lib/ai-generator.js";

test("recognizes provider token-limit finish reasons", () => {
  assert.equal(isTruncatedFinishReason("length"), true);
  assert.equal(isTruncatedFinishReason("max_tokens"), true);
  assert.equal(isTruncatedFinishReason("MAX_TOKENS"), true);
  assert.equal(isTruncatedFinishReason("stop"), false);
});

test("detects an unfinished post while accepting a complete post with token tags", () => {
  assert.equal(
    isLikelyIncompletePost("BTC 量能正在回升，但真正需要确认的关键在于", "stop"),
    true,
  );
  assert.equal(
    isLikelyIncompletePost(
      "BTC 量能回升，但追涨仍需等待关键位置确认。控制仓位，先看突破是否站稳。\n$BTC $ETH",
      "stop",
    ),
    false,
  );
});

test("merges a continuation without repeating the overlap", () => {
  const merged = mergeAiContinuation(
    "市场已经给出方向，接下来关注成交量",
    "成交量能否持续放大。若量价配合，再考虑顺势跟进。",
  );
  assert.equal(
    merged,
    "市场已经给出方向，接下来关注成交量能否持续放大。若量价配合，再考虑顺势跟进。",
  );
});
