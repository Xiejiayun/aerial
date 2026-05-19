#!/usr/bin/env node
// Compute and publish a nightly pre-release of @jiayunxie/aerial.
//
// Called by .github/workflows/nightly.yml. Emits GitHub Actions outputs:
//   did_publish=<true|false>
//   published_version=<semver|empty>
//
// Round-10 spec recap:
//
//   1. base = `npm view @jiayunxie/aerial@latest version` and bump its PATCH
//      by one. `@latest` is ONLY used to compute the next-patch base; it is
//      NEVER the skip watermark. If `@latest` does not exist on the
//      registry, we fail fast: the agreed sequence is "publish the first
//      stable manually before enabling nightlies".
//
//   2. version = `<base>-nightly.YYYYMMDD.<sha7>` where YYYYMMDD is UTC and
//      sha7 is `git rev-parse --short=7 HEAD`. Pre-release suffix sorts
//      after `<base>-0` but before any later stable release, so a stable
//      release at the same base can ship later without conflicts.
//
//   3. skip watermark = `npm view @jiayunxie/aerial@nightly --json` ->
//      `gitHead`. We tolerate only two known watermark states (any other
//      state hard-fails before we even compute a version):
//        - explicit E404 / "No match" / "not found"           → no @nightly
//                                                                tarball yet,
//                                                                first nightly
//                                                                publish.
//        - npm view succeeds AND `gitHead` is a non-empty     → compare
//          string                                                gitHead vs
//                                                                local HEAD.
//      Everything else is "unknown registry state" — we throw, the publish
//      job fails, did_publish=false is written to GITHUB_OUTPUT, and the
//      next nightly run will retry against a healthy registry. Unknown
//      states include:
//        - npm view exits 0 but stdout is EMPTY (not an explicit 404; we
//          do NOT collapse this into the first-nightly branch);
//        - view succeeds but `gitHead` is missing or not a string;
//        - view fails for any reason other than E404 (network, 5xx,
//          auth/config, JSON parse error from npmViewJson).
//      This mirrors release.yml's idempotency precheck: never publish into
//      unknown state. If gitHead == HEAD, no new commits since the last
//      nightly, so we emit did_publish=false and exit 0 cleanly. This is
//      the ONLY skip rule; we do not consult `@latest`'s gitHead.
//
//   4. Publish via `npm publish --tag nightly --provenance --access public`,
//      after temporarily rewriting `package.json`'s `version` string in
//      place (we do NOT call `npm version`, because that would also touch
//      `package-lock.json` and leave a dirty lockfile after publish).
//
//   5. E409 recovery: a previous attempt may have already published the
//      same tarball but failed before npm view propagated. On 409, retry
//      `npm view @jiayunxie/aerial@<want> --json` with backoff (2s/5s/10s)
//      and, if the published `gitHead` equals our HEAD, treat as
//      idempotent success. Otherwise fail loudly — a different commit
//      already owns the version slot.
//
//   6. No destructive git operations. We restore `package.json` by
//      overwriting it with the original bytes we captured at startup, in
//      a `finally` block so any failure mid-publish still cleans up. We
//      do NOT call `git checkout -- package.json` or `git restore`, per
//      round 10 safety review.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const PACKAGE_NAME = "@jiayunxie/aerial";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJsonPath = path.join(repoRoot, "package.json");

function logInfo(message) {
  console.log(`publish-nightly: ${message}`);
}

function logWarn(message) {
  console.warn(`publish-nightly: ${message}`);
}

function logError(message) {
  console.error(`publish-nightly: ${message}`);
}

function writeGithubOutput(key, value) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) {
    logWarn(`GITHUB_OUTPUT not set; would write ${key}=${value}`);
    return;
  }
  fs.appendFileSync(outputFile, `${key}=${value}\n`);
}

