#!/usr/bin/env node
// Scan every git-tracked file AND every file in `npm pack` for strings that
// look like real secrets. README and docs are intentionally in scope: users
// most often paste real tokens into example snippets by accident.
//
// Patterns target the prefixed token formats that are unambiguous in
// isolation (GitHub PATs, npm tokens, OpenAI/Anthropic keys, AWS access
// keys, OpenSSH private key blocks). `aerial_*` is the local API key prefix
// emitted by `aerial key generate`; only the long, base64-shaped form fails
// the scan so short `aerial_test_key` literals in tests stay clean.
//
// ALLOWLIST holds documented public identifiers like the OAuth Device Flow
// client ID that are safe to ship.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SECRET_PATTERNS = [
  { name: "GitHub PAT (classic)", re: /\bghp_[A-Za-z0-9]{36}\b/g },
  { name: "GitHub fine-grained PAT", re: /\bgithub_pat_[A-Za-z0-9_]{82}\b/g },
  { name: "GitHub OAuth access token", re: /\bgho_[A-Za-z0-9]{36}\b/g },
  { name: "GitHub user-to-server token", re: /\bghu_[A-Za-z0-9]{36}\b/g },
  { name: "GitHub server-to-server token", re: /\bghs_[A-Za-z0-9]{36}\b/g },
  { name: "GitHub refresh token", re: /\bghr_[A-Za-z0-9]{36}\b/g },
  { name: "npm auth token", re: /\bnpm_[A-Za-z0-9]{36,}\b/g },
  { name: "OpenAI project key", re: /\bsk-proj-[A-Za-z0-9_-]{20,}\b/g },
  { name: "Anthropic API key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { name: "OpenAI legacy key", re: /\bsk-[A-Za-z0-9]{32,}\b/g },
  { name: "Aerial API key", re: /\baerial_[A-Za-z0-9_-]{32,}\b/g },
  { name: "AWS access key id", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "Private key block", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g }
];

const ALLOWLIST = [
  // GitHub Copilot OAuth Device Flow public client ID. Documented as public
  // and required for the device-flow login the user runs.
  /Iv1\.b507a08c87ecfe98/
];

// Binary or large-blob extensions we never scan; everything else is treated
// as text. Files with no extension (e.g. LICENSE) are scanned as text.
const BINARY_EXT_RE = /\.(png|jpg|jpeg|gif|ico|webp|woff2?|ttf|eot|tgz|zip|gz|bz2|xz|pdf|exe|dll|node|so|dylib|class|wasm)$/i;
const MAX_BYTES = 2 * 1024 * 1024; // skip files >2MB; secrets are short

function listTrackedFiles() {
  const result = spawnSync("git", ["ls-files"], { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ls-files failed: ${result.stderr}`);
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !line.startsWith("node_modules/"))
    .filter((line) => !line.startsWith(".git/"));
}

function listPackFiles() {
  // Single command string + shell:true avoids Node 22 DEP0190 (passing args
  // alongside shell:true is deprecated). The shell (sh on POSIX, cmd.exe on
  // Windows) resolves `npm` / `npm.cmd` from PATH.
  const result = spawnSync("npm pack --dry-run --json", {
    cwd: repoRoot,
    encoding: "utf8",
    shell: true
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || "");
    throw new Error(`npm pack failed: status ${result.status}`);
  }
  const tarballs = JSON.parse(result.stdout);
  return (tarballs[0]?.files || []).map((entry) => entry.path.replace(/\\/g, "/"));
}

function readTextSafe(relPath) {
  const absolute = path.join(repoRoot, relPath);
  let stat;
  try {
    stat = fs.statSync(absolute);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  if (stat.size > MAX_BYTES) return null;
  try {
    return fs.readFileSync(absolute, "utf8");
  } catch {
    return null;
  }
}

function scan(label, files) {
  const findings = [];
  for (const relPath of files) {
    if (BINARY_EXT_RE.test(relPath)) continue;
    const content = readTextSafe(relPath);
    if (content === null) continue;
    for (const { name, re } of SECRET_PATTERNS) {
      // Reset stateful regex between files.
      re.lastIndex = 0;
      for (const match of content.matchAll(re)) {
        const text = match[0];
        if (ALLOWLIST.some((allow) => allow.test(text))) continue;
        findings.push({
          scope: label,
          file: relPath,
          pattern: name,
          snippet: text.length > 40 ? `${text.slice(0, 40)}...` : text
        });
      }
    }
  }
  return findings;
}

const tracked = listTrackedFiles();
const pack = listPackFiles();

const findings = [...scan("tracked", tracked), ...scan("pack", pack)];

if (findings.length > 0) {
  for (const finding of findings) {
    console.error(`SECRET ${finding.scope} ${finding.file}: ${finding.pattern} -> ${finding.snippet}`);
  }
  console.error(`verify-secrets failed: ${findings.length} finding(s) across ${tracked.length} tracked + ${pack.length} pack file(s).`);
  process.exit(1);
}

console.log(`verify-secrets OK: scanned ${tracked.length} tracked + ${pack.length} pack file(s); no matches against ${SECRET_PATTERNS.length} patterns.`);
