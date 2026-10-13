import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runUpdateCli, runUpdateNpm } from "../src/cli/commands/update.js";

const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });

function updateFixture(t, {
  current = "0.3.3",
  latest = "0.3.4",
  viewResult = ok(JSON.stringify(latest)),
  installResult = ok(),
  installed = latest,
  local = false,
  platform = "win32"
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aerial-update-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const globalRoot = path.join(dir, "npm global 中文 & spaces");
  const globalPackage = path.join(globalRoot, "@jiayunxie", "aerial");
  const packageRoot = local ? path.join(dir, "checkout") : globalPackage;
  fs.mkdirSync(packageRoot, { recursive: true });
  const manifest = path.join(packageRoot, "package.json");
  const writeVersion = (version) => fs.writeFileSync(manifest, JSON.stringify({ name: "@jiayunxie/aerial", version }));
  writeVersion(current);
  const calls = [];
  const lines = [];
  const runNpm = (args, options) => {
    calls.push({ args, options });
    if (args[0] === "view") return viewResult;
    if (args[0] === "root") return ok(`${globalRoot}\n`);
    if (args[0] === "install") {
      if (installResult.status === 0 && !installResult.error) writeVersion(installed);
      return installResult;
    }
    throw new Error(`Unexpected npm command: ${args}`);
  };
  return {
    calls, lines, globalRoot, globalPackage, packageRoot, manifest,
    run: (args = []) => runUpdateCli(args, { runNpm, packageRoot, platform, log: (line) => lines.push(line) })
  };
}

test("update --check reports a newer release without installing or inspecting the global prefix", (t) => {
  const fixture = updateFixture(t, { current: "0.3.9", latest: "0.3.10", local: true });
  fixture.run(["--check"]);
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.calls[0].args[0], "view");
  assert.ok(fixture.calls[0].args.includes("--prefer-online"));
  assert.match(fixture.lines.join("\n"), /Update available: 0\.3\.9 -> 0\.3\.10/);
  assert.equal(JSON.parse(fs.readFileSync(fixture.manifest, "utf8")).version, "0.3.9");
});

test("update pins the checked release, verifies installation, and explains the Windows service refresh", (t) => {
  const fixture = updateFixture(t);
  fixture.run();
  assert.deepEqual(fixture.calls.map(({ args }) => args[0]), ["view", "root", "install"]);
  const install = fixture.calls[2];
  assert.ok(install.args.includes("@jiayunxie/aerial@0.3.4"));
  assert.ok(install.args.includes("--global"));
  assert.ok(install.args.includes("--engine-strict"));
  assert.ok(install.args.includes("--force=false"));
  assert.equal(install.options.stdio, "inherit");
  assert.match(fixture.lines.join("\n"), /Updated Aerial: 0\.3\.3 -> 0\.3\.4/);
  assert.match(fixture.lines.join("\n"), /Administrator terminal/);
  assert.match(fixture.lines.join("\n"), /aerial service install\n  aerial service restart/);
});

test("up-to-date and newer installations are never reinstalled or downgraded", async (t) => {
  for (const current of ["0.3.4", "0.3.10", "0.4.1", "1.0.0"]) {
    await t.test(current, (t) => {
      const fixture = updateFixture(t, { current });
      fixture.run();
      assert.equal(fixture.calls.length, 1);
      assert.match(fixture.lines.join("\n"), current === "0.3.4" ? /already up to date/ : /skipping downgrade/);
      assert.match(fixture.lines.join("\n"), /Latest Aerial in this registry: 0\.3\.4/);
    });
  }
});

test("registry failures abort the update and are not reported as up to date", async (t) => {
  for (const viewResult of [
    { status: 1, stderr: "TLS handshake failure" },
    { status: null, error: new Error("spawn npm ENOENT") },
    { status: null, signal: "SIGTERM" }
  ]) {
    await t.test(viewResult.stderr || viewResult.error?.message || viewResult.signal, (t) => {
      const fixture = updateFixture(t, { viewResult });
      assert.throws(() => fixture.run(), /Checking for Aerial updates failed/);
      assert.equal(fixture.calls.length, 1);
      assert.doesNotMatch(fixture.lines.join("\n"), /already up to date|Updated Aerial/);
    });
  }
});

