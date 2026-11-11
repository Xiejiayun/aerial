// Real Claude Code -> real gateway -> real Cowork transport -> local synthetic
// HTTP/SSE service. Authentication and protocol evidence are synthetic fixtures;
// every transport fetch is explicitly redirected to loopback. No Azure/M365 call.
// Usage: node scripts/smoke-cowork-claude.mjs <absolute native claude executable> [--deny-write] [--default-tools]
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createCoworkGateway } from "../src/cowork/gateway.js";
import { createCoworkTransport } from "../src/cowork/transport.js";
import { launchCoworkClaude } from "../src/cowork/launcher.js";
import { createPrivateSessionDirectory, writePrivateJson } from "../src/cowork/private-files.js";

const executable = process.argv[2];
const denyWrite = process.argv.slice(3).includes("--deny-write");
const defaultTools = process.argv.slice(3).includes("--default-tools");
if (!executable || !path.isAbsolute(executable)) throw new Error("Pass the absolute path of the native Claude Code executable.");
const root = createPrivateSessionDirectory();
const workspace = path.join(root, "workspace");
fs.mkdirSync(workspace);
const input = path.join(workspace, "input.txt");
const output = path.join(workspace, "output.txt");
const inputText = "synthetic Cowork local tool integration\n";
const outputText = "verified synthetic Read and Write\n";
fs.writeFileSync(input, inputText);
const configDirectory = path.join(root, "user-config");
const userSettings = path.join(configDirectory, "settings.json");
writePrivateJson(userSettings, {
  permissions: { deny: ["Bash"] },
  env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:9", ANTHROPIC_AUTH_TOKEN: "synthetic-old-key", CLAUDE_CODE_USE_BEDROCK: "1" },
  alwaysThinkingEnabled: true,
  apiKeyHelper: "a-synthetic-helper-that-must-not-run"
});
const originalSettings = fs.readFileSync(userSettings, "utf8");
const projectSettings = path.join(workspace, ".claude", "settings.json");
writePrivateJson(projectSettings, {
  model: "synthetic-other-model",
  modelOverrides: { "cowork/claude-opus-test": "synthetic-other-route" },
  env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8", ANTHROPIC_MODEL: "synthetic-other-model", ANTHROPIC_DEFAULT_SONNET_MODEL: "synthetic-other-route", CLAUDE_CODE_SUBAGENT_MODEL: "synthetic-other-route" }
});
const originalProjectSettings = fs.readFileSync(projectSettings, "utf8");
const key = randomBytes(32).toString("base64url");
const route = { publicId: "cowork/claude-opus-test", upstreamId: "synthetic-opus-route", displayName: "Synthetic Cowork route" };
const capabilities = {
  thinkingMode: "disabled", clientEffort: "low", supportedEfforts: ["low"],
  allowedBetas: ["claude-code-20250219", "interleaved-thinking-2025-05-14", "mid-conversation-system-2026-04-07", "effort-2025-11-24"]
};
const observed = [], events = [];
let turns = 0;
const syntheticIdentity = { tenantId: "33333333-3333-4333-8333-333333333333", objectId: "44444444-4444-4444-8444-444444444444" };
const syntheticBearer = "synthetic-offline-lease-no-azure-account";
// Production validates these flags. Here they simulate an authorized profile
// solely to exercise the transport against our local server, not real evidence.
const syntheticProfile = {
  version: 1, origin: "https://cowork.synthetic.invalid", authorityHost: "https://login.microsoftonline.com",
  clientId: "11111111-1111-4111-8111-111111111111", resourceId: "22222222-2222-4222-8222-222222222222",
  scope: "22222222-2222-4222-8222-222222222222/access_as_user",
  evidence: { source: "authorized-session", observedAt: "2026-11-11T00:00:00Z", fixture: "synthetic-offline-only" },
  capabilities: { connectorsDisabled: "verified", completion: "fr-plus-rl-ok", eventCorrelation: "verified", verifiedEfforts: ["low"] }
};
const subscriptions = new Map(), submittedMessageIds = new Set(), syntheticErrors = [];
const syntheticHttp = { modelGets: 0, subscriptions: 0, posts: 0, completions: 0 };
const expectedContainer = `model=${route.upstreamId};reasoningEffort=low`;

