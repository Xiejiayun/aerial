#!/usr/bin/env node
// Syntax-only sanity check for source and helper scripts.
// Recursively walks src/ and scripts/ and runs `node --check` on every
// .js / .mjs / .cjs file. Used as the first step in CI so a typo fails
// fast before the full test suite spends time on cold-start work.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SOURCE_DIRS = ["src", "scripts"];
const SOURCE_SUFFIXES = [".js", ".mjs", ".cjs"];

function walk(relDir) {
  const absolute = path.join(repoRoot, relDir);
  if (!fs.existsSync(absolute)) return [];
  const collected = [];
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    const relPath = path.join(relDir, entry.name);
    if (entry.isDirectory()) {
      collected.push(...walk(relPath));
      continue;
    }
    if (entry.isFile() && SOURCE_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) {
      collected.push(relPath);
    }
  }
  return collected;
}

const files = SOURCE_DIRS.flatMap(walk);
if (files.length === 0) {
  console.error("check-syntax: no source files found.");
  process.exit(1);
}

let failed = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", path.join(repoRoot, file)], {
    encoding: "utf8"
  });
  // Normalize separators for stable output across Windows/POSIX.
  const displayPath = file.replace(/\\/g, "/");
  if (result.status === 0) {
    console.log(`ok    ${displayPath}`);
  } else {
    console.error(`fail  ${displayPath}`);
    if (result.stderr) process.stderr.write(result.stderr);
    failed += 1;
  }
}

if (failed > 0) {
  console.error(`check-syntax: ${failed} file(s) failed.`);
  process.exit(1);
}
console.log(`check-syntax: ${files.length} file(s) passed.`);
