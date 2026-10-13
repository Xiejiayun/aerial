import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { cliPath, parseForwardedJson } from "./helpers.js";

process.env.AERIAL_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aerial-probe-test-"));
delete process.env.AERIAL_PROMPT_CACHE_RETENTION;
process.env.AERIAL_API_KEY = "aerial_test_key";
process.env.AERIAL_GITHUB_TOKEN = "github-test-token";

const { runProbe, formatProbeReport } = await import("../src/cli/probe.js");
const { ensureApiKey } = await import("../src/shared/config.js");
const { clearModelCatalogCacheForTests } = await import("../src/proxy/model-catalog.js");
ensureApiKey();

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  clearModelCatalogCacheForTests();
});

test("runProbe returns annotated model matrix without live route checks", async () => {
  let calls = 0;
  globalThis.fetch = async () => Response.json(calls++ === 0
    ? { token: "header.eyJleHAiOjk5OTk5OTk5OTl9.sig" }
    : { data: [
        { id: "gpt", supported_endpoints: ["/responses", "/chat/completions", "ws:/responses"], capabilities: { type: "chat", supports: { reasoning_effort: ["none", "low", "max"] } } },
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
  assert.deepEqual(report.models[0].efforts, ["none", "low", "max"]);
  assert.match(formatProbeReport(report), /gpt: routes=responses,responses_websocket,chat efforts=none,low,max/);
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

function failingRoutes(url) {
  if (String(url).includes("copilot_internal")) return Response.json({ token: "header.eyJleHAiOjk5OTk5OTk5OTl9.sig" });
  if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "test", supported_endpoints: ["/responses", "/v1/messages", "/chat/completions"], capabilities: { type: "chat" } }] });
  return Response.json({ error: { message: "upstream unavailable" } }, { status: 503 });
}

test("all failed inference routes make the live probe fail with readable details", async () => {
  globalThis.fetch = async url => failingRoutes(url);
  const report = await runProbe({ live: true });
  assert.equal(report.ok, false);
  assert.equal(report.routes.length, 3);
  assert.ok(report.routes.every(route => !route.ok && route.status === 503));
  assert.equal(report.scope, "proxy-handlers");
  const output = formatProbeReport(report);
  assert.match(output, /FAILED/);
  assert.match(output, /responses: fail status=503/);
  assert.match(output, /upstream unavailable/);
});

test("a route exception is reported and the remaining routes are still checked", async () => {
  globalThis.fetch = async url => {
    if (String(url).endsWith("/responses")) throw new Error("connection interrupted");
    return failingRoutes(url);
  };
  const report = await runProbe({ live: true });
  assert.equal(report.ok, false);
  assert.equal(report.routes.length, 3);
  assert.match(report.routes[0].error.message, /interrupted/);
});

test("live probe without testable routes and catalog network failures return failure", async () => {
  globalThis.fetch = async () => Response.json({ data: [] });
  const empty = await runProbe({ live: true });
  assert.equal(empty.ok, false);
  assert.match(empty.error.message, /No inference routes/);
  globalThis.fetch = async () => { throw new Error("catalog offline"); };
  const failure = await runProbe();
  assert.equal(failure.ok, false);
  assert.equal(failure.error.message, "catalog offline");
});

test("probe --live exits nonzero when the inference checks fail", () => {
  const preload = path.join(process.env.AERIAL_CONFIG_DIR, "probe-fetch.mjs");
  fs.writeFileSync(preload, `${failingRoutes.toString()}\nglobalThis.fetch = async url => failingRoutes(url);\n`);
  const result = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, cliPath, "probe", "--live", "--json"], { env: process.env, encoding: "utf8" });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(JSON.parse(result.stdout).ok, false);
});
