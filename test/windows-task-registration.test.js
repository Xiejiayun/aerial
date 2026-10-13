import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildWindowsTaskRegistrationScript } from "../src/service/wrapper-render.js";

test("PowerShell preserves long Unicode task arguments and uses the interactive limited principal", { skip: process.platform !== "win32" }, () => {
  const taskName = "Aerial O'Hara 测试";
  const wrapperPath = `C:\\Users\\O'Hara 测试\\${"long directory\\".repeat(20)}aerial-service.ps1`;
  const launcher = fileURLToPath(new URL("../src/service/windows-launcher.js", import.meta.url));
  // Parse and execute the generated script with argument-capturing cmdlets.
  // This validates PowerShell quoting without registering any real task.
  const source = [
    "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding",
    "function New-ScheduledTaskAction { param($Execute, $Argument) @{ execute = $Execute; argument = $Argument } }",
    "function New-ScheduledTaskTrigger { param([switch]$AtLogOn, $User) @{ atLogOn = [bool]$AtLogOn; user = $User } }",
    "function New-ScheduledTaskPrincipal { param($UserId, $LogonType, $RunLevel) @{ userId = $UserId; logonType = $LogonType; runLevel = $RunLevel } }",
    "function Register-ScheduledTask { param($TaskName, $TaskPath, $Action, $Trigger, $Principal, [switch]$Force) $script:captured = @{ name = $TaskName; path = $TaskPath; action = $Action; trigger = $Trigger; principal = $Principal; force = [bool]$Force } }",
    buildWindowsTaskRegistrationScript({ taskName, wrapperPath }),
    "$captured | ConvertTo-Json -Depth 5 -Compress"
  ].join("\r\n");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(source, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true, timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  const task = JSON.parse(result.stdout);
  assert.equal(task.name, taskName);
  assert.equal(task.path, "\\");
  assert.equal(task.action.execute, "wscript.exe");
  assert.equal(task.action.argument, `//B //NoLogo //E:JScript "${launcher}" "${wrapperPath}"`);
  assert.ok(task.action.argument.length > 261);
  assert.equal(task.trigger.atLogOn, true);
  assert.ok(task.trigger.user);
  assert.equal(task.trigger.user, task.principal.userId);
  assert.equal(task.principal.logonType, "Interactive");
  assert.equal(task.principal.runLevel, "Limited");
  assert.equal(task.force, true);
});
