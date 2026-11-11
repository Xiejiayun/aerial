import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { closeCoworkBeforeStop } from "../src/service/cowork-stop.js";
import { serviceStop, serviceRestart, serviceUninstall } from "../src/service/index.js";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aerial-cowork-stop-"));
process.env.AERIAL_CONFIG_DIR = directory;
process.env.AERIAL_LOG_DIR = path.join(directory, "logs");
const config = { host: "127.0.0.1", port: 18181, cowork: { model: "cowork/claude-opus-test", profileDirectory: path.join(directory, "cowork") } };
fs.writeFileSync(path.join(directory, "config.json"), JSON.stringify(config));
const key = "synthetic-stop-key-not-a-credential";
const success = { ok: true, provider: "cowork", closed: true };

test("Cowork stop waits for authenticated local close confirmation", async t => {
  let completed = false;
  const server = http.createServer((request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/_aerial/cowork/close");
    assert.equal(request.headers.authorization, `Bearer ${key}`);
    assert.equal(request.headers.origin, undefined);
    setTimeout(() => { completed = true; response.end(JSON.stringify(success)); }, 20);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const result = await closeCoworkBeforeStop({ config: { ...config, port: server.address().port }, readKey: () => key });
  assert.equal(completed, true);
  assert.deepEqual(result, { closed: true });
});

test("the native stop helper loads the selected stored key without putting it in arguments or output", async t => {
  const helperDirectory = path.join(directory, "native-helper");
  fs.mkdirSync(helperDirectory);
  fs.writeFileSync(path.join(helperDirectory, "api_key"), key);
  let closed = false;
  const server = http.createServer((request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${key}`);
    closed = true;
    response.end(JSON.stringify(success));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  fs.writeFileSync(path.join(helperDirectory, "config.json"), JSON.stringify({ ...config, port: server.address().port }));
  const args = [fileURLToPath(new URL("../src/service/cowork-stop.js", import.meta.url))];
  assert.equal(args.join(" ").includes(key), false);
  const child = spawn(process.execPath, args, { windowsHide: true, env: { ...process.env, AERIAL_CONFIG_DIR: helperDirectory } });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const [code] = await once(child, "close");
  assert.equal(code, 0, output);
  assert.equal(closed, true);
  assert.equal(output, "");
});

test("Cowork stop permits only the known old-server 404 and rejects errors without exposing response data", async () => {
  const legacy = { error: { type: "not_found", message: "No route for POST /_aerial/cowork/close" } };
  assert.deepEqual(await closeCoworkBeforeStop({ config, readKey: () => key, fetchImpl: async () => Response.json(legacy, { status: 404 }) }), { closed: false, legacy: true });
  for (const [status, body] of [[401, { message: key }], [503, {}], [404, { error: { type: "not_found", message: key } }], [200, { ok: true, closed: false }], [200, { ...success, extra: "x".repeat(5000) }]]) {
    await assert.rejects(closeCoworkBeforeStop({ config, readKey: () => key, fetchImpl: async (_url, options) => {
      assert.equal(options.redirect, "error");
      return Response.json(body, { status });
    } }), error => /not confirmed/.test(error.message) && !error.message.includes(key));
  }
  await assert.rejects(closeCoworkBeforeStop({ config, readKey: () => key, fetchImpl: async () => { throw new Error(key); } }), error => !error.message.includes(key));
});

test("Cowork stop rejects remote targets or missing keys before making a request", async () => {
  let fetched = false;
  const fetchImpl = async () => { fetched = true; return Response.json(success); };
  await assert.rejects(closeCoworkBeforeStop({ config: { ...config, host: "example.com" }, readKey: () => key, fetchImpl }), /loopback/);
  await assert.rejects(closeCoworkBeforeStop({ config, readKey: () => undefined, fetchImpl }), /existing local Aerial key/);
  assert.deepEqual(await closeCoworkBeforeStop({ config: { host: "127.0.0.1", port: 18181 }, readKey: () => { throw new Error("must not read"); }, fetchImpl }), { closed: false, skipped: true });
  assert.equal(fetched, false);
});

test("Cowork stop has a bounded request timeout", async () => {
  await assert.rejects(closeCoworkBeforeStop({ config, readKey: () => key, timeoutMs: 5, fetchImpl: (_url, { signal }) => new Promise((resolve, reject) => {
    const hold = setTimeout(resolve, 1000);
    signal.addEventListener("abort", () => { clearTimeout(hold); reject(signal.reason); }, { once: true });
  }) }), /not confirmed/);
});

function runner(closeStatus = 0) {
  const calls = [];
  const run = (file, args, options) => {
    calls.push({ file, args, options });
    if (file === "powershell.exe") {
      const script = Buffer.from(args.at(-1), "base64").toString("utf16le");
      return { status: 0, stdout: script.includes("[int]$task.State") ? '{"installed":true,"state":4}' : "[4321]" };
    }
    if (file === process.execPath) {
      assert.match(args[0], /cowork-stop\.js$/);
      assert.equal(args.length, 1);
      assert.equal(options.env.AERIAL_CONFIG_DIR, directory);
      assert.equal(options.timeout, 15_000);
      return { status: closeStatus, stdout: "", stderr: key };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  return { calls, run };
}

test("Windows service stop closes Cowork before terminating the task tree", { skip: process.platform !== "win32" }, () => {
  const fixture = runner();
  assert.equal(serviceStop({ run: fixture.run }).ok, true);
  const closeAt = fixture.calls.findIndex(call => call.file === process.execPath);
  const killAt = fixture.calls.findIndex(call => call.file === "taskkill.exe");
  assert.ok(closeAt >= 0 && closeAt < killAt);
  assert.deepEqual(fixture.calls[killAt].args, ["/PID", "4321", "/T", "/F"]);
});

test("Windows stop, restart and uninstall preserve the service if Cowork close fails", { skip: process.platform !== "win32" }, async () => {
  for (const invoke of [serviceStop, serviceRestart, serviceUninstall]) {
    const fixture = runner(1);
    const result = await invoke({ run: fixture.run });
    assert.equal(result.ok, false);
    assert.equal(JSON.stringify(result).includes(key), false);
    assert.equal(fixture.calls.some(call => call.file === "taskkill.exe" || call.file === "schtasks.exe"), false);
  }
});
