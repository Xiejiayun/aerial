#!/usr/bin/env node
// Validate that `npm pack --dry-run` produces a tarball containing only the
// MVP allowlist (LICENSE, README, docs/usage, package.json, src/**/*.js).
//
// Three layers of checks:
//   1. REQUIRED — canary files that must always be present.
//   2. FORBIDDEN — known-bad categories with descriptive errors.
//   3. ALLOWLIST — strict catch-all: any path not on this list fails as
//      "UNEXPECTED file in pack". This is what guarantees that future
//      additions like docs/release-runbook.md or scripts/verify-secrets.mjs
//      cannot silently leak into the published tarball if package.json's
//      `files` field is ever broadened by mistake.
//
// Failures exit non-zero so this script can be wired into CI as the release
// gate.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Canary files that must always be in the published tarball. Not the full
// pack — we want this check to stay green when src/*.js evolves, while still
// catching accidental removals of the headline files.
const REQUIRED_FILES = [
  "LICENSE",
  "README.md",
  "docs/usage.md",
  "package.json",
  "src/cli/index.js",
  "src/cli/version.js"
];

// Strict allowlist: every file in the npm pack must match one of these
// predicates. Anything else is rejected as "UNEXPECTED".
const ALLOWLIST_RULES = [
  { name: "LICENSE", test: (p) => p === "LICENSE" },
  { name: "README.md", test: (p) => p === "README.md" },
  { name: "package.json", test: (p) => p === "package.json" },
  { name: "docs/usage.md", test: (p) => p === "docs/usage.md" },
  // src/**/*.js — allow future src/ subdirectories of .js modules.
  { name: "src/**/*.js", test: (p) => p.startsWith("src/") && p.endsWith(".js") }
];

function isAllowed(file) {
  return ALLOWLIST_RULES.some((rule) => rule.test(file));
}

const FORBIDDEN_PATTERNS = [
  { name: "live-aerial config", test: (p) => p.startsWith(".live-aerial/") },
  { name: "build tarball", test: (p) => p.endsWith(".tgz") },
  { name: "test fixtures", test: (p) => p === "test" || p.startsWith("test/") },
  { name: "helper scripts", test: (p) => p === "scripts" || p.startsWith("scripts/") },
  { name: "internal design doc", test: (p) => p === "docs/development-design.md" },
  { name: "node_modules", test: (p) => p === "node_modules" || p.startsWith("node_modules/") },
  { name: "lockfile", test: (p) => p === "package-lock.json" },
  { name: "dotenv", test: (p) => /(^|\/)\.env(\.[^/]+)?$/.test(p) },
  { name: "github workflows", test: (p) => p === ".github" || p.startsWith(".github/") }
];

function runNpmPack() {
  // Pass the full command as a single string with shell:true to avoid
  // Node 22's DEP0190 (args alongside shell:true is deprecated). The shell
  // (sh on POSIX, cmd.exe on Windows) resolves `npm` / `npm.cmd` from PATH.
  const result = spawnSync("npm pack --dry-run --json", {
    cwd: repoRoot,
    encoding: "utf8",
    shell: true
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || "");
    throw new Error(`npm pack --dry-run failed with status ${result.status}`);
  }
  return JSON.parse(result.stdout);
}

const tarballs = runNpmPack();
if (!Array.isArray(tarballs) || tarballs.length !== 1) {
  console.error(`verify-package: expected 1 tarball from npm pack, got ${tarballs?.length}`);
  process.exit(1);
}

const tarball = tarballs[0];
const files = (tarball.files || []).map((entry) => entry.path.replace(/\\/g, "/"));

let issues = 0;
for (const required of REQUIRED_FILES) {
  if (!files.includes(required)) {
    console.error(`MISSING required file: ${required}`);
    issues += 1;
  } else {
    console.log(`ok    required file present: ${required}`);
  }
}

for (const file of files) {
  // Specific category first so the error message is descriptive.
  const forbidden = FORBIDDEN_PATTERNS.find((rule) => rule.test(file));
  if (forbidden) {
    console.error(`FORBIDDEN file in pack: ${file} (rule: ${forbidden.name})`);
    issues += 1;
    continue;
  }
  // Strict allowlist catch-all: unknown files fail even if no forbidden
  // pattern matched. Keeps the npm tarball minimal forever.
  if (!isAllowed(file)) {
    console.error(`UNEXPECTED file in pack: ${file} (not on allowlist)`);
    issues += 1;
  }
}

console.log(`verify-package: pack contains ${files.length} file(s), size ${tarball.size ?? "?"} bytes, unpacked ${tarball.unpackedSize ?? "?"} bytes.`);

if (issues > 0) {
  console.error(`verify-package failed: ${issues} issue(s).`);
  process.exit(1);
}

console.log("verify-package: pack contents OK.");
