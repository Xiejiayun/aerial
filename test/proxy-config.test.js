import test from "node:test";
import assert from "node:assert/strict";
import { normalizeProxyEndpoint, redactProxyEndpoint, redactProxySource } from "../src/upstream/proxy-config.js";

test("normalizeProxyEndpoint accepts HTTP(S) and SOCKS proxy endpoints", () => {
  assert.equal(normalizeProxyEndpoint("http://127.0.0.1:1087/"), "http://127.0.0.1:1087");
  assert.equal(normalizeProxyEndpoint("socks://127.0.0.1:1086/"), "socks5://127.0.0.1:1086");
  assert.equal(normalizeProxyEndpoint("socks5h://127.0.0.1:1086/"), "socks5://127.0.0.1:1086");
  assert.equal(normalizeProxyEndpoint("http://127.0.0.1:1087/proxy"), undefined);
});

test("proxy redaction hides userinfo in endpoints and discovery sources", () => {
  assert.equal(redactProxyEndpoint("http://user:secret@127.0.0.1:1087"), "http://redacted@127.0.0.1:1087");
  assert.equal(redactProxyEndpoint("socks5://user:p%40ss@127.0.0.1:1086"), "socks5://redacted@127.0.0.1:1086");
  assert.equal(redactProxyEndpoint("http://127.0.0.1:1087"), "http://127.0.0.1:1087");
  assert.equal(
    redactProxySource("macos-pac:http://user:secret@localhost:1089/proxy.pac"),
    "macos-pac:http://redacted@localhost:1089/proxy.pac"
  );
});