function runCapture(command, options = {}) {
  // Single command string + shell:true is the cross-platform npm/git
  // invocation pattern we settled on for verify-package and verify-secrets.
  // Avoids Node 22 DEP0190 (args alongside shell:true is deprecated).
  const result = spawnSync(command, {
    cwd: repoRoot,
    encoding: "utf8",
    shell: true,
    ...options
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
}

function gitHeadSha() {
  const result = runCapture("git rev-parse HEAD");
  if (result.status !== 0) {
    throw new Error(`git rev-parse HEAD failed: ${result.stderr.trim() || "unknown"}`);
  }
  return result.stdout.trim();
}

function gitHeadShortSha() {
  const result = runCapture("git rev-parse --short=7 HEAD");
  if (result.status !== 0) {
    throw new Error(`git rev-parse --short=7 HEAD failed: ${result.stderr.trim() || "unknown"}`);
  }
  return result.stdout.trim();
}

function utcDateStamp(now = new Date()) {
  const yyyy = now.getUTCFullYear().toString().padStart(4, "0");
  const mm = (now.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = now.getUTCDate().toString().padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

function npmViewJson(spec) {
  // Returns one of:
  //   { ok: true, data: <parsed json> }                          — view succeeded
  //   { ok: false, missing: true, reason: "e404" }               — explicit
  //                                                                404 / "No
  //                                                                match" /
  //                                                                "not found"
  //   { ok: false, missing: true, reason: "empty" }              — exit 0 but
  //                                                                stdout empty
  //                                                                (ambiguous —
  //                                                                callers
  //                                                                decide
  //                                                                whether to
  //                                                                treat as
  //                                                                missing or
  //                                                                unknown)
  //   { ok: false, missing: false, stderr: "..." }               — other
  //                                                                failure
  //                                                                (network,
  //                                                                5xx,
  //                                                                auth/config,
  //                                                                JSON parse
  //                                                                error)
  //
  // Watermark callers treat `reason === "empty"` as unknown registry state
  // (hard fail), because npm can return status 0 with empty stdout in edge
  // cases that are not real 404s (e.g. some registry mirrors when a manifest
  // exists but is filtered). `getNightlySkipWatermark()` mirrors release.yml's
  // idempotency precheck: only an explicit E404 means "first nightly, allow
  // continue". `getLatestBaseVersion()` and `reconcileConflict()` keep
  // treating both reasons as missing because either way means "no current
  // record on the registry" for the purposes of those flows.
  const result = runCapture(`npm view ${spec} --json`);
  if (result.status === 0) {
    const stdout = result.stdout.trim();
    if (stdout === "") {
      return { ok: false, missing: true, reason: "empty" };
    }
    try {
      return { ok: true, data: JSON.parse(stdout) };
    } catch (error) {
      return { ok: false, missing: false, stderr: `parse: ${error.message}` };
    }
  }
  // npm prints E404 for missing packages/tags. Detect both message and code.
  const combined = `${result.stdout}\n${result.stderr}`;
  if (/E404|code E404|not found|No match/i.test(combined)) {
    return { ok: false, missing: true, reason: "e404" };
  }
  return { ok: false, missing: false, stderr: combined.trim() };
}

function bumpPatch(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) {
    throw new Error(`cannot parse semver from '${version}'`);
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return `${major}.${minor}.${patch + 1}`;
}

function readLocalPackageVersion() {
  const raw = fs.readFileSync(packageJsonPath, "utf8");
  const pkg = JSON.parse(raw);
  if (typeof pkg.version !== "string" || pkg.version.length === 0) {
    throw new Error("package.json: missing string `version` field");
  }
  return { raw, version: pkg.version };
}

function getLatestBaseVersion() {
  // base = bumpPatch(@latest). If @latest is unpublished, we fail fast and
  // tell the operator to publish the first stable manually first. Per the
  // round-10 agreement, nightlies are NOT bootstrapped from a local
  // `package.json.version` because that couples nightly version-space to
  // whatever the dev happened to commit and defeats the "@latest is the
  // source of truth for base" rule.
  const view = npmViewJson(`${PACKAGE_NAME}@latest version`);
  if (view.ok) {
    const remoteVersion = typeof view.data === "string"
      ? view.data
      : view.data?.version;
    if (typeof remoteVersion === "string" && remoteVersion.length > 0) {
      return { base: bumpPatch(remoteVersion), latestVersion: remoteVersion };
    }
    throw new Error(
      `npm view ${PACKAGE_NAME}@latest succeeded but returned no usable version field; cannot compute next-patch base.`
    );
  }
  if (view.missing) {
    throw new Error(
      `${PACKAGE_NAME}@latest is not published. Nightly cannot compute a next-patch base without a stable release on the registry. Publish a stable release manually first (see docs/release-runbook.md §5/§6), then re-run nightly.`
    );
  }
  throw new Error(
    `npm view ${PACKAGE_NAME}@latest failed (not E404): ${view.stderr}. Aborting; cannot proceed without a verified @latest base.`
  );
}

function getNightlySkipWatermark() {
  // Tight classification matching the round-14/15 contract with @DevboxManager:
  // nightly may only proceed when we KNOW one of two states.
  //
  //   1. `npm view @nightly` returns an explicit 404 / `No match`  → first
  //      (reason === "e404")                                         nightly,
  //                                                                  return
  //                                                                  { exists: false }.
  //   2. `npm view @nightly` succeeds AND `data.gitHead`            → return
  //      is a non-empty string                                        { exists: true,
  //                                                                     gitHead,
  //                                                                     version }
  //                                                                   so main() can skip
  //                                                                   when gitHead matches
  //                                                                   local HEAD.
  //
  // Any other outcome is "unknown registry state" and we hard fail rather
  // than risk overwriting `@nightly` with a fresh tarball that has the same
  // git commit as the previous nightly but a newer date stamp:
  //
  //   3. view succeeds but `gitHead` is missing or not a string    → throw.
  //   4. view fails for any reason other than E404 (network, 5xx,
  //      auth/config, JSON parse error from npmViewJson)            → throw.
  //   5. view exits 0 with EMPTY stdout (reason === "empty")        → throw.
  //      An exit-0/empty-stdout response is not an explicit 404 — it is an
  //      ambiguous registry response we refuse to interpret as "no nightly
  //      yet".
  //
  // The publish step running with an unknown watermark is the failure mode
  // we are guarding against here. We mirror release.yml's idempotency
  // precheck — "unknown registry state ⇒ refuse to publish".
  const view = npmViewJson(`${PACKAGE_NAME}@nightly`);
  if (view.ok) {
    const data = view.data;
    const gitHead = typeof data?.gitHead === "string" && data.gitHead.length > 0
      ? data.gitHead
      : null;
    const version = typeof data?.version === "string" ? data.version : null;
    if (gitHead === null) {
      throw new Error(
        `npm view ${PACKAGE_NAME}@nightly succeeded but did not return a usable string gitHead (version=${version ?? "<missing>"}). Refusing to publish a new nightly against unknown watermark state. Inspect the @nightly manifest on the registry and fix it manually before re-running.`
      );
    }
    return { exists: true, gitHead, version };
  }
  if (view.missing && view.reason === "e404") {
    return { exists: false, gitHead: null, version: null };
  }
  if (view.missing && view.reason === "empty") {
    throw new Error(
      `npm view ${PACKAGE_NAME}@nightly exited 0 but returned empty stdout — ambiguous registry response, not an explicit E404. Refusing to publish a new nightly against unknown watermark state. Re-run after the registry is healthy or investigate.`
    );
  }
  throw new Error(
    `npm view ${PACKAGE_NAME}@nightly failed (not E404): ${view.stderr}. Refusing to publish against unknown watermark state. Re-run after the registry is healthy or investigate.`
  );
}

function writeVersionInPackageJson(targetVersion) {
  // Direct in-place rewrite of package.json's `version` field. We do NOT
  // shell out to `npm version --no-git-tag-version`, because that command
  // also rewrites `package-lock.json` and the script would then need to
  // capture/restore both files. Direct read/write keeps the side-effect
  // surface to exactly one file (package.json), which our `finally`
  // already restores from the original bytes.
  const raw = fs.readFileSync(packageJsonPath, "utf8");
  const pkg = JSON.parse(raw);
  pkg.version = targetVersion;
  // Preserve trailing newline if the original had one — most package.json
  // files end with "\n" and we shouldn't introduce a diff there.
  const endsWithNewline = raw.endsWith("\n");
  const next = JSON.stringify(pkg, null, 2) + (endsWithNewline ? "\n" : "");
  fs.writeFileSync(packageJsonPath, next);
  logInfo(`Wrote in-memory version ${targetVersion} into package.json (lockfile untouched).`);
}

function restorePackageJson(originalRaw) {
  // Idempotent restore: overwrite package.json with the bytes we captured at
  // startup. NO `git checkout --` per round 10 safety review (a destructive
  // git command can silently wipe local edits if cwd drifts).
  fs.writeFileSync(packageJsonPath, originalRaw);
}

function attemptPublish(targetVersion) {
  // Returns:
  //   { ok: true }
  //   { ok: false, conflict: true }      — E409 / EPUBLISHCONFLICT
  //   { ok: false, conflict: false, status }
  const result = spawnSync(
    "npm publish --tag nightly --access public --provenance",
    {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
      encoding: "utf8"
    }
  );
  // Mirror stdout/stderr so the workflow log shows progress + final state.
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status === 0) {
    return { ok: true };
  }
  const combined = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (/E409|EPUBLISHCONFLICT|cannot publish over the previously published versions/i.test(combined)) {
    return { ok: false, conflict: true, status: result.status };
  }
  return { ok: false, conflict: false, status: result.status };
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function reconcileConflict(targetVersion, headSha) {
  // After E409: poll `npm view @jiayunxie/aerial@<want>` with backoff. If the
  // already-published gitHead matches our HEAD, the previous run published
  // this exact commit but crashed before reporting success. Treat as
  // idempotent. Anything else (different sha, missing gitHead) is a real
  // failure — fail loudly.
  const backoffsMs = [2000, 5000, 10000];
  for (let attempt = 0; attempt < backoffsMs.length; attempt += 1) {
    logInfo(`E409 reconciliation attempt ${attempt + 1}/${backoffsMs.length} after ${backoffsMs[attempt]}ms backoff.`);
    await sleep(backoffsMs[attempt]);
    const view = npmViewJson(`${PACKAGE_NAME}@${targetVersion}`);
    if (!view.ok) {
      if (view.missing) {
        logWarn(`npm view ${PACKAGE_NAME}@${targetVersion} still 404 — registry propagation delay; retrying.`);
        continue;
      }
      logWarn(`npm view during reconciliation failed: ${view.stderr}; retrying.`);
      continue;
    }
    const publishedGitHead = view.data?.gitHead;
    if (typeof publishedGitHead === "string" && publishedGitHead === headSha) {
      logInfo(`Reconciled: ${PACKAGE_NAME}@${targetVersion} already published from this HEAD (${headSha}). Idempotent success.`);
      return { idempotent: true };
    }
    return {
      idempotent: false,
      reason: `published ${PACKAGE_NAME}@${targetVersion} has gitHead='${publishedGitHead ?? "<missing>"}' which does not match local HEAD '${headSha}'.`
    };
  }
  return {
    idempotent: false,
    reason: `could not reconcile E409 for ${PACKAGE_NAME}@${targetVersion} after retries.`
  };
}

function logGitStatusShort() {
  // Round-10 agreement: log `git status --short` only — no destructive cleanup.
  const result = runCapture("git status --short --branch");
  if (result.status === 0) {
    const lines = result.stdout.split(/\r?\n/).filter((line) => line.length > 0);
    if (lines.length === 0) {
      logInfo("git status: working tree clean.");
    } else {
      logInfo(`git status:\n${lines.map((l) => `  ${l}`).join("\n")}`);
    }
  } else {
    logWarn(`git status failed: ${result.stderr.trim()}`);
  }
}

async function main() {
  const headSha = gitHeadSha();
  const sha7 = gitHeadShortSha();
  logInfo(`HEAD = ${headSha} (sha7 ${sha7})`);

  const watermark = getNightlySkipWatermark();
  // watermark is one of two known states (any other state would have thrown
  // out of getNightlySkipWatermark): either { exists: false } meaning no
  // @nightly tarball is published yet, or { exists: true, gitHead, version }
  // with a guaranteed non-empty string gitHead.
  if (watermark.exists && watermark.gitHead === headSha) {
    logInfo(`@nightly gitHead == HEAD (${headSha}); no new commits since last nightly. Skipping.`);
    writeGithubOutput("did_publish", "false");
    writeGithubOutput("published_version", "");
    logGitStatusShort();
    return;
  }
  if (watermark.exists) {
    logInfo(`@nightly is at version=${watermark.version ?? "?"} gitHead=${watermark.gitHead}; proceeding.`);
  } else {
    logInfo("No @nightly dist-tag yet; first nightly publish.");
  }

  const { raw: originalPackageJsonRaw } = readLocalPackageVersion();
  const { base } = getLatestBaseVersion();
  const dateStamp = utcDateStamp();
  const targetVersion = `${base}-nightly.${dateStamp}.${sha7}`;
  logInfo(`Computed version: ${targetVersion} (base from @latest -> bumpPatch).`);

  try {
    writeVersionInPackageJson(targetVersion);

    const first = attemptPublish(targetVersion);
    if (first.ok) {
      logInfo(`Published ${PACKAGE_NAME}@${targetVersion}.`);
      writeGithubOutput("did_publish", "true");
      writeGithubOutput("published_version", targetVersion);
      return;
    }
    if (!first.conflict) {
      throw new Error(`npm publish failed with status ${first.status}; see log above.`);
    }
    logWarn("npm publish returned E409 / EPUBLISHCONFLICT. Reconciling for idempotency.");
    const reconcile = await reconcileConflict(targetVersion, headSha);
    if (reconcile.idempotent) {
      writeGithubOutput("did_publish", "true");
      writeGithubOutput("published_version", targetVersion);
      return;
    }
    throw new Error(`E409 not idempotent: ${reconcile.reason}`);
  } finally {
    restorePackageJson(originalPackageJsonRaw);
    logGitStatusShort();
  }
}

main().catch((error) => {
  logError(error?.stack || error?.message || String(error));
  writeGithubOutput("did_publish", "false");
  writeGithubOutput("published_version", "");
  process.exit(1);
});
