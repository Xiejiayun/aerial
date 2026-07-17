#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const PACKAGE_NAME = "@jiayunxie/aerial";
const VERSION_POLICY = /^0\.(0|[1-9]\d*)\.([1-9])$/;

function fail(message) {
  throw new Error(message);
}

export function assertReleaseVersion(version, expectedVersion) {
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    fail(`version ${JSON.stringify(version)} is not a clean stable semver`);
  }
  if (!VERSION_POLICY.test(version)) {
    fail(`version ${version} violates Aerial policy 0.A.B with B from 1 through 9`);
  }
  if (expectedVersion !== undefined && version !== expectedVersion) {
    fail(`version ${version} does not match expected release ${expectedVersion}`);
  }
  return version;
}

function versionParts(version) {
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    fail(`version ${JSON.stringify(version)} is not a clean stable semver`);
  }
  return version.split(".").map(Number);
}

export function compareReleaseVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function parseJson(raw, label) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(`${label} returned invalid JSON: ${error.message}`);
  }
}

function explicitE404(output) {
  return /(?:^|\s)(?:npm ERR!\s+code\s+)?E404(?:\s|$)|\bHTTP(?:Error)?\s*404\b/i.test(output);
}

export function classifyRegistryLookup(result) {
  const status = Number(result?.status);
  const stdout = String(result?.stdout || "").trim();
  const stderr = String(result?.stderr || "").trim();
  if (status === 0) {
    if (!stdout) return { state: "error", message: "registry returned empty output with exit status 0" };
    try {
      return { state: "found", value: JSON.parse(stdout) };
    } catch (error) {
      return { state: "error", message: `registry returned invalid JSON: ${error.message}` };
    }
  }
  const combined = `${stdout}\n${stderr}`;
  if (explicitE404(combined)) return { state: "missing" };
  return {
    state: "error",
    message: `registry lookup failed with status ${Number.isFinite(status) ? status : "unknown"}: ${combined.trim() || "no diagnostic output"}`
  };
}

export function readManifestVersions(cwd) {
  const packageJson = parseJson(fs.readFileSync(path.join(cwd, "package.json"), "utf8"), "package.json");
  const packageLock = parseJson(fs.readFileSync(path.join(cwd, "package-lock.json"), "utf8"), "package-lock.json");
  const versions = {
    packageVersion: packageJson.version,
    lockVersion: packageLock.version,
    lockRootVersion: packageLock.packages?.[""]?.version
  };
  if (!versions.packageVersion || versions.packageVersion !== versions.lockVersion || versions.packageVersion !== versions.lockRootVersion) {
    fail(`manifest versions disagree: package.json=${versions.packageVersion || "missing"}, package-lock.json=${versions.lockVersion || "missing"}, package-lock root=${versions.lockRootVersion || "missing"}`);
  }
  return versions;
}

