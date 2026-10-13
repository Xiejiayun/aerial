import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { renderWindowsWrapper } from "../src/service/wrapper-render.js";

const windowsOnly = { skip: process.platform !== "win32", timeout: 30_000 };
const psQuote = (value) => `'${value.replaceAll("'", "''")}'`;

function fixture(t, { failures = 1, alwaysFail = false, sleepMilliseconds = 0, maxBytes } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aerial-recovery-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fixtureDir = path.join(dir, "proxy O'Hara 测试");
  fs.mkdirSync(fixtureDir);
  const attempts = path.join(fixtureDir, "attempts.txt");
  const sleeps = path.join(fixtureDir, "sleeps.txt");
  const stdioLog = path.join(fixtureDir, "stdio.log");
  const cliPath = path.join(fixtureDir, "fixture.cjs");
  fs.writeFileSync(cliPath, `
    const fs = require("node:fs");
    const file = ${JSON.stringify(attempts)};
    const count = fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8")) + 1 : 1;
    fs.writeFileSync(file, String(count));
    require("node:assert/strict").deepEqual(process.argv.slice(2), ["start", "--host", "127.0.0.1", "--port", "18181"]);
    console.log("fixture stdout " + count);
    console.error("fixture stderr " + count);
    process.exit(count <= ${failures} ? 7 : 0);
  `);
  let nodePath = process.execPath;
  let childCommand = "";
  if (alwaysFail) {
    // Isolate the repeated child command to avoid launching a thousand native
    // processes. The other cases exercise real native Node exit propagation.
    nodePath = "Invoke-AerialFailureFixture";
    childCommand = `function Invoke-AerialFailureFixture {
      $global:aerialFixtureAttempts += 1
      [IO.File]::WriteAllText(${psQuote(attempts)}, [string]$global:aerialFixtureAttempts)
      $global:LASTEXITCODE = 9
    }\r\n`;
  }
  const wrapper = renderWindowsWrapper({
    nodePath, cliPath, host: "127.0.0.1", port: 18181,
    stdioLog, aerialLog: path.join(fixtureDir, "aerial.log"), configDir: fixtureDir, maxBytes
  });
  // Only replace waiting in the fixture. The rendered retry policy and child
  // invocation run unchanged, and the helper rejects an incorrect interval.
  const sleep = `function Start-Sleep {
    param([int]$Seconds)
    if ($Seconds -ne 60) { throw 'Unexpected retry interval' }
    [IO.File]::AppendAllText(${psQuote(sleeps)}, [string]$Seconds + [Environment]::NewLine)
    ${sleepMilliseconds ? `Microsoft.PowerShell.Utility\\Start-Sleep -Milliseconds ${sleepMilliseconds}` : ""}
  }\r\n`;
  const wrapperPath = path.join(fixtureDir, "wrapper.ps1");
  fs.writeFileSync(wrapperPath, `\uFEFF${childCommand}${sleep}${wrapper.slice(1)}`);
  const args = ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", wrapperPath];
  return { attempts, sleeps, stdioLog, args };
}

function runFixture(f) {
  const result = spawnSync("powershell.exe", f.args, { encoding: "utf8", timeout: 25_000, windowsHide: true });
  assert.ifError(result.error);
  return result;
}

function readLog(file) {
  const data = fs.readFileSync(file);
  return data[0] === 0xff && data[1] === 0xfe ? data.toString("utf16le") : data.toString("utf8");
}

test("Windows wrapper retries a failed native process and preserves captured output", windowsOnly, (t) => {
  const f = fixture(t);
  const result = runFixture(f);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(f.attempts, "utf8"), "2");
  assert.deepEqual(fs.readFileSync(f.sleeps, "utf8").trim().split(/\r?\n/), ["60"]);
  const log = readLog(f.stdioLog);
  assert.match(log, /fixture stdout 1/);
  assert.match(log, /fixture stderr 1/);
  assert.match(log, /process exited 7; retry 1\/999 in 60 seconds/);
  assert.match(log, /fixture stdout 2/);
  assert.match(log, /fixture stderr 2/);
});

test("Windows wrapper does not retry a clean native exit even when stderr was written", windowsOnly, (t) => {
  const f = fixture(t, { failures: 0 });
  const result = runFixture(f);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(f.attempts, "utf8"), "1");
  assert.equal(fs.existsSync(f.sleeps), false);
  assert.match(readLog(f.stdioLog), /fixture stderr 1/);
});

test("Windows wrapper rotates captured logs before a recovery attempt", windowsOnly, (t) => {
  const f = fixture(t, { maxBytes: 1 });
  const result = runFixture(f);
  assert.equal(result.status, 0, result.stderr);
  const previous = readLog(`${f.stdioLog}.1`);
  assert.match(previous, /fixture stdout 1/);
  assert.match(previous, /process exited 7; retry 1\/999/);
  assert.match(readLog(f.stdioLog), /fixture stdout 2/);
  assert.doesNotMatch(readLog(f.stdioLog), /fixture stdout 1/);
});

test("Windows wrapper stops after 999 retries and returns the final failure", windowsOnly, (t) => {
  const f = fixture(t, { alwaysFail: true });
  const result = runFixture(f);
  assert.equal(result.status, 9, result.stderr);
  assert.equal(fs.readFileSync(f.attempts, "utf8"), "1000");
  const waits = fs.readFileSync(f.sleeps, "utf8").trim().split(/\r?\n/);
  assert.equal(waits.length, 999);
  assert.ok(waits.every((value) => value === "60"));
});

test("terminating the Windows wrapper during its retry wait prevents another process", windowsOnly, async (t) => {
  let child;
  let closed;
  t.after(async () => {
    if (child?.exitCode === null && child.signalCode === null) child.kill();
    if (closed) await closed;
  });
  const f = fixture(t, { sleepMilliseconds: 1500 });
  child = spawn("powershell.exe", f.args, { stdio: "ignore", windowsHide: true });
  closed = once(child, "close");
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(f.sleeps) && Date.now() < deadline && child.exitCode === null) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(fs.existsSync(f.sleeps), true, "wrapper must reach the retry wait");
  assert.equal(fs.readFileSync(f.attempts, "utf8"), "1");
  assert.equal(child.kill(), true);
  await closed;
  await new Promise((resolve) => setTimeout(resolve, 1700));
  assert.equal(fs.readFileSync(f.attempts, "utf8"), "1");
});
