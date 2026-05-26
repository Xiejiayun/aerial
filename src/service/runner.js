import { spawnSync } from "node:child_process";

export function defaultRunCommand(file, args, opts = {}) {
  if (process.env.AERIAL_SERVICE_DRYRUN === "1") {
    const installed = process.env.AERIAL_SERVICE_DRYRUN_INSTALLED === "1";
    const fail = process.env.AERIAL_SERVICE_DRYRUN_FAIL || "";
    if (file === "schtasks.exe" && Array.isArray(args)) {
      if (args.includes("/Query")) {
        if (installed) {
          return { status: 0, signal: undefined, stdout: "TaskName: \\AerialLocalProxy\r\nStatus: Running", stderr: "", error: undefined, dryRun: true };
        }
        return { status: 1, signal: undefined, stdout: "", stderr: "(dryrun) task not registered", error: undefined, dryRun: true };
      }
      if (args.includes("/Delete") && fail === "delete") {
        return { status: 9, signal: undefined, stdout: "", stderr: "ERROR: Access is denied.", error: undefined, dryRun: true };
      }
    }
    if (file === "launchctl" && Array.isArray(args)) {
      if (args[0] === "list") {
        if (installed) {
          return { status: 0, signal: undefined, stdout: '{\n\t"PID" = 1234;\n\t"LastExitStatus" = 0;\n};', stderr: "", error: undefined, dryRun: true };
        }
        return { status: 1, signal: undefined, stdout: "", stderr: "(dryrun) service not loaded", error: undefined, dryRun: true };
      }
      if (args[0] === "bootout" && fail === "bootout") {
        return { status: 9216, signal: undefined, stdout: "", stderr: "Boot-out failed: 5: Input/output error", error: undefined, dryRun: true };
      }
    }
    return { status: 0, signal: undefined, stdout: "", stderr: "", error: undefined, dryRun: true };
  }
  const res = spawnSync(file, args, {
    stdio: opts.stdio || "pipe",
    encoding: "utf8",
    timeout: opts.timeout || 15000,
    env: opts.env || process.env,
    windowsHide: true
  });
  return {
    status: res.status,
    signal: res.signal,
    stdout: res.stdout || "",
    stderr: res.stderr || "",
    error: res.error
  };
}