function syntheticCompletion(prompt) {
    const encoded = /<LOCAL_CLIENT_REQUEST>\s*([\s\S]*?)\s*<\/LOCAL_CLIENT_REQUEST>/.exec(prompt)?.[1];
    assert.ok(encoded, "Gateway must preserve the structured client request");
    const request = JSON.parse(encoded);
    observed.push(request);
    assert.equal(request.model, route.publicId, "The selected public model must survive prompt adaptation");
    const results = request.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(block => block.type === "tool_result");
    turns++;
    let tool_calls = [], text = "";
    if (turns === 1) tool_calls = [{ name: "Read", input: { file_path: input } }];
    else if (turns === 2) {
      assert.equal(results.length, 1);
      assert.notEqual(results[0].is_error, true);
      assert.match(JSON.stringify(results[0].content), /synthetic Cowork local tool integration/);
      tool_calls = [{ name: "Write", input: { file_path: output, content: outputText } }];
    } else {
      assert.equal(results.length, 2);
      if (denyWrite) {
        assert.equal(results[1].is_error, true);
        assert.equal(fs.existsSync(output), false);
        text = "Cowork local permission denial integration passed.";
      } else {
        assert.notEqual(results[1].is_error, true);
        assert.equal(fs.readFileSync(output, "utf8"), outputText);
        text = "Cowork local tool integration passed.";
      }
    }
    return JSON.stringify({ version: 1, text, tool_calls });
}

