// Real client integration: real Claude Code -> Aerial -> an in-process mock upstream.
// All settings and credentials are synthetic and live under a new temp directory.
// Usage: node scripts/smoke-claude-client.mjs <absolute claude executable>
import fs from "node:fs";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";

const claudeExecutable = process.argv[2];
if (!claudeExecutable) throw new Error("Pass an absolute path to the Claude executable.");
const reviewRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aerial-review-client-"));
os.homedir = () => reviewRoot;
process.env.AERIAL_CONFIG_DIR = path.join(reviewRoot, "aerial");
process.env.CLAUDE_CONFIG_DIR = path.join(reviewRoot, ".claude");
process.env.AERIAL_LOG_FILE = path.join(reviewRoot, "review.log");
process.env.AERIAL_API_KEY = "aerial_review_key";
process.env.AERIAL_GITHUB_TOKEN = "github-review-token";
delete process.env.AERIAL_UPSTREAM_PROXY;
delete process.env.AERIAL_RESPONSES_WEBSOCKET;

const { createServer } = await import("../src/proxy/server.js");
const { ensureApiKey, loadConfig, saveConfig } = await import("../src/shared/config.js");
const { setupClaude } = await import("../src/setup/clients.js");
const { claudeApiKeyHelper } = await import("../src/cli/helpers.js");
ensureApiKey();

let captured = [];
let selectedModel = "claude-opus-4.7";
globalThis.fetch = async (url, init = {}) => {
  if (String(url).includes("copilot_internal")) return Response.json({ token: "review-copilot-token" });
  if (String(url).endsWith("/models")) {
    return Response.json({ data: [{
      id: selectedModel,
      supported_endpoints: ["/v1/messages"],
      capabilities: { type: "chat", supports: {
        adaptive_thinking: true,
        reasoning_effort: ["low", "medium", "high", "xhigh", "max"]
      } }
    }] });
  }
  if (!String(url).endsWith("/v1/messages")) throw new Error("Unexpected mock upstream route");
  const payload = JSON.parse(Buffer.from(init.body).toString());
  captured.push({ model: payload.model, effort: payload.output_config?.effort, thinking: payload.thinking });
  const events = [
    { type: "message_start", message: {
      id: "msg_review_1", type: "message", role: "assistant", model: payload.model,
      content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0 }
    } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" }
  ];
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" }
  });
};

const server = createServer();
server.listen(0, "127.0.0.1");
await once(server, "listening");
saveConfig({ ...loadConfig(), port: server.address().port });
const childEnvironment = {
  ...process.env,
  CLAUDE_CONFIG_DIR: path.join(reviewRoot, ".claude"),
  USERPROFILE: reviewRoot,
  APPDATA: path.join(reviewRoot, "appdata"),
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_AUTOUPDATER: "1",
  NO_PROXY: "127.0.0.1,localhost"
};
for (const key of Object.keys(childEnvironment)) {
  if (/TOKEN|API_KEY|SECRET|AUTH|ANTHROPIC_MODEL|CLAUDE_CODE_EFFORT_LEVEL/i.test(key)) delete childEnvironment[key];
}

try {
  for (const scenario of [
    { model: 'claude-opus-4.7', requested: 'medium', expected: 'medium' },
    { model: 'claude-opus-4.7', requested: 'xhigh', expected: 'xhigh' },
    { model: 'claude-opus-4.7', requested: 'max', expected: 'xhigh' },
    { model: 'claude-opus-4.6', requested: 'xhigh', expected: 'high' },
    { model: 'claude-opus-4.7', requested: 'medium', sessionEffort: 'max', expected: 'max' }
  ]) {
    captured = [];
    selectedModel = scenario.model;
    const requestedEffort = scenario.requested;
    const setup = setupClaude({ model: selectedModel, effort: requestedEffort, apiKeyHelper: claudeApiKeyHelper() });
    const child = spawn(claudeExecutable, [
      "--safe-mode", "--setting-sources", "", "--settings", setup.file,
      "--strict-mcp-config", "--no-session-persistence", "--tools", "",
      ...(scenario.sessionEffort ? ["--effort", scenario.sessionEffort] : []),
      "--max-turns", "1", "--print", "Return ok"
    ], { cwd: reviewRoot, env: childEnvironment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    const timeout = setTimeout(() => child.kill(), 15000);
    const [exitCode, signal] = await once(child, "close");
    clearTimeout(timeout);
    console.log(JSON.stringify({ ...scenario, configuredEffort: setup.effort, exitCode, signal, upstreamRequests: [...captured], stdout, stderr }));
    assert.equal(exitCode, 0, stderr);
    assert.equal(captured.length, 1, 'Expected one inference through the local mock');
    assert.equal(captured[0].model, scenario.model);
    assert.equal(captured[0].effort, scenario.expected);
    assert.equal(captured[0].thinking?.type, 'adaptive');
  }
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
console.log(JSON.stringify({ isolatedDirectory: reviewRoot }));
