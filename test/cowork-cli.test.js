import test from "node:test";
import assert from "node:assert/strict";
import { assertCoworkRuntime, runCoworkCli } from "../src/cli/commands/cowork.js";

const runtime = { platform: "win32", nodeVersion: "24.0.0" };

test("Cowork configure imports an explicit evidence profile through the core boundary", async () => {
  let received;
  assert.equal(await runCoworkCli("configure", ["--profile", "evidence.json"], {
    runtime, core: { configureCowork: async options => { received = options; } }, print: () => {}
  }), 0);
  assert.deepEqual(received, { file: "evidence.json" });
  await assert.rejects(runCoworkCli("configure", [], { runtime, core: {} }), /requires --profile/);
});

test("Cowork alone gates Windows and Node 24, before loading authentication", () => {
  assert.throws(() => assertCoworkRuntime({ platform: "linux", nodeVersion: "26.0.0" }), /requires Windows/);
  assert.throws(() => assertCoworkRuntime({ platform: "win32", nodeVersion: "22.0.0" }), /Node.js 24/);
  assert.doesNotThrow(() => assertCoworkRuntime(runtime));
});

test("Cowork auth explicitly enables interaction and passes only the selected origin", async () => {
  const calls = [], output = [];
  const result = await runCoworkCli("auth", ["--origin", "https://tenant.example.test"], {
    runtime, core: { authenticateCowork: async options => calls.push(options) }, print: line => output.push(line)
  });
  assert.equal(result, 0);
  assert.deepEqual(calls, [{ interactive: true, origin: "https://tenant.example.test" }]);
  assert.match(output.join("\n"), /identity saved/);
});

test("Cowork rejects missing models, conflicting child flags and malformed origins before authentication", async () => {
  const core = new Proxy({}, { get: () => { throw new Error("must not touch core"); } });
  for (const args of [[], ["--model", "m", "--", "--model", "other"], ["--model", "m", "--", "--settings=override.json"]]) {
    await assert.rejects(runCoworkCli("run", args, { runtime, core }), /requires --model|not supported/);
  }
  for (const origin of ["http://example.test", "https://user:password@example.test", "https://example.test/path", "https://example.test?q=1"]) {
    await assert.rejects(runCoworkCli("auth", ["--origin", origin], { runtime, core }), /must be an HTTPS origin/);
  }
});

test("Cowork run forwards the explicit model, executable and child arguments without changing setup", async () => {
  let received;
  const openCoworkSession = async () => {};
  const result = await runCoworkCli("run", ["--model", "cowork/opus", "--claude", "claude.exe", "--", "--print", "hello"], {
    runtime, core: { openCoworkSession }, warn: () => {},
    launch: async options => { received = options; return { exitCode: 7 }; }
  });
  assert.equal(result, 7);
  assert.equal(received.model, "cowork/opus");
  assert.equal(received.executable, "claude.exe");
  assert.deepEqual(received.args, ["--print", "hello"]);
  assert.equal(received.openSession, openCoworkSession);
});

test("Cowork doctor and models use read-only core calls and return actionable status", async () => {
  const output = [];
  const core = {
    inspectCowork: async () => ({ ok: false, checks: [{ ok: false, message: "Run aerial cowork auth." }] }),
    listCoworkModels: async () => [{ publicId: "cowork/opus", displayName: "Opus" }]
  };
  assert.equal(await runCoworkCli("doctor", [], { runtime, core, print: line => output.push(line) }), 1);
  assert.match(output.join("\n"), /Run aerial cowork auth/);
  output.length = 0;
  assert.equal(await runCoworkCli("models", ["--json"], { runtime, core, print: line => output.push(line) }), 0);
  assert.deepEqual(JSON.parse(output[0]), [{ publicId: "cowork/opus", displayName: "Opus" }]);
});

test("Cowork probe sends only an explicit model to the fixed synthetic probe and states its scope", async () => {
  const warnings = [], output = [];
  let received;
  assert.equal(await runCoworkCli("probe", ["--model", "cowork/opus"], {
    runtime, core: { probeCowork: async options => { received = options; return { ok: true, model: options.model }; } },
    warn: message => warnings.push(message), print: line => output.push(line)
  }), 0);
  assert.deepEqual(received, { model: "cowork/opus" });
  assert.match(warnings[0], /consumes Cowork allowance/);
  assert.match(warnings[0], /does not establish Claude Code tool compatibility/);
  assert.deepEqual(JSON.parse(output[0]), { ok: true, model: "cowork/opus" });
  await assert.rejects(runCoworkCli("probe", [], { runtime, core: {} }), /requires --model/);
});

test("Cowork recovery commands list metadata and explain that release neither cancels nor infers", async () => {
  const output = [];
  let released;
  const records = [{ id: "synthetic-operation", phase: "UNKNOWN", remoteState: "unknown" }];
  const core = {
    listCoworkOperations: async () => records,
    releaseCoworkOperation: async options => { released = options; return { ok: true, id: options.id }; }
  };
  assert.equal(await runCoworkCli("operations", ["--json"], { runtime, core, print: line => output.push(line) }), 0);
  assert.deepEqual(JSON.parse(output[0]), records);
  assert.equal(await runCoworkCli("release", ["synthetic-operation"], { runtime, core, print: line => output.push(line) }), 0);
  assert.deepEqual(released, { id: "synthetic-operation" });
  assert.match(output[1], /does not cancel a remote task or send inference/);
});
