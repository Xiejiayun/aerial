import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "aerial-readiness-"));
process.env.AERIAL_CONFIG_DIR = path.join(root, "config");
process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude");
process.env.CODEX_HOME = path.join(root, "codex");
process.env.AERIAL_API_KEY = "aerial_readiness_key";
process.env.AERIAL_GITHUB_TOKEN = "github-readiness-token";
process.env.AERIAL_SKIP_ENV_PERSIST = "1";
const { loadConfig, saveConfig } = await import("../src/shared/config.js");
const { createServer } = await import("../src/proxy/server.js");
const { runSetupCli } = await import("../src/cli/commands/setup.js");
const { verifySetupReadiness } = await import("../src/cli/setup-readiness.js");
const originalFetch = globalThis.fetch;
const models = [
  { id: "gpt-test", supported_endpoints: ["/responses"], capabilities: { supports: { reasoning_effort: ["medium", "high"] } } },
  { id: "claude-opus-4.7", supported_endpoints: ["/v1/messages"], capabilities: { supports: { adaptive_thinking: true, reasoning_effort: ["medium", "high", "xhigh", "max"] } } }
];

for (const target of ["codex", "claude"]) {
  test(`${target} setup only replaces the client configuration after a real local authenticated inference succeeds`, async () => {
    const file = path.join(target === "codex" ? process.env.CODEX_HOME : process.env.CLAUDE_CONFIG_DIR, target === "codex" ? "config.toml" : "settings.json");
    const before = target === "codex" ? 'model = "previous"\n' : '{"model":"previous"}\n';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, before);
    let status = 403, calls = 0;
    const expectedModel = target === "codex" ? "gpt-test" : "claude-opus-4.7";
    globalThis.fetch = async (url, init) => {
      if (String(url).startsWith("http://127.0.0.1:")) return originalFetch(url, init);
      if (String(url).includes("copilot_internal")) return Response.json({ token: "readiness-copilot-token" });
      if (String(url).endsWith("/models")) return Response.json({ data: models });
      const body = JSON.parse(Buffer.from(init.body).toString());
      assert.equal(body.model, expectedModel);
      assert.equal(fs.readFileSync(file, "utf8"), before, "client file must remain unchanged while the route is probed");
      calls += 1;
      if (status !== 200) return Response.json({ error: { message: "Model access denied" } }, { status });
      return Response.json(target === "codex" ? { object: "response", status: "completed", output: [] } : { type: "message", role: "assistant", content: [{ type: "text", text: "OK" }] });
    };
    const server = createServer().listen(0, "127.0.0.1");
    await once(server, "listening");
    saveConfig({ ...loadConfig(), port: server.address().port });
    const output = [];
    const originalLog = console.log;
    console.log = (...args) => output.push(args.join(" "));
    try {
      const args = ["--model", expectedModel, "--effort", "medium"];
      await assert.rejects(() => runSetupCli(target, args), /subscription.*permissions/);
      assert.equal(calls, 1);
      assert.equal(fs.readFileSync(file, "utf8"), before);
      assert.equal(fs.existsSync(`${file}.aerial-state.json`), false);
      status = 200;
      await runSetupCli(target, args);
      assert.equal(calls, 2);
      assert.notEqual(fs.readFileSync(file, "utf8"), before);
      const summary = output.join("\n");
      assert.match(summary, /verified: local proxy, key helper, upstream/);
      assert.match(summary, /Restart/);
      assert.doesNotMatch(summary, /aerial defaultEffort|client config:|auth:|aerial_readiness_key/);
    } finally {
      console.log = originalLog;
      globalThis.fetch = originalFetch;
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });
}

test("unreachable local service fails before the helper runs and gives platform-specific instructions", async () => {
  let helperCalled = false;
  const failed = { route: "responses", model: "gpt-test", platform: "linux", fetchImpl: async () => { throw new Error("ECONNREFUSED"); }, run: () => { helperCalled = true; } };
  await assert.rejects(() => verifySetupReadiness(failed), /aerial start in another terminal.*Client configuration was not changed/s);
  assert.equal(helperCalled, false);
});

test("setup rejects an explicit model without the target route before writing the client file", async () => {
  globalThis.fetch = async (url) => String(url).includes("copilot_internal") ? Response.json({ token: "route-token" }) : Response.json({ data: models });
  try {
    await assert.rejects(() => runSetupCli("codex", ["--model", "claude-opus-4.7"]), /does not advertise the responses route/);
  } finally { globalThis.fetch = originalFetch; }
});
