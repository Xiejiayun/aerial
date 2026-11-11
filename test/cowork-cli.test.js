import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { assertCoworkRuntime, listCoworkModelsForCli, runCoworkCli } from "../src/cli/commands/cowork.js";
import { probeCowork } from "../src/cowork/index.js";

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

test("Cowork experimental configuration requires an explicit option and reports unverified isolation", async () => {
  let received;
  const warnings = [], output = [];
  assert.equal(await runCoworkCli("configure", ["--profile", "evidence.json", "--allow-unverified-cloud-tools"], {
    runtime, core: { configureCowork: async options => { received = options; return { experimentalTrial: true }; } },
    print: () => {}, warn: message => warnings.push(message)
  }), 0);
  assert.deepEqual(received, { file: "evidence.json", allowUnverifiedCloudTools: true });
  assert.match(warnings[0], /isolation remains unverified/);
  warnings.length = 0;
  await runCoworkCli("configure", ["--profile", "verified.json", "--allow-unverified-cloud-tools"], {
    runtime, core: { configureCowork: async () => ({ experimentalTrial: false, cloudToolIsolation: "verified" }) },
    print: () => {}, warn: message => warnings.push(message)
  });
  assert.equal(warnings.length, 0);
  assert.equal(await runCoworkCli("doctor", [], {
    runtime, core: { inspectCowork: async () => ({ ok: true, status: "ready_experimental", cloudToolIsolation: "unverified", authentication: "verified", catalog: "verified" }) },
    print: message => output.push(message)
  }), 0);
  assert.match(output.join("\n"), /cloud-tool isolation: unverified \(experimental trial enabled\)/);
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
  assert.equal(await runCoworkCli("models", ["--json"], { runtime, core, readConfig: () => ({}), print: line => output.push(line) }), 0);
  assert.deepEqual(JSON.parse(output[0]), [{ publicId: "cowork/opus", displayName: "Opus" }]);
});

test("Cowork run forwards explicit effort and rejects unsupported values before core access", async () => {
  const requests = [];
  for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
    assert.equal(await runCoworkCli("run", ["--model", "cowork/sonnet", "--effort", effort], {
      runtime, core: { openCoworkSession() {} }, warn: () => {},
      launch: async options => { requests.push(options); return { exitCode: 0 }; }
    }), 0);
    assert.equal(requests.at(-1).effort, effort);
  }
  const core = new Proxy({}, { get: () => assert.fail("Invalid effort must not touch the core") });
  await assert.rejects(runCoworkCli("run", ["--model", "cowork/sonnet", "--effort", "ultra"], { runtime, core }), { code: "UNSUPPORTED_CAPABILITY" });
});

test("Cowork verify requires explicit model and effort and prints only accepted route evidence", async () => {
  const output = [], warnings = [], requests = [];
  const evidenceFile = path.join(os.tmpdir(), "synthetic-cowork-evidence.json");
  const core = { verifyCoworkRoute: async options => {
    requests.push(options);
    return { ok: true, model: "cowork/sonnet", upstreamModel: options.model, effort: options.effort, accepted: true,
      evidenceFile, bearer: "private-token", observations: { account: "private-account" }, responseText: "private-response" };
  } };
  assert.equal(await runCoworkCli("verify", ["--model", "sonnet-5.5", "--effort", "max"], {
    runtime, core, print: line => output.push(line), warn: line => warnings.push(line)
  }), 0);
  assert.deepEqual(requests, [{ model: "sonnet-5.5", effort: "max" }]);
  assert.deepEqual(JSON.parse(output[0]), { model: "cowork/sonnet", upstreamModel: "sonnet-5.5", effort: "max", accepted: true, evidenceFile });
  assert.doesNotMatch(output.join("\n"), /private-/);
  assert.match(warnings[0], /consumes Cowork allowance/);
  assert.match(warnings[0], /Stop Aerial/);
  const unusedCore = new Proxy({}, { get: () => assert.fail("Invalid verification must not touch the core") });
  await assert.rejects(runCoworkCli("verify", ["--effort", "medium"], { runtime, core: unusedCore }), /requires --model/);
  await assert.rejects(runCoworkCli("verify", ["--model", "sonnet-5.5"], { runtime, core: unusedCore }), /requires --effort/);
  await assert.rejects(runCoworkCli("verify", ["--model", "sonnet-5.5", "--effort", "auto"], { runtime, core: unusedCore }), { code: "UNSUPPORTED_CAPABILITY" });
});

test("Cowork verify cannot report success for a failed or mismatched core result", async () => {
  for (const report of [
    { ok: false, accepted: false, error: "private-error" },
    { ok: false, accepted: false, model: { token: "private-error" } },
    { ok: true, accepted: true, model: "cowork/opus", effort: "high", evidenceFile: path.join(os.tmpdir(), "report.json") },
    { ok: true, accepted: true, model: "cowork/other", effort: "medium", evidenceFile: path.join(os.tmpdir(), "report.json") },
    { ok: true, accepted: true, model: "cowork/opus", effort: "medium" }
  ]) {
    const output = [];
    assert.equal(await runCoworkCli("verify", ["--model", "cowork/opus", "--effort", "medium"], {
      runtime, core: { verifyCoworkRoute: async () => report }, print: line => output.push(line), warn: () => {}
    }), 1);
    assert.equal(JSON.parse(output[0]).accepted, false);
    assert.doesNotMatch(output[0], /private-error/);
  }
});

