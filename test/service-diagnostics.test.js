import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { runCli, mkHome } from "./helpers.js";

process.env.AERIAL_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aerial-service-diagnostics-"));
delete process.env.AERIAL_SERVICE_DRYRUN;
const { serviceStatus } = await import("../src/service/status.js");
const { saveConfig, loadConfig } = await import("../src/shared/config.js");
const { createServer } = await import("../src/proxy/server.js");

test("Linux service status probes a real foreground proxy", async t => {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  saveConfig({ ...loadConfig(), host: "127.0.0.1", port: server.address().port });
  const status = await serviceStatus({ platform: "linux", readState: () => { throw new Error("must not query a service manager"); } });
  assert.equal(status.supported, false);
  assert.equal(status.ok, true);
  assert.equal(status.health.aerial, true);
  assert.equal(status.health.supervisor, "foreground");
  assert.equal(status.summary, "running (foreground)");
  assert.deepEqual(status.nextSteps, []);
});

test("unknown service manager state preserves proxy health and an actionable error", async () => {
  const status = await serviceStatus({
    platform: "win32", readState: () => { throw new Error("Permission denied"); },
    healthFetch: async () => ({ ok: true, status: 200, body: { service: "aerial" } })
  });
  assert.equal(status.ok, false);
  assert.equal(status.service.installed, undefined);
  assert.equal(status.service.loaded, undefined);
  assert.equal(status.service.reason, "status_query_failed");
  assert.match(status.service.error, /Permission denied/);
  assert.equal(status.health.aerial, true);
  assert.equal(status.health.supervisor, "unknown");
  assert.ok(status.nextSteps.some(step => /service status --json/.test(step)));
  assert.equal(JSON.parse(JSON.stringify(status)).service.reason, "status_query_failed");
});

test("a failing health fetch remains a structured diagnostic", async () => {
  const status = await serviceStatus({ platform: "linux", healthFetch: async () => { throw new Error("Connection refused"); } });
  assert.equal(status.ok, false);
  assert.match(status.health.error, /Connection refused/);
  assert.ok(status.nextSteps.some(step => /aerial start/.test(step)));
});

test("service status CLI exits nonzero with JSON and a repair when health is down", () => {
  const result = runCli(["service", "status", "--json"], { home: mkHome("service-status-down"), extraEnv: { AERIAL_SERVICE_DRYRUN: "1" } });
  assert.equal(result.status, 1, result.stderr);
  const status = JSON.parse(result.stdout);
  assert.equal(status.ok, false);
  assert.ok(status.nextSteps.length > 0);
});