test("empty, malformed, and non-stable registry versions cannot reach npm install", async (t) => {
  for (const raw of ["", "not-json", "null", "{}", '["0.3.4"]', '"0.3.4-beta.1"', '"0.3.4;echo injected"']) {
    await t.test(JSON.stringify(raw), (t) => {
      const fixture = updateFixture(t, { viewResult: ok(raw) });
      assert.throws(() => fixture.run(), /invalid latest Aerial version/);
      assert.equal(fixture.calls.length, 1);
    });
  }
});

test("an uncomparable installed version cannot trigger an update", (t) => {
  const fixture = updateFixture(t, { current: "unknown" });
  assert.throws(() => fixture.run(), /Cannot compare Aerial versions/);
  assert.equal(fixture.calls.length, 1);
});

test("a source checkout cannot update an unrelated global installation", (t) => {
  const fixture = updateFixture(t, { local: true });
  fs.mkdirSync(fixture.globalPackage, { recursive: true });
  const globalManifest = path.join(fixture.globalPackage, "package.json");
  fs.writeFileSync(globalManifest, '{"version":"0.1.1"}');
  assert.throws(() => fixture.run(), /not an npm global installation/);
  assert.deepEqual(fixture.calls.map(({ args }) => args[0]), ["view", "root"]);
  assert.equal(fs.readFileSync(globalManifest, "utf8"), '{"version":"0.1.1"}');
});

test("a linked global package is left under the developer's control", (t) => {
  const fixture = updateFixture(t, { local: true });
  fs.mkdirSync(path.dirname(fixture.globalPackage), { recursive: true });
  fs.symlinkSync(fixture.packageRoot, fixture.globalPackage, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => fixture.run(), /not an npm global installation/);
  assert.ok(fs.lstatSync(fixture.globalPackage).isSymbolicLink());
  assert.deepEqual(fixture.calls.map(({ args }) => args[0]), ["view", "root"]);
});

test("npm install failures preserve failure status and do not print success", (t) => {
  const fixture = updateFixture(t, { installResult: { status: 1, stderr: "EACCES: permission denied" } });
  assert.throws(() => fixture.run(), /Installing the Aerial update failed: EACCES/);
  assert.equal(JSON.parse(fs.readFileSync(fixture.manifest, "utf8")).version, "0.3.3");
  assert.doesNotMatch(fixture.lines.join("\n"), /Updated Aerial|aerial service restart/);
});

test("npm exit zero without the expected installed version is not success", (t) => {
  const fixture = updateFixture(t, { installed: "0.3.3" });
  assert.throws(() => fixture.run(), /reports 0\.3\.3 \(expected 0\.3\.4\)/);
  assert.doesNotMatch(fixture.lines.join("\n"), /Updated Aerial/);
});

test("restart instructions match the host platform", async (t) => {
  for (const platform of ["darwin", "linux"]) {
    await t.test(platform, (t) => {
      const fixture = updateFixture(t, { platform });
      fixture.run();
      const output = fixture.lines.join("\n");
      assert.doesNotMatch(output, /Administrator/);
      if (platform === "darwin") assert.match(output, /aerial service restart/);
      else assert.doesNotMatch(output, /aerial service install/);
      assert.match(output, /Restart any foreground Aerial process/);
    });
  }
});

test("help and invalid options never invoke npm", (t) => {
  const fixture = updateFixture(t);
  fixture.run(["--help"]);
  assert.match(fixture.lines.join("\n"), /--check/);
  assert.throws(() => fixture.run(["--chekc"]), /Usage: aerial update/);
  assert.throws(() => fixture.run(["0.3.4"]), /Usage: aerial update/);
  assert.equal(fixture.calls.length, 0);
});

test("the npm runner works without npm_execpath in a normal terminal", (t) => {
  const original = process.env.npm_execpath;
  t.after(() => {
    if (original === undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath = original;
  });
  delete process.env.npm_execpath;
  const result = runUpdateNpm(["--version"]);
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test("the Windows npm runner preserves spaces, Unicode, and shell characters", { skip: process.platform !== "win32" }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aerial-npm-中文 & spaces-"));
  const cli = path.join(dir, "npm-cli.js");
  fs.writeFileSync(cli, "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
  const original = process.env.npm_execpath;
  t.after(() => {
    if (original === undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath = original;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  process.env.npm_execpath = cli;
  const args = ["a path with spaces", "中文", "& echo unexpected", "%PATH%", "$(unexpected)"];
  const result = runUpdateNpm(args);
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.deepEqual(JSON.parse(result.stdout), args);
});
