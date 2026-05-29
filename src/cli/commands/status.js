import { setupStatus } from "../../setup/index.js";
import { serviceStatus } from "../../service/index.js";
import { computeAppStatus } from "../app-status.js";
import { printServiceSummary, printSetupSummary } from "../output.js";

export async function appStatus({ json = false } = {}) {
  const setup = setupStatus();
  const service = await serviceStatus();
  const status = computeAppStatus(setup, service);
  if (json) {
    console.log(JSON.stringify(status, null, 2));
    return status;
  }
  console.log("Aerial status");
  printSetupSummary(setup);
  printServiceSummary(service);
  if (status.nextSteps.length) {
    console.log("next:");
    for (const step of status.nextSteps) console.log(`  - ${step}`);
  }
  if (status.hints.length) {
    console.log("hints:");
    for (const hint of status.hints) console.log(`  - ${hint}`);
  }
  return status;
}
