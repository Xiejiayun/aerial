import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { parseForwardedJson } from "./helpers.js";

process.env.AERIAL_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aerial-probe-test-"));
delete process.env.AERIAL_PROMPT_CACHE_RETENTION;
process.env.AERIAL_API_KEY = "aerial_test_key";
process.env.AERIAL_GITHUB_TOKEN = "github-test-token";

const { runProbe, formatProbeReport } = await import("../src/cli/probe.js");
const { ensureApiKey } = await import("../src/shared/config.js");
ensureApiKey();

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("runProbe returns annotated model matrix without live route checks", async () => {
  let calls = 0;
  globalThis.fetch = async () => Response.json(calls++ === 0
    ? { token: "header.eyJleHAiOjk5OTk5OTk5OTl9.sig" }
    : { data: [
        { id: "gpt", supported_endpoints: ["/responses", "/chat/completions", "ws:/responses"], capabilities: { type: "chat" } },
        { id: "claude", supported_endpoints: ["/v1/messages"], capabilities: { type: "chat" } },
        { id: "embed", capabilities: { type: "embeddings" } }
      ] });

  const report = await runProbe();
  assert.equal(report.ok, true);
  assert.equal(report.summary.responses, 1);
  assert.equal(report.summary.messages, 1);
  assert.equal(report.summary.chat, 1);
  assert.equal(report.summary.websocketResponses, 1);
  assert.equal(report.summary.embeddings, 1);
  assert.equal(report.routes.length, 0);
  assert.match(formatProbeReport(report), /Model matrix/);
});

test("runProbe live checks first model for each route", async () => {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push(String(url));
    if (String(url).includes("copilot_internal")) return Response.json({ token: "header.eyJleHAiOjk5OTk5OTk5OTl9.sig" });
    if (String(url).endsWith("/models")) return Response.json({ data: [
      { id: "gpt", supported_endpoints: ["/responses", "/chat/completions"], capabilities: { type: "chat" } },
      { id: "claude", supported_endpoints: ["/v1/messages"], capabilities: { type: "chat" } }
    ] });
    const body = parseForwardedJson(init);
    return Response.json({ ok: true, model: body.model, usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } });
  };

  const report = await runProbe({ live: true });
  assert.equal(report.ok, true);
  assert.deepEqual(report.routes.map((route) => route.route), ["responses", "messages", "chat"]);
  assert.equal(report.routes.every((route) => route.ok), true);
});
