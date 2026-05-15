import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.AERIAL_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aerial-copilot-test-"));
process.env.AERIAL_API_KEY = "aerial_test_key";
process.env.AERIAL_GITHUB_TOKEN = "github-test-token";

const { proxyModels, proxyChatCompletions } = await import("../src/copilot.js");
const { ensureApiKey } = await import("../src/config.js");
ensureApiKey();

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("proxyModels annotates Aerial route support", async () => {
  let calls = 0;
  globalThis.fetch = async () => Response.json({
    ...(calls++ === 0
      ? { token: "header.eyJleHAiOjk5OTk5OTk5OTl9.sig" }
      : { data: [
          { id: "gpt", supported_endpoints: ["/responses", "ws:/responses"], capabilities: { type: "chat" } },
          { id: "embed", capabilities: { type: "embeddings" } }
        ] })
  });

  const response = await proxyModels(new Request("http://127.0.0.1/v1/models", { headers: { authorization: "Bearer aerial_test_key" } }));
  const payload = await response.json();
  assert.deepEqual(payload.data[0].aerial.routes, ["responses"]);
  assert.equal(payload.data[0].aerial.supported, true);
  assert.deepEqual(payload.data[0].aerial.notes, ["websocket_responses_not_implemented"]);
  assert.equal(payload.data[1].aerial.supported, false);
  assert.deepEqual(payload.data[1].aerial.notes, ["embeddings_not_implemented"]);
});

test("proxyChatCompletions maps max_tokens to max_completion_tokens", async () => {
  let forwarded;
  globalThis.fetch = async (_url, init) => {
    forwarded = JSON.parse(Buffer.from(init.body).toString("utf8"));
    return Response.json({ ok: true });
  };

  const request = new Request("http://127.0.0.1/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer aerial_test_key", "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.4", messages: [], max_tokens: 12 })
  });
  const response = await proxyChatCompletions(request);
  assert.equal(response.status, 200);
  assert.equal(forwarded.max_tokens, undefined);
  assert.equal(forwarded.max_completion_tokens, 12);
});
