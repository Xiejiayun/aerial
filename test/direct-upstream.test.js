import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { mkHome } from "./helpers.js";
import { proxyResponsesWebSocket } from "../src/proxy/responses-websocket.js";
import { upstreamFetch } from "../src/upstream/fetch.js";

test("legacy routing blocks outbound requests until explicitly cleared", async (context) => {
  const dir = mkHome("direct-routing");
  const previous = process.env;
  process.env = { ...previous, AERIAL_CONFIG_DIR: dir };
  context.after(() => { process.env = previous; fs.unlinkSync(path.join(dir, "config.json")); fs.rmdirSync(dir); });
  delete process.env.AERIAL_UPSTREAM_PROXY;
  const file = path.join(dir, "config.json");
  const fetch = context.mock.method(globalThis, "fetch", async () => new Response("ok"));
  fs.writeFileSync(file, JSON.stringify({ upstreamProxyMode: "auto" }));
  await assert.rejects(upstreamFetch("https://example.invalid"), /Before using a direct connection/);
  await assert.rejects(proxyResponsesWebSocket({}, {}, { url: "ws://127.0.0.1:1" }), /Before using a direct connection/);
  fs.writeFileSync(file, "{}");
  process.env.AERIAL_UPSTREAM_PROXY = "http://127.0.0.1:1234";
  await assert.rejects(upstreamFetch("https://example.invalid"), /Before using a direct connection/);
  assert.equal(fetch.mock.callCount(), 0);
  delete process.env.AERIAL_UPSTREAM_PROXY;
  const signal = AbortSignal.timeout(1000);
  assert.equal(await (await upstreamFetch("https://example.invalid", { signal })).text(), "ok");
  assert.deepEqual(fetch.mock.calls[0].arguments, ["https://example.invalid", { signal }]);
});
