import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkHome } from "./helpers.js";
import { windowsServiceState } from "../src/service/platform.js";
import { serviceStop, serviceUninstall } from "../src/service/index.js";

const home = mkHome("numeric-task-state");
process.env.AERIAL_CONFIG_DIR = path.join(home, "config");
process.env.AERIAL_LOG_FILE = path.join(home, "events.log");

test("Windows task state uses numeric COM values regardless of language", () => {
  for (const [state, status, loaded] of [[1, "Disabled", false], [2, "Queued", true], [3, "Ready", false], [4, "Running", true]]) {
    let script;
    const result = windowsServiceState({ run(file, args) {
      assert.equal(file, "powershell.exe");
      script = Buffer.from(args.at(-1), "base64").toString("utf16le");
      return { status: 0, stdout: JSON.stringify({ installed: true, state, localizedStatus: "正在运行" }) };
    } });
    assert.match(script, /\[int\]\$task\.State/);
    assert.equal(result.loaded, loaded);
    assert.equal(result.status, status);
  }
  assert.deepEqual(windowsServiceState({ run: () => ({ status: 0, stdout: '{"installed":false}' }) }), { installed: false, loaded: false });
});

test("ambiguous or failed Windows state queries fail without reporting success", () => {
  for (const response of [
    { status: 5, stderr: "Access denied" },
    { status: 0, stdout: "状态: 正在运行" },
    { status: 0, stdout: "Status: Running" },
    { status: 0, stdout: '{"installed":true,"state":0}' }
  ]) assert.throws(() => windowsServiceState({ run: () => response }), /Could not read Windows scheduled task state/);
});

test("localized running tasks are stopped before uninstall and unknown state blocks deletion", { skip: process.platform !== "win32" }, () => {
  const calls = [];
  const run = (file, args) => {
    calls.push({ file, args });
    if (file === "powershell.exe") {
      const script = Buffer.from(args.at(-1), "base64").toString("utf16le");
      return { status: 0, stdout: script.includes("[int]$task.State") ? '{"installed":true,"state":4,"localizedStatus":"正在运行"}' : "[]" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  assert.equal(serviceStop({ run }).ok, true);
  assert.ok(calls.some(call => call.args.includes("/End")));
  calls.length = 0;
  assert.equal(serviceUninstall({ run }).ok, true);
  assert.ok(calls.findIndex(call => call.args.includes("/End")) < calls.findIndex(call => call.args.includes("/Delete")));
  let count = 0;
  assert.throws(() => serviceUninstall({ run() { count += 1; return { status: 5, stderr: "Access denied" }; } }), /No service action/);
  assert.equal(count, 1);
});
