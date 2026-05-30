import { restoreAllClients } from "../../setup/index.js";
import { serviceUninstall } from "../../service/index.js";
import { printRestoreResults } from "../output.js";
import { printServiceUninstallResult } from "./service.js";

export function runTeardownCli() {
  const { ok: restoreOk, results } = restoreAllClients();
  printRestoreResults(results);
  if (!restoreOk) {
    console.log("service uninstall: skipped because client restore reported failures; resolve restore errors then rerun `aerial teardown` or `aerial service uninstall`.");
    process.exitCode = 1;
    return;
  }
  try {
    const r = serviceUninstall();
    printServiceUninstallResult(r, { prefix: "service uninstall" });
    process.exitCode = r.ok ? 0 : 1;
  } catch (err) {
    if (/unsupported platform/.test(err.message)) {
      console.log(`service uninstall: skipped (${err.message})`);
      process.exitCode = 0;
    } else {
      console.log(`service uninstall: FAILED (${err.message})`);
      console.log(`  Retry with: aerial service uninstall`);
      process.exitCode = 1;
    }
  }
}
