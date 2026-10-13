#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { commandRunner, runReleasePreflight } from "./release-preflight.mjs";

function requireCommand(runCommand, args) {
  const result = runCommand("git", args);
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${String(result.stderr || result.stdout || "no diagnostic output").trim()}`);
  }
  return String(result.stdout || "").trim();
}

export function prepareWorkflowRelease({
  cwd = process.cwd(),
  eventName = process.env.GITHUB_EVENT_NAME,
  githubRef = process.env.GITHUB_REF,
  expectedVersion = process.env.RELEASE_EXPECTED_VERSION || undefined,
  runCommand = commandRunner(cwd)
} = {}) {
  if (eventName === "workflow_dispatch" && !expectedVersion) {
    throw new Error("workflow_dispatch requires RELEASE_EXPECTED_VERSION");
  }

  // All registry, version, worktree, and main/tag checks finish before the
  // first write. A failed preflight must never consume a release tag.
  const result = runReleasePreflight({
    cwd, mode: "workflow", eventName, githubRef, expectedVersion, runCommand
  });

  if (eventName === "workflow_dispatch") {
    const tag = `v${result.version}`;
    const ref = `refs/tags/${tag}`;
    const existing = runCommand("git", ["rev-parse", "--verify", `${ref}^{commit}`]);
    if (existing.status === 0) {
      if (String(existing.stdout).trim() !== result.head) {
        throw new Error(`existing tag ${tag} does not match release commit ${result.head}`);
      }
    } else if (existing.status === 1 || existing.status === 128) {
      requireCommand(runCommand, [
        "-c", "user.name=github-actions[bot]",
        "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com",
        "tag", "--annotate", tag, "--message", `Aerial ${tag}`, result.head
      ]);
    } else {
      throw new Error(`cannot determine whether release tag ${tag} exists`);
    }
    // checkout's GITHUB_TOKEN does not trigger another push workflow. Never
    // force a tag: a conflicting remote tag must fail before npm publish.
    requireCommand(runCommand, ["push", "origin", `${ref}:${ref}`]);
  }

  return result;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const result = prepareWorkflowRelease();
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${result.version}\nshould_publish=${result.shouldPublish}\n`, "utf8");
    }
    console.log(`release preparation OK: version=${result.version} commit=${result.head} registry=${result.registryState} should_publish=${result.shouldPublish}`);
  } catch (error) {
    console.error(`release preparation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
