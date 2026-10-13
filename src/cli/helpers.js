import fs from "node:fs";
import { serviceGuidance } from "../service/guidance.js";
export { codexAuthCommand, claudeApiKeyHelper } from "../setup/auth-helper.js";

const PACKAGE_JSON_URL = new URL("../../package.json", import.meta.url);

export function readPackageVersion(packageJsonUrl = PACKAGE_JSON_URL) {
  try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonUrl, "utf8"));
    if (typeof pkg.version === "string" && pkg.version.length > 0) return pkg.version;
    throw new Error("missing version field");
  } catch (error) {
    const reason = error?.message || String(error);
    console.warn(`aerial: cannot read package version (${reason}); reporting "unknown"`);
    return "unknown";
  }
}

export function printVersion(packageJsonUrl = PACKAGE_JSON_URL) {
  console.log(readPackageVersion(packageJsonUrl));
}

export function argValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export function requiredArgValue(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

export function parseConfigPort(value) {
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) throw new Error("port must be an integer between 1 and 65535");
  const port = Number(text);
  if (port < 1 || port > 65535) throw new Error("port must be an integer between 1 and 65535");
  return port;
}

export function parseConfigHost(value) {
  const host = String(value).trim().toLowerCase();
  if (host === "127.0.0.1" || host === "localhost" || host === "::1") return host;
  throw new Error("host must be a loopback address: 127.0.0.1, localhost, or ::1");
}

export function computeAppStatus(setup, service) {
  const githubTokenPresent = setup.auth.github_token.source !== "missing";
  const apiKeyPresent = setup.auth.api_key.exists;
  const hasAerialClient = setup.clients.codex.state === "aerial" || setup.clients.claude.state === "aerial";
  const serviceHealthy = service.health?.aerial === true && service.service?.reason !== "status_query_failed";
  const conflicts = Object.values(setup.clients).filter(client => client.state.startsWith("aerial") && client.conflicts?.length);
  const ok = apiKeyPresent && githubTokenPresent && hasAerialClient && serviceHealthy && !conflicts.length;
  const { nextSteps, hints } = serviceGuidance(service);
  const setupCommands = preferredClientTargets(setup).map(target => `aerial setup ${target}`).join(" or ");
  if (!githubTokenPresent) nextSteps.push("run: aerial login");
  if (!hasAerialClient) nextSteps.push(`run: ${setupCommands}`);
  if (hasAerialClient && !apiKeyPresent) nextSteps.push(`run: ${setupCommands} to recreate the local Aerial key`);
  for (const client of conflicts) nextSteps.push(`${client.target}: ${client.migration} (${client.conflicts.map(item => `${item.source}.${item.key}`).join(", ")})`);
  if (setup.auth.github_token.source === "env") {
    hints.push("AERIAL_GITHUB_TOKEN is set for this process only; run aerial login without that env var to persist a service-readable login.");
  }
  return { schema: "aerial.status.v1", ok, setup, service, nextSteps, hints };
}

export function preferredClientTargets(setup) {
  const entries = Object.entries(setup.clients);
  const managed = entries.filter(([, client]) => client.state.startsWith("aerial"));
  const present = entries.filter(([, client]) => client.state !== "missing");
  return (managed.length ? managed : present.length ? present : entries).map(([target]) => target);
}
