import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aerial-upstream-proxy-test-"));
process.env.AERIAL_CONFIG_DIR = temp;
const proxyEnvNames = ["AERIAL_UPSTREAM_PROXY", "ALL_PROXY", "HTTPS_PROXY", "HTTP_PROXY", "all_proxy", "https_proxy", "http_proxy"];
const originalProxyEnv = Object.fromEntries(proxyEnvNames.map((name) => [name, process.env[name]]));
for (const name of proxyEnvNames) {
  delete process.env[name];
}

const {
  disableUpstreamProxy,
  discoverProxyCandidates,
  enableUpstreamProxy,
  parsePacProxyCandidates,
  parseScutilProxyOutput,
  probeEgress,
  upstreamProxyState,
  validateProxyEndpoint,
  _clearProxyDispatcherCacheForTests
} = await import("../src/upstream/fetch.js");
const { loadConfig, saveConfig } = await import("../src/shared/config.js");

test.afterEach(async () => {
  await _clearProxyDispatcherCacheForTests();
});

test.after(() => {
  for (const [name, value] of Object.entries(originalProxyEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test("parseScutilProxyOutput extracts enabled HTTP proxies and PAC URL", () => {
  const parsed = parseScutilProxyOutput(`
<dictionary> {
  HTTPEnable : 1
  HTTPProxy : 127.0.0.1
  HTTPPort : 1087
  SOCKSEnable : 1
  SOCKSProxy : 127.0.0.1
  SOCKSPort : 1086
  ProxyAutoConfigEnable : 1
  ProxyAutoConfigURLString : http://localhost:1089/proxy.pac
}
`);

  assert.equal(parsed.pacUrl, "http://localhost:1089/proxy.pac");
  assert.deepEqual(parsed.candidates, [
    { endpoint: "http://127.0.0.1:1087", source: "macos-http-proxy" },
    { endpoint: "socks5://127.0.0.1:1086", source: "macos-socks-proxy" }
  ]);
});

test("parsePacProxyCandidates extracts HTTP(S) and SOCKS proxy directives and ignores DIRECT", () => {
  const candidates = parsePacProxyCandidates('return "SOCKS5 127.0.0.1:1086; PROXY 127.0.0.1:1087; HTTPS proxy.example:8443; DIRECT";', { source: "pac-test" });
  assert.deepEqual(candidates, [
    { endpoint: "socks5://127.0.0.1:1086", source: "pac-test" },
    { endpoint: "http://127.0.0.1:1087", source: "pac-test" },
    { endpoint: "https://proxy.example:8443", source: "pac-test" }
  ]);
});

test("discoverProxyCandidates reads macOS PAC files and adds common local ports without duplicates", async () => {
  const candidates = await discoverProxyCandidates({
    platform: "darwin",
    config: {},
    commonPorts: [1087, 7890],
    commonSocksPorts: [],
    runCommand: () => ({
      status: 0,
      stdout: "ProxyAutoConfigEnable : 1\nProxyAutoConfigURLString : http://localhost:1089/proxy.pac\n",
      stderr: ""
    }),
    fetchImpl: async () => new Response('function FindProxyForURL() { return "PROXY 127.0.0.1:1087; DIRECT"; }')
  });

  assert.deepEqual(candidates.map((c) => c.endpoint), [
    "http://127.0.0.1:1087",
    "http://127.0.0.1:7890"
  ]);
  assert.equal(candidates[0].source, "macos-pac:http://localhost:1089/proxy.pac");
});

test("discoverProxyCandidates ignores PAC files above the read limit", async () => {
  const candidates = await discoverProxyCandidates({
    platform: "darwin",
    config: {},
    commonPorts: [],
    commonSocksPorts: [],
    maxPacBytes: 8,
    runCommand: () => ({
      status: 0,
      stdout: "ProxyAutoConfigEnable : 1\nProxyAutoConfigURLString : http://localhost:1089/proxy.pac\n",
      stderr: ""
    }),
    fetchImpl: async () => new Response('return "PROXY 127.0.0.1:1087";', {
      headers: { "content-length": "10000000" }
    })
  });

  assert.deepEqual(candidates, []);
});

test("enableUpstreamProxy validates and stores the selected automatic proxy", async () => {
  const result = await enableUpstreamProxy({
    candidates: [{ endpoint: "http://127.0.0.1:1087", source: "test-candidate" }],
    fetchImpl: async () => Response.json({ resources: {}, rate: {} })
  });

  assert.equal(result.ok, true);
  const config = loadConfig();
  assert.equal(config.upstreamProxyMode, "auto");
  assert.equal(config.upstreamProxyEndpoint, "http://127.0.0.1:1087");
  assert.equal(config.upstreamProxySource, "test-candidate");
  assert.deepEqual(upstreamProxyState(config), {
    mode: "auto",
    enabled: true,
    endpoint: "http://127.0.0.1:1087",
    source: "test-candidate"
  });
});

test("enableUpstreamProxy failure leaves the previous config unchanged", async () => {
  saveConfig({
    ...loadConfig(),
    upstreamProxyMode: "auto",
    upstreamProxyEndpoint: "http://127.0.0.1:1087",
    upstreamProxySource: "previous"
  });

  const result = await enableUpstreamProxy({
    candidates: [{ endpoint: "http://127.0.0.1:7890", source: "bad-candidate" }],
    fetchImpl: async () => new Response("proxy auth required", { status: 407 })
  });

  assert.equal(result.ok, false);
  const config = loadConfig();
  assert.equal(config.upstreamProxyMode, "auto");
  assert.equal(config.upstreamProxyEndpoint, "http://127.0.0.1:1087");
  assert.equal(config.upstreamProxySource, "previous");
});

test("enableUpstreamProxy can validate and store a SOCKS5 proxy endpoint", async () => {
  const result = await enableUpstreamProxy({
    candidates: [{ endpoint: "socks5://127.0.0.1:1086", source: "pac-test" }],
    fetchImpl: async (_url, init = {}) => {
      assert.ok(init.dispatcher);
      return Response.json({ resources: {}, rate: {} });
    }
  });

  assert.equal(result.ok, true);
  const config = loadConfig();
  assert.equal(config.upstreamProxyMode, "auto");
  assert.equal(config.upstreamProxyEndpoint, "socks5://127.0.0.1:1086");
  assert.equal(config.upstreamProxySource, "pac-test");
});

test("validateProxyEndpoint requires GitHub rate_limit JSON shape", async () => {
  const html = await validateProxyEndpoint("http://127.0.0.1:1087", {
    fetchImpl: async () => new Response("<html>not github</html>", { status: 200 })
  });
  assert.equal(html.ok, false);
  assert.match(html.error, /rate_limit JSON/);

  const json = await validateProxyEndpoint("http://127.0.0.1:1087", {
    fetchImpl: async () => Response.json({ resources: {}, rate: {} })
  });
  assert.deepEqual(json, { ok: true, status: 200 });
});

test("validateProxyEndpoint rejects auth failures, server errors, and thrown fetch errors", async () => {
  const auth = await validateProxyEndpoint("http://127.0.0.1:1087", {
    fetchImpl: async () => new Response("auth required", { status: 407 })
  });
  assert.deepEqual(auth, { ok: false, status: 407, error: "http 407" });

  const server = await validateProxyEndpoint("http://127.0.0.1:1087", {
    fetchImpl: async () => new Response("bad gateway", { status: 502 })
  });
  assert.deepEqual(server, { ok: false, status: 502, error: "http 502" });

  const timeout = await validateProxyEndpoint("http://127.0.0.1:1087", {
    fetchImpl: async () => {
      throw new Error("timeout");
    }
  });
  assert.equal(timeout.ok, false);
  assert.equal(timeout.error, "timeout");
});

test("AERIAL_UPSTREAM_PROXY overrides config state without changing the saved config", () => {
  saveConfig({
    ...loadConfig(),
    upstreamProxyMode: "auto",
    upstreamProxyEndpoint: "http://127.0.0.1:1087",
    upstreamProxySource: "configured"
  });

  process.env.AERIAL_UPSTREAM_PROXY = "http://user:pass@127.0.0.1:9999";
  try {
    assert.deepEqual(upstreamProxyState(loadConfig()), {
      mode: "env",
      enabled: true,
      endpoint: "http://user:pass@127.0.0.1:9999",
      source: "AERIAL_UPSTREAM_PROXY"
    });
    const config = loadConfig();
    assert.equal(config.upstreamProxyEndpoint, "http://127.0.0.1:1087");
    assert.equal(config.upstreamProxySource, "configured");
  } finally {
    delete process.env.AERIAL_UPSTREAM_PROXY;
  }
});

test("disableUpstreamProxy returns status to direct mode", () => {
  disableUpstreamProxy();
  const config = loadConfig();
  assert.equal(config.upstreamProxyMode, "disabled");
  assert.equal(config.upstreamProxyEndpoint, undefined);
  assert.equal(upstreamProxyState(config).enabled, false);
});

test("probeEgress reports direct egress when no proxy endpoint is provided", async () => {
  const result = await probeEgress({
    fetchImpl: async (_url, init = {}) => {
      assert.equal(init.dispatcher, undefined);
      return Response.json({ ip: "203.0.113.10", city: "Singapore", region: "SG", country: "SG" });
    }
  });

  assert.deepEqual(result, {
    ok: true,
    ip: "203.0.113.10",
    city: "Singapore",
    region: "SG",
    country: "SG",
    org: undefined
  });
});
