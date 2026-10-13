import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import path from "node:path";
import { localBaseUrl } from "../src/shared/urls.js";
import { defaultHealthFetch } from "../src/service/health.js";
import { mkHome } from "./helpers.js";

const home = mkHome("ipv6");
Object.assign(process.env, { HOME: home, USERPROFILE: home, CODEX_HOME: "", CLAUDE_CONFIG_DIR: "", AERIAL_CONFIG_DIR: path.join(home, "config"), AERIAL_API_KEY: "aerial_test_key" });
const { loadConfig, saveConfig } = await import("../src/shared/config.js");
const { setupCodex, setupClaude, setupStatus } = await import("../src/setup/index.js");

test("all supported loopback hosts produce usable service and client URLs", () => {
  for (const host of ["127.0.0.1", "localhost", "::1"]) {
    const authority = host === "::1" ? "[::1]" : host;
    assert.equal(localBaseUrl({ host, port: 18181 }), `http://${authority}:18181`);
    assert.equal(new URL(localBaseUrl({ host, port: 18181 }, "/v1")).pathname, "/v1");
    saveConfig({ ...loadConfig(), host });
    setupCodex({ model: "test" });
    setupClaude({ model: "test" });
    const status = setupStatus();
    assert.equal(status.clients.codex.state, "aerial");
    assert.equal(status.clients.claude.state, "aerial");
    assert.equal(status.clients.codex.baseUrl, `http://${authority}:18181/v1`);
    assert.equal(status.clients.claude.baseUrl, `http://${authority}:18181`);
  }
});

test("health probes reach a real IPv6 loopback server", async t => {
  const server = http.createServer((req, res) => {
    assert.equal(req.url, "/health");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, service: "aerial" }));
  });
  try {
    server.listen(0, "::1");
    await once(server, "listening");
  } catch (error) {
    if (["EAFNOSUPPORT", "EADDRNOTAVAIL"].includes(error.code)) return t.skip(`IPv6 unavailable: ${error.code}`);
    throw error;
  }
  t.after(() => new Promise(resolve => server.close(resolve)));
  const result = await defaultHealthFetch("::1", server.address().port);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.body.service, "aerial");
});
