import { gitHubTokenSource, pollDeviceFlow, startDeviceFlow } from "../../shared/auth.js";

export async function runLoginCli(args) {
  const force = args.includes("--force");
  const source = gitHubTokenSource();
  if (force && source === "env") {
    console.error("AERIAL_GITHUB_TOKEN is set; unset it before running `aerial login --force`, otherwise the env value will continue to shadow any new file token.");
    process.exit(1);
  }
  if (!force && source === "env") {
    console.log("GitHub login is provided by AERIAL_GITHUB_TOKEN (not verified). To use a different account, unset it or run with a different environment.");
    return;
  }
  if (!force && source === "file") {
    console.log("GitHub login already exists (not verified). To sign in again, run aerial login --force.");
    return;
  }
  if (process.env.AERIAL_TEST_LOGIN_NO_NETWORK === "1") {
    console.log("AERIAL_TEST_LOGIN_NO_NETWORK=1 set; skipping GitHub device flow (test mode).");
    return;
  }
  const flow = await startDeviceFlow();
  console.log(`Open: ${flow.verification_uri}`);
  console.log(`Code: ${flow.user_code}`);
  console.log("Waiting for GitHub authorization...");
  await pollDeviceFlow(flow.device_code, flow.interval);
  console.log("GitHub login saved.");
}
