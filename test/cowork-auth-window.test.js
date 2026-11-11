import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { openAuthWindow } from "../src/cowork/auth-window.js";

function fakeHost({ handle = "123456", emitHandle = true, endCloses = true } = {}) {
  const child = new EventEmitter();
  child.pid = 123;
  child.stdout = new EventEmitter();
  child.stdin = new EventEmitter();
  let killed = 0;
  let ended = 0;
  child.stdin.end = (value) => {
    ended++;
    assert.equal(value, "close\n");
    if (endCloses) queueMicrotask(() => child.emit("close", 0));
  };
  child.kill = () => { killed++; queueMicrotask(() => child.emit("close", 1)); return true; };
  return {
    child, get killed() { return killed; }, get ended() { return ended; },
    spawnProcess(command, args, options) {
      assert.equal(command, "powershell.exe");
      assert.ok(args.includes("-STA"));
      assert.ok(args.includes("-NonInteractive"));
      assert.equal(options.windowsHide, true);
      assert.deepEqual(options.stdio, ["pipe", "pipe", "ignore"]);
      assert.match(args.at(-1), /Task.Run\(\(\) => Console.ReadLine\(\)\)/);
      assert.match(args.at(-1), /ShowOwner\(\$form.Handle\)/);
      assert.match(args.at(-1), /return IsWindowVisible\(handle\)/);
      assert.match(args.at(-1), /Application\]::Run/);
      if (emitHandle) queueMicrotask(() => child.stdout.emit("data", Buffer.from(`${handle}\r\n`)));
      return child;
    }
  };
}

test("interactive owner returns a pointer-sized HWND and closes through its lifetime pipe", async () => {
  const host = fakeHost();
  const window = await openAuthWindow({ spawnProcess: host.spawnProcess, platform: "win32", arch: "x64" });
  assert.equal(window.handle.length, 8);
  assert.equal(window.handle.readBigUInt64LE(), 123456n);
  const closing = window.close();
  assert.equal(window.close(), closing);
  await closing;
  assert.deepEqual(await window.closed, { reason: "parent", exitCode: 0 });
  assert.equal(host.ended, 1);
  assert.equal(host.killed, 0);
});

test("user closing the owner is distinguishable from requested cleanup", async () => {
  const host = fakeHost();
  const window = await openAuthWindow({ spawnProcess: host.spawnProcess, platform: "win32", arch: "ia32" });
  assert.equal(window.handle.length, 4);
  host.child.emit("close", 20);
  assert.deepEqual(await window.closed, { reason: "user", exitCode: 20 });
  await window.close();
  assert.equal(host.ended, 0);
});

test("zero, overflowing and unexpected window output is rejected and the owned process is stopped", async () => {
  for (const handle of ["0", "-1", "4294967296", "secret output", "123\n456", "1".repeat(200)]) {
    const host = fakeHost({ handle });
    await assert.rejects(openAuthWindow({ spawnProcess: host.spawnProcess, platform: "win32", arch: "ia32" }), { code: "AUTH_WINDOW_FAILED" });
    assert.equal(host.ended, 1);
  }
});

test("owner startup has a deadline and kills its process if graceful shutdown stalls", async () => {
  const host = fakeHost({ emitHandle: false, endCloses: false });
  await assert.rejects(openAuthWindow({ spawnProcess: host.spawnProcess, platform: "win32", arch: "x64", startupTimeoutMs: 5, closeTimeoutMs: 5 }), { code: "AUTH_WINDOW_FAILED" });
  assert.equal(host.killed, 1);
});

test("abort after opening closes the owner and reports an aborted lifetime", async () => {
  const host = fakeHost();
  const controller = new AbortController();
  const window = await openAuthWindow({ spawnProcess: host.spawnProcess, platform: "win32", arch: "arm64", signal: controller.signal });
  controller.abort();
  assert.deepEqual(await window.closed, { reason: "aborted", exitCode: 0 });
  await window.close();
});

test("an already canceled request does not start a window", async () => {
  const controller = new AbortController();
  controller.abort();
  let spawns = 0;
  await assert.rejects(openAuthWindow({ signal: controller.signal, platform: "win32", spawnProcess: () => { spawns++; } }), { name: "AbortError" });
  assert.equal(spawns, 0);
});
