import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.AERIAL_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aerial-doctor-test-"));
process.env.AERIAL_API_KEY = "aerial_test_key";

const { doctor, renderDoctorText, renderRepairCommand } = await import("../src/doctor.js");

function makeSetup({
  apiKeyExists = true,
  githubSource = "file",
  codexState = "aerial",
  claudeState = "missing"
} = {}) {
  return {
    schema: "aerial.setup-status.v1",
    platform: "win32",
    config: { host: "127.0.0.1", port: 18181 },
    auth: {
      api_key: { file: "api_key", exists: apiKeyExists },
      github_token: { file: "github_token", exists: githubSource !== "missing", source: githubSource }
    },
    clients: {
      codex: { target: "codex", state: codexState, file: "codex.toml" },
      claude: { target: "claude", state: claudeState, file: "claude.json" }
    }
  };
}

function makeService({
  supported = true,
  platform = "win32",
  installed = false,
  loaded = false,
  healthAerial = false,
  portConflict = false,
  conflictReason,
  wrapperStale = false,
  staleReasons = []
} = {}) {
  return {
    schema: "aerial.service-status.v1",
    platform,
    supported,
    config: { host: "127.0.0.1", port: 18181 },
    service: {
      installed,
      loaded,
      summary: loaded ? "loaded" : (installed ? "installed" : "absent"),
      wrapper: { stale: wrapperStale, staleReasons }
    },
    health: { aerial: healthAerial, port: 18181, portConflict, conflictReason },
    logs: { source: "next-install-default" }
  };
}

test("empty config: api_key + github_token + client all fail with repair commands", async () => {
  const report = await doctor({
    setup: makeSetup({ apiKeyExists: false, githubSource: "missing", codexState: "missing", claudeState: "missing" }),
    service: makeService({ installed: false, loaded: false, healthAerial: false })
  });
  assert.equal(report.schema, "aerial.doctor.v1");
  assert.equal(report.ok, false);
  const apiKey = report.checks.find((c) => c.id === "auth.api_key");
  assert.equal(apiKey.severity, "fail");
  assert.deepEqual(apiKey.repair, { command: "aerial", args: ["setup", "codex"] });
  const gh = report.checks.find((c) => c.id === "auth.github_token");
  assert.equal(gh.severity, "fail");
  assert.deepEqual(gh.repair, { command: "aerial", args: ["login"] });
  const client = report.checks.find((c) => c.id === "clients.aerial_client");
  assert.equal(client.severity, "fail");
  assert.deepEqual(client.repair, { command: "aerial", args: ["setup", "codex"] });
});

test("env-only github token: warn, not fail; ok remains true if nothing else fails", async () => {
  const report = await doctor({
    setup: makeSetup({ githubSource: "env" }),
    service: makeService({ installed: true, loaded: true, healthAerial: true })
  });
  const gh = report.checks.find((c) => c.id === "auth.github_token");
  assert.equal(gh.severity, "warn");
  assert.equal(gh.ok, true);
  assert.match(gh.message, /AERIAL_GITHUB_TOKEN/);
  assert.equal(report.ok, true);
});

test("no aerial client: fail with setup repair", async () => {
  const report = await doctor({
    setup: makeSetup({ codexState: "missing", claudeState: "missing" }),
    service: makeService({ installed: true, loaded: true, healthAerial: true })
  });
  const client = report.checks.find((c) => c.id === "clients.aerial_client");
  assert.equal(client.severity, "fail");
  assert.equal(report.ok, false);
});

test("wrapper stale: warn with service install repair, ok stays true", async () => {
  const report = await doctor({
    setup: makeSetup(),
    service: makeService({
      installed: true, loaded: true, healthAerial: true,
      wrapperStale: true, staleReasons: ["WRAPPER_NODE_MISSING"]
    })
  });
  const stale = report.checks.find((c) => c.id === "service.wrapper_stale");
  assert.ok(stale, "wrapper_stale check must be present when service.wrapper.stale is true");
  assert.equal(stale.severity, "warn");
  assert.equal(stale.ok, true);
  assert.deepEqual(stale.repair, { command: "aerial", args: ["service", "install"] });
  assert.match(stale.message, /WRAPPER_NODE_MISSING/);
  assert.equal(report.ok, true);
});

test("doctor JSON schema: top-level shape and check[].repair structure", async () => {
  const report = await doctor({
    setup: makeSetup({ apiKeyExists: false }),
    service: makeService({ installed: false, loaded: false, healthAerial: false })
  });
  assert.equal(report.schema, "aerial.doctor.v1");
  assert.equal(typeof report.ok, "boolean");
  assert.equal(typeof report.summary, "string");
  assert.ok(Array.isArray(report.checks));
  assert.equal(typeof report.status, "object");
  assert.equal(typeof report.status.schema, "string");
  for (const c of report.checks) {
    assert.equal(typeof c.id, "string");
    assert.equal(typeof c.ok, "boolean");
    assert.ok(["fail", "warn", "info"].includes(c.severity));
    assert.equal(typeof c.message, "string");
    if (c.repair) {
      assert.equal(typeof c.repair.command, "string");
      assert.ok(Array.isArray(c.repair.args));
      for (const a of c.repair.args) assert.equal(typeof a, "string");
    }
  }
});

test("renderDoctorText groups fail/warn/info and renders repair commands", async () => {
  const report = await doctor({
    setup: makeSetup({ apiKeyExists: false, githubSource: "env" }),
    service: makeService({ installed: true, loaded: true, healthAerial: true })
  });
  const text = renderDoctorText(report);
  assert.match(text, /Failures:/);
  assert.match(text, /Warnings:/);
  assert.match(text, /Info:/);
  assert.match(text, /-> run: aerial setup codex/);
  assert.match(text, /-> run: aerial login/);
});

test("renderRepairCommand handles missing or malformed repair gracefully", () => {
  assert.equal(renderRepairCommand(undefined), "");
  assert.equal(renderRepairCommand(null), "");
  assert.equal(renderRepairCommand({ command: "aerial", args: ["doctor"] }), "aerial doctor");
  assert.equal(renderRepairCommand({ command: "aerial" }), "aerial");
});

test("doctor.ok must align with status.ok: unsupported service is warn but app.ok=false", async () => {
  const report = await doctor({
    setup: makeSetup(),
    service: makeService({ supported: false, platform: "linux" })
  });
  assert.equal(report.status.ok, false, "computeAppStatus must report ok=false for unsupported service");
  const failures = report.checks.filter((c) => c.severity === "fail");
  assert.equal(failures.length, 0, "no fail-severity checks in this scenario");
  assert.equal(report.ok, false, "doctor.ok must be false when status.ok is false even without fail-severity checks");
});
