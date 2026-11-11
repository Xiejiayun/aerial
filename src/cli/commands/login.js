import { gitHubTokenSource, pollDeviceFlow, startDeviceFlow } from "../../shared/auth.js";
import { requiredArgValue } from "../helpers.js";

export async function runLoginCli(args, {
  github = { gitHubTokenSource, pollDeviceFlow, startDeviceFlow }, cowork,
  env = process.env, print = console.log, warn = console.error
} = {}) {
  const provider = requiredArgValue(args, "--provider") ?? "github";
  if (provider !== "github" && provider !== "cowork") throw new Error("Unknown login provider. Use --provider github or --provider cowork.");
  if (provider === "cowork") {
    const run = cowork || (await import("./cowork.js")).runCoworkCli;
    // Cowork auth already means an interactive sign-in, including with --force.
    // Its existing profile validation and Windows sign-in flow remain in charge.
    return run("auth", ["--interactive"], { print, warn });
  }
  const force = args.includes("--force");
  const source = github.gitHubTokenSource();
  if (force && source === "env") {
    warn("AERIAL_GITHUB_TOKEN is set; unset it before running `aerial login --force`, otherwise the env value will continue to shadow any new file token.");
    return 1;
  }
  if (!force && source === "env") {
    print("GitHub login is provided by AERIAL_GITHUB_TOKEN (not verified). To use a different account, unset it or run with a different environment.");
    return 0;
  }
  if (!force && source === "file") {
    print("GitHub login already exists (not verified). To sign in again, run aerial login --force.");
    return 0;
  }
  if (env.AERIAL_TEST_LOGIN_NO_NETWORK === "1") {
    print("AERIAL_TEST_LOGIN_NO_NETWORK=1 set; skipping GitHub device flow (test mode).");
    return 0;
  }
  const flow = await github.startDeviceFlow();
  print(`Open: ${flow.verification_uri}`);
  print(`Code: ${flow.user_code}`);
  print("Waiting for GitHub authorization...");
  await github.pollDeviceFlow(flow.device_code, flow.interval);
  print("GitHub login saved.");
  return 0;
}
