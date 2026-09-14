import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { renderWindowsWrapper } from "../src/service/wrapper-render.js";

const windowsOnly = { skip: process.platform !== "win32", timeout: 30_000 };

async function exerciseWrapper(t, directoryName, { viaLauncher = false, childExitCode = 23 } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aerial-windows-wrapper-"));
  const fixtureDir = path.join(temp, directoryName);
  const configDir = path.join(fixtureDir, "config");
  const logsDir = path.join(fixtureDir, "logs");
  const cliPath = path.join(fixtureDir, "fixture.cjs");
  const wrapperPath = path.join(fixtureDir, "service.ps1");
  const readyPath = path.join(fixtureDir, "ready.json");
  const releasePath = path.join(fixtureDir, "release");
  const donePath = path.join(fixtureDir, "done");
  const stdioLog = path.join(logsDir, "stdio.log");
  const aerialLog = path.join(logsDir, "aerial.log");
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
  fs.writeFileSync(stdioLog, "previous-run\n");
  fs.writeFileSync(cliPath, `
const fs = require("node:fs");
const path = require("node:path");
fs.writeFileSync(path.join(__dirname, "ready.json"), JSON.stringify({
  pid: process.pid,
  args: process.argv.slice(2),
  configDir: process.env.AERIAL_CONFIG_DIR,
  logFile: process.env.AERIAL_LOG_FILE,
  maxBytes: process.env.AERIAL_LOG_MAX_BYTES,
  backups: process.env.AERIAL_LOG_BACKUPS
}));
const deadline = setTimeout(() => process.exit(99), 20000);
const waitForRelease = setInterval(async () => {
  if (!fs.existsSync(path.join(__dirname, "release"))) return;
  clearInterval(waitForRelease);
  const output = (stream, label) => new Promise((resolve, reject) => {
    const lines = Array.from({ length: 192 }, (_, i) => label + "-" + i + ":" + "x".repeat(1024) + "\\n").join("");
    stream.write(lines, (error) => error ? reject(error) : resolve());
  });
  await Promise.all([output(process.stdout, "stdout"), output(process.stderr, "stderr")]);
  fs.writeFileSync(path.join(__dirname, "done"), "flushed");
  clearTimeout(deadline);
  process.exitCode = ${childExitCode};
}, 25);
`);
  fs.writeFileSync(wrapperPath, renderWindowsWrapper({
    nodePath: process.execPath,
    cliPath,
    host: "127.0.0.1",
    port: 18181,
    stdioLog,
    aerialLog,
    configDir,
    maxBytes: 4 * 1024 * 1024,
    backups: 5
  }));
  const powershellArgs = [
    "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden",
    "-ExecutionPolicy", "Bypass", "-File", wrapperPath
  ];
  const launcherPath = fileURLToPath(new URL("../src/service/windows-launcher.js", import.meta.url));
  const wrapper = spawn(viaLauncher ? "wscript.exe" : "powershell.exe", viaLauncher
    ? ["//B", "//NoLogo", "//E:JScript", launcherPath, wrapperPath]
    : powershellArgs, {
    windowsHide: true,
    env: { ...process.env, AERIAL_CONFIG_DIR: configDir, AERIAL_LOG_DIR: logsDir }
  });
  let output = "";
  wrapper.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
  wrapper.stderr.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
  const closed = new Promise((resolve, reject) => {
    wrapper.once("error", reject);
    wrapper.once("close", (code) => resolve(code));
  });
  let childPid;
  t.after(async () => {
    if (childPid && !fs.existsSync(donePath)) {
      try { process.kill(childPid); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    if (wrapper.exitCode === null) wrapper.kill();
    await closed;
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(readyPath) && wrapper.exitCode === null && Date.now() < deadline) {
    await delay(25);
  }
  assert.ok(fs.existsSync(readyPath), `fixture did not start: ${output}`);
  const ready = JSON.parse(fs.readFileSync(readyPath, "utf8"));
  childPid = ready.pid;
  assert.deepEqual(ready.args, ["start", "--host", "127.0.0.1", "--port", "18181"]);
  assert.equal(ready.configDir, configDir);
  assert.equal(ready.logFile, aerialLog);
  assert.equal(ready.maxBytes, "4194304");
  assert.equal(ready.backups, "5");
  await delay(200);
  assert.equal(wrapper.exitCode, null, "wrapper must remain alive while its child is running");
  assert.equal(fs.existsSync(donePath), false);
  fs.writeFileSync(releasePath, "continue");
  const exitCode = await closed;
  const bytes = fs.readFileSync(stdioLog);
  // Legacy Windows PowerShell may append UTF-16 text to an existing UTF-8 log.
  const log = bytes.toString("utf8").replace(/\0/g, "");
  assert.equal(exitCode, childExitCode, `wrapper must preserve the child's exit code: ${output.slice(0, 2000)}`);
  assert.equal(fs.readFileSync(donePath, "utf8"), "flushed");
  assert.ok(log.startsWith("previous-run\n"), "wrapper must append to the existing log");
  for (const label of ["stdout", "stderr"]) {
    // Windows PowerShell can repeat the first stderr line in its error metadata.
    const lines = new Set(log.match(new RegExp(`${label}-\\d+:`, "g")) || []);
    assert.equal(lines.size, 192);
    assert.ok(log.replace(/\s/g, "").includes(`${label}-191:${"x".repeat(1024)}`), `${label} must drain beyond the pipe buffer`);
  }
}

test("Windows wrapper waits, appends both output streams beyond pipe buffers, and preserves the child exit code", windowsOnly, async (t) => {
  await exerciseWrapper(t, "O'Hara service");
});

test("Windows launcher waits, preserves a failure exit code, and passes Unicode paths and environment", windowsOnly, async (t) => {
  await exerciseWrapper(t, "O'Hara 中文 service", { viaLauncher: true });
});

test("Windows launcher returns success after the child finishes despite stderr output", windowsOnly, async (t) => {
  await exerciseWrapper(t, "successful service", { viaLauncher: true, childExitCode: 0 });
});
