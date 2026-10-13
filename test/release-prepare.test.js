import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { commandRunner } from "../scripts/release-preflight.mjs";
import { prepareWorkflowRelease } from "../scripts/prepare-release.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aerial-prepare-release-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "checkout");
  const remote = path.join(root, "origin.git");
  fs.mkdirSync(cwd);
  const command = commandRunner(cwd);
  const git = (...args) => {
    const result = command("git", args);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "--bare", remote);
  git("init", "--initial-branch=main");
  git("config", "user.name", "Aerial release test");
  git("config", "user.email", "release-test@example.com");
  fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ name: "@jiayunxie/aerial", version: "0.3.1" }));
  fs.writeFileSync(path.join(cwd, "package-lock.json"), JSON.stringify({ version: "0.3.1", packages: { "": { version: "0.3.1" } } }));
  git("add", "package.json", "package-lock.json");
  git("commit", "--message", "Release fixture");
  const previous = git("rev-parse", "HEAD");
  git("commit", "--allow-empty", "--message", "Reviewed release");
  const head = git("rev-parse", "HEAD");
  git("remote", "add", "origin", remote);
  git("push", "--set-upstream", "origin", "main");
  const calls = [];
  const runCommand = (name, args) => {
    calls.push([name, ...args]);
    if (name === "npm") {
      assert.ok(args.includes("--registry=https://registry.npmjs.org"));
      return args.includes("versions")
        ? { status: 0, stdout: '["0.2.9"]', stderr: "" }
        : { status: 1, stdout: "", stderr: "npm error code E404" };
    }
    return command(name, args);
  };
  const options = { cwd, eventName: "workflow_dispatch", githubRef: "refs/heads/main", expectedVersion: "0.3.1", runCommand };
  return { ...options, options, command, git, remote, head, previous, calls };
}

test("dispatch requires an explicit expected version before running commands", () => {
  assert.throws(() => prepareWorkflowRelease({
    eventName: "workflow_dispatch", expectedVersion: "",
    runCommand() { assert.fail("missing version must not run a command"); }
  }), /requires RELEASE_EXPECTED_VERSION/);
});

test("dispatch prepares one annotated immutable tag after preflight and supports same-commit recovery", (t) => {
  const { options, git, remote, head, calls, runCommand } = fixture(t);
  assert.equal(prepareWorkflowRelease(options).shouldPublish, true);
  const tagObject = git("rev-parse", "refs/tags/v0.3.1");
  assert.equal(git("cat-file", "-t", "refs/tags/v0.3.1"), "tag");
  assert.equal(git("--git-dir", remote, "rev-parse", "refs/tags/v0.3.1^{commit}"), head);
  const targetLookup = calls.findIndex((args) => args[0] === "npm" && args.includes("@jiayunxie/aerial@0.3.1"));
  const tagWrite = calls.findIndex((args) => args.includes("--annotate"));
  assert.ok(targetLookup >= 0 && tagWrite > targetLookup);

  assert.equal(prepareWorkflowRelease(options).shouldPublish, true);
  assert.equal(git("rev-parse", "refs/tags/v0.3.1"), tagObject);
  const recovery = prepareWorkflowRelease({
    ...options,
    runCommand(name, args) {
      if (name === "npm") {
        return { status: 0, stderr: "", stdout: JSON.stringify(args.includes("versions") ? ["0.2.9", "0.3.1"] : { version: "0.3.1", gitHead: head }) };
      }
      return runCommand(name, args);
    }
  });
  assert.equal(recovery.shouldPublish, false);
  assert.equal(git("--git-dir", remote, "rev-parse", "refs/tags/v0.3.1"), tagObject);
});

test("failed version, branch, or official registry checks never create a tag", (t) => {
  const { options, command, runCommand } = fixture(t);
  assert.throws(() => prepareWorkflowRelease({ ...options, expectedVersion: "0.3.2" }), /does not match expected/);
  assert.throws(() => prepareWorkflowRelease({ ...options, githubRef: "refs/heads/feature" }), /must run from refs\/heads\/main/);
  assert.throws(() => prepareWorkflowRelease({
    ...options,
    runCommand(name, args) {
      return name === "npm" ? { status: 1, stderr: "TLS handshake failed" } : runCommand(name, args);
    }
  }), /published versions lookup failed/);
  assert.equal(command("git", ["show-ref", "--tags"]).status, 1);
});

test("dispatch refuses a conflicting local release tag", (t) => {
  const { options, git, previous } = fixture(t);
  git("tag", "--annotate", "v0.3.1", "--message", "Existing release", previous);
  const tagObject = git("rev-parse", "refs/tags/v0.3.1");
  assert.throws(() => prepareWorkflowRelease(options), /existing tag .* does not match release commit/);
  assert.equal(git("rev-parse", "refs/tags/v0.3.1"), tagObject);
});

test("dispatch cannot overwrite a conflicting remote tag even when the local tag is absent", (t) => {
  const { options, git, remote, previous } = fixture(t);
  git("--git-dir", remote, "tag", "v0.3.1", previous);
  assert.throws(() => prepareWorkflowRelease(options), /git push .*failed/);
  assert.equal(git("--git-dir", remote, "rev-parse", "refs/tags/v0.3.1^{commit}"), previous);
});

test("tag-triggered preparation verifies the release without writing or pushing tags", (t) => {
  const { options, git, calls } = fixture(t);
  git("tag", "--annotate", "v0.3.1", "--message", "Release");
  assert.equal(prepareWorkflowRelease({ ...options, eventName: "push", githubRef: "refs/tags/v0.3.1" }).shouldPublish, true);
  assert.equal(calls.some((args) => args[0] === "git" && (args.includes("push") || args.includes("tag"))), false);
});