test("Cowork models describe advertised effort and default values without promoting evidence", async () => {
  const output = [];
  await runCoworkCli("models", [], {
    runtime, readConfig: () => ({}), print: line => output.push(line),
    core: { listCoworkModels: async () => [{ publicId: "cowork/sonnet", displayName: "Sonnet 5.5", provider: "anthropic", supportedEfforts: ["medium", "max"], defaultEffort: "medium" }] }
  });
  assert.match(output.join("\n"), /provider=anthropic/);
  assert.match(output.join("\n"), /advertised effort: medium, max; default: medium/);
  assert.match(output.join("\n"), /not model\/effort verification evidence/);
});

test("Cowork models use the authenticated service catalog when it owns the selected profile", async () => {
  const directory = path.join(os.tmpdir(), "cowork-service-profile");
  const models = [{ publicId: "cowork/sonnet", provider: "anthropic", supportedEfforts: ["low", "high"] }];
  const core = { coworkDirectory: () => directory, listCoworkModels: async () => assert.fail("Do not reacquire the service's profile lock") };
  const result = await listCoworkModelsForCli(core, {
    readConfig: () => ({ host: "127.0.0.1", port: 18181, cowork: { profileDirectory: directory } }),
    readKey: () => "synthetic-local-key",
    fetchImpl: async (url, options) => {
      assert.equal(url, "http://127.0.0.1:18181/_aerial/cowork/catalog");
      assert.equal(options.headers.authorization, "Bearer synthetic-local-key");
      assert.equal(options.redirect, "error");
      return Response.json({ provider: "cowork", configured: true, profileDirectory: directory, models });
    }
  });
  assert.deepEqual(result, models);
});

test("Cowork catalog does not trust another service profile or fall back after an authenticated service error", async () => {
  const directory = path.join(os.tmpdir(), "cowork-service-profile");
  const core = { coworkDirectory: () => directory, listCoworkModels: async () => assert.fail("No second profile writer") };
  const dependencies = { readConfig: () => ({ host: "127.0.0.1", port: 18181, cowork: { profileDirectory: directory } }), readKey: () => "synthetic-local-key" };
  await assert.rejects(listCoworkModelsForCli(core, { ...dependencies, fetchImpl: async () => Response.json({ provider: "cowork", configured: true, profileDirectory: path.join(directory, "other"), models: [] }) }), /different profile/);
  await assert.rejects(listCoworkModelsForCli(core, { ...dependencies, fetchImpl: async () => Response.json({ error: "private-response" }, { status: 401 }) }), error => /Cannot read/.test(error.message) && !error.message.includes("private-response"));
  await assert.rejects(listCoworkModelsForCli(core, { ...dependencies, fetchImpl: async () => { throw new Error("private-network-error"); } }), error => !error.message.includes("private-network-error"));
});

test("Cowork models retain direct catalog access for an unconfigured service or a separately selected profile", async () => {
  const directory = path.join(os.tmpdir(), "cowork-separate-profile");
  let direct = 0;
  const core = { coworkDirectory: () => directory, listCoworkModels: async () => { direct++; return []; } };
  await listCoworkModelsForCli(core, { readConfig: () => ({}) });
  await listCoworkModelsForCli(core, { readConfig: () => ({ cowork: { profileDirectory: path.join(directory, "other") } }), readKey: () => assert.fail("No key needed") });
  await listCoworkModelsForCli(core, {
    readConfig: () => ({ host: "127.0.0.1", port: 18181, cowork: { profileDirectory: directory } }), readKey: () => "synthetic-local-key",
    fetchImpl: async () => Response.json({ provider: "cowork", configured: false, models: [] })
  });
  assert.equal(direct, 3);
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

test("Cowork probe forwards only the explicit model and an allowed diagnostic effort", async () => {
  const calls = [];
  for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
    const output = [];
    assert.equal(await runCoworkCli("probe", ["--model", "cowork/opus", "--effort", effort], {
      runtime, core: { probeCowork: async options => { calls.push(options); return { ok: true, requestedEffort: options.effort, protocolPromoted: false }; } },
      warn: () => {}, print: line => output.push(line)
    }), 0);
    assert.deepEqual(calls.at(-1), { model: "cowork/opus", effort });
    assert.deepEqual(JSON.parse(output[0]), { ok: true, requestedEffort: effort, protocolPromoted: false });
  }
});

test("Cowork rejects invalid probe effort before accessing core or authentication", async () => {
  const core = new Proxy({}, { get: () => { throw new Error("must not touch core"); } });
  for (const effort of ["", "auto", "ultra", "Medium", " medium", "medium;model=other", "medium\r\nx-secret: value"]) {
    await assert.rejects(runCoworkCli("probe", ["--model", "cowork/opus", "--effort", effort], { runtime, core }), { code: "UNSUPPORTED_CAPABILITY" });
  }
  await assert.rejects(runCoworkCli("probe", ["--model", "cowork/opus", "--effort"], { runtime, core }), /--effort requires a value/);
  // An unusable directory would fail immediately if validation reached profile
  // locking; this must reject before any profile access or WAM acquisition.
  for (const effort of [null, "", "auto", true, ["medium"], { effort: "medium" }]) {
    await assert.rejects(probeCowork({ model: "cowork/opus", effort, directory: "\0" }), { code: "UNSUPPORTED_CAPABILITY" });
  }
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
