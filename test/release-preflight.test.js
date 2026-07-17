import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertReleaseVersion,
  classifyRegistryLookup,
  compareReleaseVersions,
  readManifestVersions,
  runReleasePreflight
} from "../scripts/release-preflight.mjs";

function tempManifests({ packageVersion = "0.3.1", lockVersion = packageVersion, lockRootVersion = lockVersion } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "aerial-release-preflight-"));
  fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ name: "@jiayunxie/aerial", version: packageVersion }));
  fs.writeFileSync(path.join(cwd, "package-lock.json"), JSON.stringify({ version: lockVersion, packages: { "": { version: lockRootVersion } } }));
  return cwd;
}

function result(status, stdout = "", stderr = "") {
  return { status, stdout, stderr };
}

function fakeRunner({
  head = "a".repeat(40),
  originMain = head,
  localMain = head,
  branch = "main",
  dirty = false,
  tagCommit,
  versions = ["0.1.1", "0.2.9"],
  target = result(1, "", "npm ERR! code E404")
} = {}) {
  return (command, args) => {
    const key = [command, ...args].join(" ");
    if (key === "git status --porcelain --untracked-files=no") return result(0, dirty ? " M package.json\n" : "");
    if (key === "git rev-parse HEAD") return result(0, `${head}\n`);
    if (key === "git rev-parse refs/remotes/origin/main") return result(0, `${originMain}\n`);
    if (key === "git rev-parse --verify refs/heads/main") return localMain ? result(0, `${localMain}\n`) : result(128, "", "missing");
    if (key === "git symbolic-ref --quiet --short HEAD") return branch ? result(0, `${branch}\n`) : result(1, "", "detached");
    if (key === "git rev-parse --verify refs/tags/v0.3.1^{commit}") return tagCommit ? result(0, `${tagCommit}\n`) : result(128, "", "missing");
    if (key === "npm view @jiayunxie/aerial versions --json") return result(0, JSON.stringify(versions));
    if (key === "npm view @jiayunxie/aerial@0.3.1 --json") return target;
    throw new Error(`unexpected command: ${key}`);
  };
}

test("Aerial release version policy accepts 0.A.B with B 1 through 9", () => {
  assert.equal(assertReleaseVersion("0.3.1"), "0.3.1");
  assert.equal(assertReleaseVersion("0.12.9", "0.12.9"), "0.12.9");
  for (const invalid of ["1.3.1", "0.3.0", "0.3.10", "0.03.1", "0.3.1-rc.1", "0.3.1+build"]) {
    assert.throws(() => assertReleaseVersion(invalid));
  }
  assert.throws(() => assertReleaseVersion("0.3.1", "0.3.2"), /does not match expected/);
});

test("release version comparison is numeric", () => {
  assert.ok(compareReleaseVersions("0.3.1", "0.2.9") > 0);
  assert.ok(compareReleaseVersions("0.10.1", "0.9.9") > 0);
  assert.equal(compareReleaseVersions("0.3.1", "0.3.1"), 0);
});

test("registry lookup distinguishes explicit E404 from ambiguous failures", () => {
  assert.equal(classifyRegistryLookup(result(1, "", "npm ERR! code E404")).state, "missing");
  assert.equal(classifyRegistryLookup(result(1, "", "npm ERR! code E500")).state, "error");
  assert.equal(classifyRegistryLookup(result(1, "", "getaddrinfo ENOTFOUND registry.npmjs.org")).state, "error");
  assert.equal(classifyRegistryLookup(result(0, "")).state, "error");
  assert.equal(classifyRegistryLookup(result(0, "not-json")).state, "error");
  assert.deepEqual(classifyRegistryLookup(result(0, '{"gitHead":"abc"}')), { state: "found", value: { gitHead: "abc" } });
});

test("manifest versions must agree in both lockfile locations", () => {
  const cwd = tempManifests();
  assert.equal(readManifestVersions(cwd).packageVersion, "0.3.1");
  assert.throws(() => readManifestVersions(tempManifests({ lockRootVersion: "0.2.9" })), /manifest versions disagree/);
});

test("new-release accepts a clean, monotonic, unpublished main commit", () => {
  const outcome = runReleasePreflight({ cwd: tempManifests(), mode: "new-release", expectedVersion: "0.3.1", runCommand: fakeRunner() });
  assert.equal(outcome.shouldPublish, true);
  assert.equal(outcome.registryState, "missing");
});

test("new-release rejects reuse even when npm gitHead matches", () => {
  const head = "b".repeat(40);
  const runCommand = fakeRunner({ head, target: result(0, JSON.stringify({ version: "0.3.1", gitHead: head })) });
  assert.throws(() => runReleasePreflight({ cwd: tempManifests(), mode: "new-release", runCommand }), /never reuses/);
});

test("new-release rejects non-monotonic versions, dirty files, stale main, and existing tags", () => {
  assert.throws(() => runReleasePreflight({ cwd: tempManifests(), mode: "new-release", runCommand: fakeRunner({ versions: ["0.3.2"] }) }), /not newer/);
  assert.throws(() => runReleasePreflight({ cwd: tempManifests(), mode: "new-release", runCommand: fakeRunner({ dirty: true }) }), /dirty/);
  assert.throws(() => runReleasePreflight({ cwd: tempManifests(), mode: "new-release", runCommand: fakeRunner({ originMain: "c".repeat(40) }) }), /does not match origin\/main/);
  assert.throws(() => runReleasePreflight({ cwd: tempManifests(), mode: "new-release", runCommand: fakeRunner({ tagCommit: "d".repeat(40) }) }), /already exists/);
});

test("workflow mode permits only an existing target from the same release commit", () => {
  const head = "e".repeat(40);
  const target = result(0, JSON.stringify({ version: "0.3.1", gitHead: head }));
  const outcome = runReleasePreflight({
    cwd: tempManifests(),
    mode: "workflow",
    eventName: "push",
    githubRef: "refs/tags/v0.3.1",
    runCommand: fakeRunner({ head, tagCommit: head, versions: ["0.2.9", "0.3.1"], target })
  });
  assert.equal(outcome.shouldPublish, false);
  assert.equal(outcome.registryState, "same-commit");

  const wrongTarget = result(0, JSON.stringify({ version: "0.3.1", gitHead: "f".repeat(40) }));
  assert.throws(() => runReleasePreflight({
    cwd: tempManifests(),
    mode: "workflow",
    eventName: "push",
    githubRef: "refs/tags/v0.3.1",
    runCommand: fakeRunner({ head, tagCommit: head, versions: ["0.3.1"], target: wrongTarget })
  }), /belongs to gitHead/);
});

test("workflow mode rejects tag and dispatch context mismatches", () => {
  const head = "1".repeat(40);
  assert.throws(() => runReleasePreflight({
    cwd: tempManifests(),
    mode: "workflow",
    eventName: "push",
    githubRef: "refs/tags/v0.3.2",
    runCommand: fakeRunner({ head, tagCommit: head })
  }), /does not match refs\/tags\/v0\.3\.1/);
  assert.throws(() => runReleasePreflight({
    cwd: tempManifests(),
    mode: "workflow",
    eventName: "workflow_dispatch",
    githubRef: "refs/heads/feature",
    runCommand: fakeRunner({ head })
  }), /must run from refs\/heads\/main/);
});
