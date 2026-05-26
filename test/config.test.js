import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aerial-test-"));
process.env.AERIAL_CONFIG_DIR = temp;
process.env.AERIAL_API_KEY = "aerial_test_key";

const { apiKeyPath, configPath } = await import("../src/shared/paths.js");
const { ensureApiKey, loadConfig, validateLocalAuth, saveConfig } = await import("../src/shared/config.js");

test("ensureApiKey stores a private key file plus hash and auth validates bearer or x-api-key", () => {
  const result = ensureApiKey();
  assert.equal(result.source, "env");
  const config = loadConfig();
  assert.ok(config.apiKeyHash.startsWith("scrypt$"));
  assert.equal(fs.readFileSync(apiKeyPath(), "utf8").trim(), "aerial_test_key");
  assert.equal(validateLocalAuth({ authorization: "Bearer aerial_test_key" }, config), true);
  assert.equal(validateLocalAuth({ "x-api-key": "aerial_test_key" }, config), true);
  assert.equal(validateLocalAuth({ authorization: "Bearer bad" }, config), false);
});

test("ensureApiKey reuses the stored key without requiring an environment variable", () => {
  delete process.env.AERIAL_API_KEY;
  const result = ensureApiKey();
  assert.equal(result.source, "stored");
  assert.equal(result.apiKey, "aerial_test_key");
});

test("ensureApiKey rotates when only a hash remains", () => {
  delete process.env.AERIAL_API_KEY;
  fs.rmSync(apiKeyPath(), { force: true });
  const before = loadConfig();
  assert.ok(before.apiKeyHash);

  const result = ensureApiKey();
  assert.equal(result.source, "rotated");
  assert.ok(result.apiKey?.startsWith("aerial_"));
  assert.equal(fs.readFileSync(apiKeyPath(), "utf8").trim(), result.apiKey);
  assert.equal(validateLocalAuth({ authorization: "Bearer " + result.apiKey }, loadConfig()), true);
});

test("loadConfig defaults defaultEffort to medium when not stored", () => {
  const cfg = loadConfig();
  if (cfg.defaultEffort) {
    saveConfig({ ...cfg, defaultEffort: undefined });
  }
  const reloaded = loadConfig();
  assert.equal(reloaded.defaultEffort, "medium");
});

test("loadConfig falls back to medium when stored defaultEffort is invalid", () => {
  const current = JSON.parse(fs.readFileSync(configPath(), "utf8"));
  fs.writeFileSync(configPath(), JSON.stringify({ ...current, defaultEffort: "turbo" }, null, 2));
  const reloaded = loadConfig();
  assert.equal(reloaded.defaultEffort, "medium");
});

test("loadConfig preserves valid stored defaultEffort", () => {
  saveConfig({ ...loadConfig(), defaultEffort: "xhigh" });
  assert.equal(loadConfig().defaultEffort, "xhigh");
});

test("loadConfig defaults upstream proxy mode to disabled", () => {
  saveConfig({ ...loadConfig(), upstreamProxyMode: undefined, upstreamProxyEndpoint: undefined });
  const reloaded = loadConfig();
  assert.equal(reloaded.upstreamProxyMode, "disabled");
  assert.equal(reloaded.upstreamProxyEndpoint, undefined);
});

test("loadConfig normalizes valid upstream proxy endpoints and drops invalid ones", () => {
  saveConfig({
    ...loadConfig(),
    upstreamProxyMode: "auto",
    upstreamProxyEndpoint: "socks://127.0.0.1:1086/",
    upstreamProxySource: "manual"
  });
  const normalized = loadConfig();
  assert.equal(normalized.upstreamProxyMode, "auto");
  assert.equal(normalized.upstreamProxyEndpoint, "socks5://127.0.0.1:1086");
  assert.equal(normalized.upstreamProxySource, "manual");

  saveConfig({
    ...loadConfig(),
    upstreamProxyMode: "auto",
    upstreamProxyEndpoint: "file:///tmp/not-a-proxy",
    upstreamProxySource: "manual"
  });
  const invalid = loadConfig();
  assert.equal(invalid.upstreamProxyMode, "disabled");
  assert.equal(invalid.upstreamProxyEndpoint, undefined);
  assert.equal(invalid.upstreamProxySource, undefined);
});

test("loadConfig falls back to defaults when config.json is not valid JSON", async () => {
  fs.writeFileSync(configPath(), "{bad json", "utf8");
  const { readConfigFileStatus } = await import("../src/shared/config.js");
  const status = readConfigFileStatus();
  assert.equal(status.ok, false);
  assert.match(status.error, /JSON/);
  const reloaded = loadConfig();
  assert.equal(reloaded.host, "127.0.0.1");
  assert.equal(reloaded.port, 18181);
  assert.equal(reloaded.defaultEffort, "medium");
});