const syntheticServer = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1");
    assert.equal(req.headers.authorization, `Bearer ${syntheticBearer}`);
    assert.equal(req.headers["x-tenant-id"], syntheticIdentity.tenantId);
    assert.equal(req.headers["x-user-id"], syntheticIdentity.objectId);
    assert.equal(req.headers.origin, "https://copilot.cloud.microsoft");
    assert.equal(req.headers.referer, "https://copilot.cloud.microsoft/");
    assert.equal(req.headers["content-type"], "application/json");
    assert.ok(req.headers["x-copilot-timezone"]);
    assert.match(req.headers["x-request-id"], /^[a-f0-9-]{36}$/i);
    const conversationId = req.headers["x-conversation-id"];
    assert.ok(conversationId.startsWith(`${syntheticIdentity.tenantId}:${syntheticIdentity.objectId}:`));
    if (req.method === "GET" && url.pathname === "/v1/models") {
      assert.equal(req.headers["x-container-config"], undefined);
      assert.equal(req.headers.accept, "application/json");
      syntheticHttp.modelGets++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: [{ id: route.upstreamId, display_name: route.displayName, provider: "anthropic" }] }));
      return;
    }
    assert.equal(req.headers["x-container-config"], expectedContainer, "No model or effort fallback is allowed");
    if (req.method === "GET" && url.pathname === "/v1/subscribe") {
      assert.equal(req.headers.accept, "text/event-stream");
      assert.equal(url.searchParams.get("conversationId"), conversationId);
      assert.match(url.searchParams.get("_nonce"), /^[a-f0-9-]{36}$/i);
      assert.equal(subscriptions.has(conversationId), false, "One fresh subscription per turn");
      subscriptions.set(conversationId, { response: res, posts: 0, requestId: req.headers["x-request-id"] });
      syntheticHttp.subscriptions++;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.flushHeaders(); // The real transport must receive the subscription before POST.
      res.write(": synthetic subscription ready\n\n");
      return;
    }
    assert.equal(req.method, "POST");
    assert.equal(url.pathname, "/v1/messages");
    assert.equal(req.headers.accept, "application/json");
    const subscription = subscriptions.get(conversationId);
    assert.ok(subscription, "Subscribe must complete before inference submission");
    assert.equal(++subscription.posts, 1, "Never submit the same conversation twice");
    assert.equal(req.headers["x-request-id"], subscription.requestId);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.equal(body.conversationId, conversationId);
    assert.match(body.messageId, /^[a-f0-9-]{36}$/i);
    assert.equal(submittedMessageIds.has(body.messageId), false, "Each turn submits one unique message");
    submittedMessageIds.add(body.messageId);
    assert.equal(body.queue, true);
    assert.equal(body.role, "user");
    assert.deepEqual(body.connectorsConfig, { connectors: [], include_defaults: false, packages: [] });
    assert.equal(body.content.length, 1);
    assert.equal(body.content[0].type, "text");
    const completion = syntheticCompletion(body.content[0].text);
    syntheticHttp.posts++;
    res.writeHead(202, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "accepted", conversationId, messageId: body.messageId }));
    const correlation = { conversationId, requestMessageId: body.messageId };
    subscription.response.write(`event: fr\ndata: ${JSON.stringify({ ...correlation, content: completion })}\n\n`);
    subscription.response.end(`event: rl\ndata: ${JSON.stringify({ ...correlation, st: "ok" })}\n\n`);
    syntheticHttp.completions++;
  } catch (error) {
    syntheticErrors.push(error);
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Synthetic Cowork fixture assertion failed" }));
    for (const subscription of subscriptions.values()) if (!subscription.response.writableEnded) subscription.response.end('event: error\ndata: {"fixture":"assertion-failed"}\n\n');
  }
});
syntheticServer.listen(0, "127.0.0.1");
await once(syntheticServer, "listening");
const syntheticBase = `http://127.0.0.1:${syntheticServer.address().port}`;
const syntheticOnlyFetch = (url, init) => {
  const requested = new URL(url);
  assert.equal(requested.origin, syntheticProfile.origin, "Fixture must never accept an actual M365 origin");
  assert.equal(init.redirect, "error", "Cross-origin redirects must stay disabled");
  assert.ok(["/v1/models", "/v1/subscribe", "/v1/messages"].includes(requested.pathname));
  // This is the only upstream network call in the fixture. The original origin
  // is never fetched, and redirect:error prevents leaving this local server.
  return fetch(`${syntheticBase}${requested.pathname}${requested.search}`, init);
};
const transport = createCoworkTransport({
  profile: syntheticProfile, route, fetchImpl: syntheticOnlyFetch,
  auth: { getToken: async ({ signal }) => { signal?.throwIfAborted(); return { bearer: syntheticBearer, identity: syntheticIdentity, expiresAt: Date.now() + 3600000 }; } }
});
let stdout = "", stderr = "", timeout;
let gateway;
try {
assert.deepEqual(await transport.models(), [{ upstreamId: route.upstreamId, displayName: route.displayName, provider: "anthropic" }]);
gateway = createCoworkGateway({
  key, route, capabilities, operationDirectory: path.join(root, "operations"), log: event => events.push(event), execute: transport.execute
});
const baseUrl = await gateway.listen();
const result = await launchCoworkClaude({
  model: route.publicId, executable, cwd: workspace,
  env: { ...process.env, CLAUDE_CONFIG_DIR: configDirectory, USERPROFILE: root, APPDATA: path.join(root, "appdata"), DISABLE_AUTOUPDATER: "1", NO_PROXY: "127.0.0.1,localhost" },
  args: ["--safe-mode", "--strict-mcp-config", "--no-session-persistence", ...(defaultTools ? [] : ["--tools", "Read,Write"]), "--permission-mode", denyWrite ? "manual" : "acceptEdits", ...(denyWrite ? ["--permission-prompts", "none"] : []), "--max-turns", "5", "--print", "Read input.txt, then write the requested result to output.txt."],
  openSession: async () => ({ baseUrl, apiKey: key, model: route.publicId, capabilities, close: () => gateway.close(), stats: gateway.stats }),
  spawnImpl: (file, args, options) => {
    const child = spawn(file, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    timeout = setTimeout(() => child.kill(), 60000);
    child.once("close", () => clearTimeout(timeout));
    return child;
  }
});
clearTimeout(timeout);
console.log(JSON.stringify({ kind: "real-cli-real-gateway-real-transport-synthetic-cowork", denyWrite, defaultTools, declaredTools: observed[0]?.tools?.map(tool => tool.name), root, result, turns, syntheticHttp, syntheticErrors: syntheticErrors.map(error => error.message), stdout, stderr, events }, null, 2));
assert.equal(syntheticErrors.length, 0, syntheticErrors.map(error => error.stack).join("\n"));
assert.equal(result.exitCode, 0, stderr);
assert.equal(turns, 3, stdout);
assert.deepEqual(syntheticHttp, { modelGets: 1, subscriptions: 3, posts: 3, completions: 3 });
assert.equal(submittedMessageIds.size, 3);
assert.ok([...subscriptions.values()].every(subscription => subscription.posts === 1));
for (const phase of ["SUBSCRIBING", "SUBMITTING", "ACCEPTED", "RESULT_RECEIVED"]) assert.equal(events.filter(event => event.phase === phase).length, 3);
assert.equal(gateway.stats.errors, 0, JSON.stringify(events));
assert.equal(gateway.stats.toolCalls, 2);
assert.ok(gateway.stats.toolResults >= 2);
if (denyWrite) assert.equal(fs.existsSync(output), false);
else assert.equal(fs.readFileSync(output, "utf8"), outputText);
assert.equal(fs.readFileSync(userSettings, "utf8"), originalSettings, "User settings must remain unchanged");
assert.equal(fs.readFileSync(projectSettings, "utf8"), originalProjectSettings, "Project settings must remain unchanged");
assert.ok(observed.some(request => request.messages.some(message => message.role === "system")), "Mid-conversation system instructions must be preserved");
assert.match(stdout, /integration passed/);
console.log(`Real Claude Read -> tool_result -> Write -> tool_result ${denyWrite ? "permission denial" : "execution"} passed through the real gateway and transport to a local synthetic HTTP/SSE service. No Azure or M365 request was sent.`);
} finally {
  clearTimeout(timeout);
  try { await gateway?.close(); }
  finally {
    syntheticServer.closeAllConnections();
    await new Promise(resolve => syntheticServer.close(resolve));
  }
}