export function commandRunner(cwd) {
  return (command, args) => {
    const result = spawnSync(command, args, { cwd, encoding: "utf8" });
    if (result.error) {
      return { status: null, stdout: result.stdout || "", stderr: result.error.message };
    }
    return { status: result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
  };
}

function commandText(command, args) {
  return [command, ...args].join(" ");
}

function requireCommand(runCommand, command, args, label = commandText(command, args)) {
  const result = runCommand(command, args);
  if (result.status !== 0) {
    fail(`${label} failed with status ${result.status ?? "unknown"}: ${String(result.stderr || result.stdout || "no diagnostic output").trim()}`);
  }
  return String(result.stdout || "").trim();
}

function optionalGitRef(runCommand, ref) {
  const result = runCommand("git", ["rev-parse", "--verify", ref]);
  if (result.status === 0) return String(result.stdout).trim();
  if (result.status === 1 || result.status === 128) return undefined;
  fail(`git rev-parse --verify ${ref} failed with status ${result.status ?? "unknown"}`);
}

function verifyCleanTrackedWorktree(runCommand) {
  const status = requireCommand(runCommand, "git", ["status", "--porcelain", "--untracked-files=no"]);
  if (status) fail("tracked worktree is dirty; commit or restore tracked changes before release");
}

function verifyCommonGitState(runCommand) {
  verifyCleanTrackedWorktree(runCommand);
  const head = requireCommand(runCommand, "git", ["rev-parse", "HEAD"]);
  const originMain = requireCommand(runCommand, "git", ["rev-parse", "refs/remotes/origin/main"]);
  if (head !== originMain) fail(`release commit ${head} does not match origin/main ${originMain}`);
  return { head, originMain };
}

export function verifyGitState({ mode, version, eventName, githubRef, runCommand }) {
  const { head, originMain } = verifyCommonGitState(runCommand);
  const localMain = optionalGitRef(runCommand, "refs/heads/main");
  const tagRef = `refs/tags/v${version}`;
  const tagCommit = optionalGitRef(runCommand, `${tagRef}^{commit}`);

  if (mode === "new-release") {
    const branch = requireCommand(runCommand, "git", ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (branch !== "main") fail(`new-release preflight must run on main, not ${branch || "detached HEAD"}`);
    if (!localMain || localMain !== head) fail(`local main ${localMain || "missing"} does not match release commit ${head}`);
    if (tagCommit) fail(`tag v${version} already exists at ${tagCommit}; never reuse or move a release tag`);
    return { head, originMain, localMain, tagCommit };
  }

  if (mode !== "workflow") fail(`unknown release preflight mode ${JSON.stringify(mode)}`);
  if (eventName === "push") {
    if (githubRef !== tagRef) fail(`workflow tag ${githubRef || "missing"} does not match ${tagRef}`);
    if (!tagCommit || tagCommit !== head) fail(`tag v${version} ${tagCommit || "missing"} does not match release commit ${head}`);
  } else if (eventName === "workflow_dispatch") {
    if (githubRef !== "refs/heads/main") fail(`workflow_dispatch must run from refs/heads/main, not ${githubRef || "missing"}`);
    if (localMain && localMain !== head) fail(`local main ${localMain} does not match release commit ${head}`);
    if (tagCommit && tagCommit !== head) fail(`existing tag v${version} ${tagCommit} does not match release commit ${head}`);
  } else {
    fail(`workflow mode requires GITHUB_EVENT_NAME push or workflow_dispatch, got ${eventName || "missing"}`);
  }
  return { head, originMain, localMain, tagCommit };
}

function publishedVersionsFrom(value) {
  const raw = Array.isArray(value) ? value : [value];
  return raw.filter((version) => typeof version === "string" && /^\d+\.\d+\.\d+$/.test(version));
}

function registryLookup(runCommand, ...viewArgs) {
  return classifyRegistryLookup(runCommand("npm", ["view", ...viewArgs, "--json"]));
}

function requireRegistryResult(lookup, label) {
  if (lookup.state === "error") fail(`${label}: ${lookup.message}`);
  return lookup;
}

function verifyMonotonicVersion(version, publishedVersions) {
  const otherVersions = publishedVersions.filter((published) => published !== version);
  const newerOrEqual = otherVersions.filter((published) => compareReleaseVersions(version, published) <= 0);
  if (newerOrEqual.length) {
    fail(`version ${version} is not newer than published stable version(s): ${newerOrEqual.join(", ")}`);
  }
}

function publishedGitHead(metadata) {
  return metadata && typeof metadata.gitHead === "string" ? metadata.gitHead.trim() : "";
}

export function runReleasePreflight({
  cwd = process.cwd(),
  mode,
  expectedVersion,
  eventName = process.env.GITHUB_EVENT_NAME,
  githubRef = process.env.GITHUB_REF,
  runCommand = commandRunner(cwd)
} = {}) {
  if (mode !== "new-release" && mode !== "workflow") {
    fail("usage: node scripts/release-preflight.mjs <new-release|workflow> [--expected-version X.Y.Z]");
  }
  const { packageVersion: version } = readManifestVersions(cwd);
  assertReleaseVersion(version, expectedVersion);
  const git = verifyGitState({ mode, version, eventName, githubRef, runCommand });

  const versionsLookup = requireRegistryResult(registryLookup(runCommand, PACKAGE_NAME, "versions"), "published versions lookup failed");
  const publishedVersions = versionsLookup.state === "missing" ? [] : publishedVersionsFrom(versionsLookup.value);
  verifyMonotonicVersion(version, publishedVersions);

  const targetSpec = `${PACKAGE_NAME}@${version}`;
  const targetLookup = requireRegistryResult(registryLookup(runCommand, targetSpec), `target lookup failed for ${targetSpec}`);
  if (targetLookup.state === "missing") {
    return { mode, version, head: git.head, shouldPublish: true, registryState: "missing", publishedVersions };
  }
  if (mode === "new-release") {
    fail(`${targetSpec} already exists on npm; new-release mode never reuses a published version`);
  }
  const gitHead = publishedGitHead(targetLookup.value);
  if (!gitHead) fail(`${targetSpec} exists on npm without gitHead; idempotency cannot be proven`);
  if (gitHead !== git.head) {
    fail(`${targetSpec} belongs to gitHead ${gitHead}, not release commit ${git.head}`);
  }
  return { mode, version, head: git.head, shouldPublish: false, registryState: "same-commit", publishedVersions };
}

function parseCliArgs(argv) {
  const [mode, ...rest] = argv;
  let expectedVersion;
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] !== "--expected-version" || !rest[index + 1] || index + 2 !== rest.length) {
      fail("usage: node scripts/release-preflight.mjs <new-release|workflow> [--expected-version X.Y.Z]");
    }
    expectedVersion = rest[index + 1];
    index += 1;
  }
  return { mode, expectedVersion };
}

function appendGithubOutput(result) {
  if (!process.env.GITHUB_OUTPUT) return;
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${result.version}\nshould_publish=${result.shouldPublish}\n`, "utf8");
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const result = runReleasePreflight(parseCliArgs(process.argv.slice(2)));
    appendGithubOutput(result);
    console.log(`release-preflight OK: mode=${result.mode} version=${result.version} commit=${result.head} registry=${result.registryState} should_publish=${result.shouldPublish}`);
  } catch (error) {
    console.error(`release-preflight failed: ${error.message}`);
    process.exitCode = 1;
  }
}
