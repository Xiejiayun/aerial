import test from "node:test";
import assert from "node:assert/strict";
import { localCountTokens } from "../src/proxy/index.js";

async function count(payload) {
  const response = await localCountTokens(new Request("http://localhost/v1/messages/count_tokens", {
    method: "POST", body: JSON.stringify(payload)
  }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-aerial-token-count"), "estimate");
  return (await response.json()).input_tokens;
}

test("token estimates include long system prompts and tool definitions", async () => {
  const payload = { model: "claude-test", messages: [{ role: "user", content: "hello" }] };
  const baseline = await count(payload);
  const system = await count({ ...payload, system: "system instruction ".repeat(10000) });
  const tools = await count({ ...payload, tools: [{ name: "search", description: "tool instruction ".repeat(10000), input_schema: { type: "object" } }] });
  const combined = await count({ ...payload, system: "system instruction ".repeat(10000), tools: [{ description: "tool instruction ".repeat(10000) }] });
  assert.ok(system > baseline + 40000);
  assert.ok(tools > baseline + 40000);
  assert.ok(combined > system + 40000);
  assert.ok(combined > tools + 40000);
});

test("non-ASCII text and tool results are counted conservatively", async () => {
  const chinese = "这是很长的中文输入".repeat(1000);
  assert.ok(await count({ messages: [{ role: "user", content: chinese }] }) >= chinese.length);
  const short = await count({ messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "test", content: "ok" }] }] });
  const long = await count({ messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "test", content: chinese }] }] });
  assert.ok(long > short + chinese.length);
  assert.ok(await count({ input: chinese, system: chinese }) > await count({ input: chinese }));
});

test("images get a media allowance without treating base64 as prompt text", async () => {
  const image = data => ({ type: "image", source: { type: "base64", media_type: "image/png", data } });
  const message = content => ({ messages: [{ role: "user", content }] });
  const baseline = await count(message([{ type: "text", text: "describe" }]));
  const small = await count(message([image("AAAA")]));
  const large = await count(message([image("A".repeat(2_000_000))]));
  assert.ok(small > baseline + 4000);
  assert.equal(large, small);
  assert.ok(await count(message([image("AAAA"), image("AAAA")])) > small + 4000);
  assert.ok(await count(message([{ type: "image", source: { type: "url", url: "https://example.test/image.png" } }])) > baseline + 4000);
});

test("document text remains counted while binary documents receive an allowance", async () => {
  const payload = source => ({ messages: [{ role: "user", content: [{ type: "document", source }] }] });
  const short = await count(payload({ type: "text", media_type: "text/plain", data: "hello" }));
  const long = await count(payload({ type: "text", media_type: "text/plain", data: "text ".repeat(10000) }));
  assert.ok(long > short + 10000);
  assert.ok(await count(payload({ type: "base64", media_type: "application/pdf", data: "A".repeat(1_000_000) })) < 20000);
});

test("invalid token-count requests fail instead of returning a misleading count", async () => {
  for (const body of ["{", "null", "[]", '"hello"']) {
    const response = await localCountTokens(new Request("http://localhost/v1/messages/count_tokens", { method: "POST", body }));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.type, "invalid_request_error");
  }
});
