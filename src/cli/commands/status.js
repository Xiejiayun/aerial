import { setupStatus } from "../../setup/index.js";
import { serviceStatus } from "../../service/index.js";
import { computeAppStatus } from "../helpers.js";
import { printServiceSummary, printSetupSummary } from "../output.js";

export async function appStatus({ json = false, gateway = false } = {}) {
  const setup = setupStatus();
  const service = await serviceStatus();
  const status = computeAppStatus(setup, service, { gateway });
  if (json) {
    console.log(JSON.stringify(status, null, 2));
    return status;
  }
  console.log("Aerial status");
  console.log(`Local gateway: ${status.gatewayReady ? "ready" : "not ready"}; coding client: ${status.clientReady ? "ready" : "not ready"}.`);
  if (!gateway && !status.clientReady) console.log("Image/API clients do not need coding client setup. Use aerial status --gateway for a gateway-only check.");
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
