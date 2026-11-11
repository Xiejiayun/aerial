import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { runLoginCli } from "../src/cli/commands/login.js";
import { runCoworkCli } from "../src/cli/commands/cowork.js";
import { mkHome, runCli } from "./helpers.js";

const forbidGitHub = new Proxy({}, { get: () => { throw new Error("must not access GitHub authentication"); } });
const forbidCowork = () => { throw new Error("must not access Cowork authentication"); };

test("login defaults to GitHub and explicit GitHub preserves its device flow", async () => {
  for (const args of [[], ["--provider", "github"], ["--provider", "github", "--force"]]) {
    const calls = [], output = [];
    const github = {
      gitHubTokenSource: () => { calls.push("source"); return args.includes("--force") ? "file" : "missing"; },
      startDeviceFlow: async () => { calls.push("start"); return { verification_uri: "https://example.test/authorize", user_code: "TEST-CODE", device_code: "synthetic-device-code", interval: 3 }; },
      pollDeviceFlow: async (...values) => calls.push(values)
    };
    assert.equal(await runLoginCli(args, { github, cowork: forbidCowork, env: {}, print: line => output.push(line) }), 0);
    assert.deepEqual(calls, ["source", "start", ["synthetic-device-code", 3]]);
    assert.deepEqual(output, ["Open: https://example.test/authorize", "Code: TEST-CODE", "Waiting for GitHub authorization...", "GitHub login saved."]);
  }
});

test("explicit GitHub preserves saved-token shortcuts and force env refusal", async () => {
  for (const source of ["env", "file"]) {
    const output = [];
    const github = { gitHubTokenSource: () => source, startDeviceFlow: () => { throw new Error("must not start flow"); } };
    assert.equal(await runLoginCli(["--provider", "github"], { github, cowork: forbidCowork, print: line => output.push(line) }), 0);
    assert.match(output[0], /not verified/);
    assert.match(output[0], source === "env" ? /AERIAL_GITHUB_TOKEN/ : /--force/);
  }
  const warnings = [];
  assert.equal(await runLoginCli(["--provider", "github", "--force"], {
    github: { gitHubTokenSource: () => "env" }, cowork: forbidCowork, warn: line => warnings.push(line)
  }), 1);
  assert.match(warnings[0], /unset.*aerial login --force/);
});

test("Cowork login delegates interactive auth without reading GitHub credentials", async () => {
  for (const extra of [[], ["--force"]]) {
    let received;
    const print = () => {}, warn = () => {};
    const status = await runLoginCli(["--provider", "cowork", ...extra], {
      github: forbidGitHub, env: { AERIAL_GITHUB_TOKEN: "synthetic-token", AERIAL_TEST_LOGIN_NO_NETWORK: "1" }, print, warn,
      cowork: async (...args) => { received = args; return 1; }
    });
    assert.equal(status, 1);
    assert.deepEqual(received, ["auth", ["--interactive"], { print, warn }]);
  }
});

test("unknown and missing login providers fail before either authentication boundary", async () => {
  for (const provider of ["unknown", "GitHub", "", "cowork ", "github,cowork"]) {
    await assert.rejects(runLoginCli(["--provider", provider], {
      github: forbidGitHub, cowork: forbidCowork
    }), /Unknown login provider/);
  }
  await assert.rejects(runLoginCli(["--provider"], { github: forbidGitHub, cowork: forbidCowork }), /--provider requires a value/);
});

test("unified Cowork login uses the existing Windows window wording and preserves auth failures", async () => {
  const output = [], calls = [];
  const runtime = { platform: "win32", nodeVersion: "24.0.0" };
  const core = { authenticateCowork: async options => calls.push(options) };
  const cowork = (command, args, options) => runCoworkCli(command, args, { ...options, runtime, core });
  assert.equal(await runLoginCli(["--provider", "cowork"], {
    github: forbidGitHub, cowork, print: line => output.push(line)
  }), 0);
  assert.deepEqual(calls, [{ interactive: true }]);
  assert.match(output[0], /Microsoft Windows sign-in window/);
  assert.doesNotMatch(output.join("\n"), /browser|device code/i);
  const profileError = new Error("Cowork requires a configured authentication profile.");
  core.authenticateCowork = async () => { throw profileError; };
  await assert.rejects(runLoginCli(["--provider", "cowork", "--force"], {
    github: forbidGitHub, cowork, print: () => {}
  }), error => error === profileError);
});

test("CLI rejects unknown login providers before credentials or sign-in output", () => {
  const home = mkHome("login-unknown-provider");
  const result = runCli(["login", "--provider", "unknown"], {
    home, extraEnv: { AERIAL_GITHUB_TOKEN: "synthetic-token", AERIAL_TEST_LOGIN_NO_NETWORK: "1" }
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown login provider/);
  assert.equal(result.stdout, "");
  assert.deepEqual(fs.readdirSync(home), []);
});

test("login help states the default provider and Cowork profile and Windows sign-in requirements", () => {
  const result = runCli(["login", "--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /login \[--provider <github\|cowork>\] \[--force\]/);
  assert.match(result.stdout, /Login defaults to GitHub/);
  assert.match(result.stdout, /Cowork requires a configured authentication profile/);
  assert.match(result.stdout, /Microsoft Windows sign-in window/);
});
