import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.AERIAL_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aerial-app-status-test-"));
process.env.AERIAL_API_KEY = "aerial_test_key";

const { computeAppStatus } = await import("../src/app-status.js");

function makeSetup({ githubSource = "file", apiKeyExists = true, codexState = "aerial", claudeState = "missing" } = {}) {
  return {
    config: { host: "127.0.0.1", port: 18181 },
    platform: "win32",
    clients: {
      codex: { target: "codex", state: codexState, file: "codex.toml" },
      claude: { target: "claude", state: claudeState, file: "claude.json" }
    },
    auth: {
      api_key: { file: "api_key", exists: apiKeyExists, state: apiKeyExists ? "present" : "missing" },
      github_token: { file: "github_token", exists: githubSource !== "missing", source: githubSource, state: githubSource === "missing" ? "missing" : "present" }
    }
  };
}

function makeService({ supported = true, loaded = false, healthAerial = false } = {}) {
  return {
    schema: "aerial.service-status.v1",
    platform: "win32",
    supported,
    service: { loaded, summary: loaded ? "loaded" : "absent" },
    health: { aerial: healthAerial, port: 18181 },
    logs: { source: "next-install-default" },
    auth: { api_key: { state: "present" }, github_token: { state: "present" } }
  };
}

test("foreground healthy: ok=true and service install goes to hints not nextSteps", () => {
  const s = computeAppStatus(makeSetup(), makeService({ loaded: false, healthAerial: true }));
  assert.equal(s.ok, true, "foreground healthy must report ok=true");
  assert.ok(!s.nextSteps.some((x) => /service install/.test(x)), `service install must not be in nextSteps; got ${JSON.stringify(s.nextSteps)}`);
  assert.ok(s.hints.some((h) => /service install/.test(h) && /foreground/.test(h)), `service install must be in hints; got ${JSON.stringify(s.hints)}`);
});

test("no foreground, no service: ok=false and service install IS in nextSteps", () => {
  const s = computeAppStatus(makeSetup(), makeService({ loaded: false, healthAerial: false }));
  assert.equal(s.ok, false);
  assert.ok(s.nextSteps.some((x) => /service install/.test(x)));
  assert.ok(!s.hints.some((h) => /service install/.test(h)));
});

test("managed service loaded and healthy: ok=true with no service install action anywhere", () => {
  const s = computeAppStatus(makeSetup(), makeService({ loaded: true, healthAerial: true }));
  assert.equal(s.ok, true);
  assert.ok(!s.nextSteps.some((x) => /service install/.test(x)));
  assert.ok(!s.hints.some((h) => /service install/.test(h)));
});

test("missing github token: nextSteps include aerial login, ok=false", () => {
  const s = computeAppStatus(makeSetup({ githubSource: "missing" }), makeService({ loaded: true, healthAerial: true }));
  assert.equal(s.ok, false);
  assert.ok(s.nextSteps.some((x) => /aerial login/.test(x)));
});

test("env-only github token: hints include env warning", () => {
  const s = computeAppStatus(makeSetup({ githubSource: "env" }), makeService({ loaded: true, healthAerial: true }));
  assert.ok(s.hints.some((h) => /AERIAL_GITHUB_TOKEN/.test(h)));
});

test("no aerial client: nextSteps include setup, ok=false", () => {
  const s = computeAppStatus(makeSetup({ codexState: "missing", claudeState: "missing" }), makeService({ loaded: true, healthAerial: true }));
  assert.equal(s.ok, false);
  assert.ok(s.nextSteps.some((x) => /setup codex or aerial setup claude/.test(x) && !/recreate/.test(x)));
});

test("missing api key: nextSteps point to setup, not key generate", () => {
  const s = computeAppStatus(makeSetup({ apiKeyExists: false }), makeService({ loaded: true, healthAerial: true }));
  assert.ok(s.nextSteps.some((x) => /recreate the local Aerial key/.test(x)));
  assert.ok(!s.nextSteps.some((x) => /key generate/.test(x)));
});

test("missing client and api key: setup nextStep is not duplicated", () => {
  const s = computeAppStatus(
    makeSetup({ apiKeyExists: false, codexState: "missing", claudeState: "missing" }),
    makeService({ loaded: false, healthAerial: false })
  );
  const setupSteps = s.nextSteps.filter((x) => /aerial setup codex or aerial setup claude/.test(x));
  assert.deepEqual(setupSteps, ["run: aerial setup codex or aerial setup claude"]);
  assert.ok(!s.nextSteps.some((x) => /key generate/.test(x)));
});
