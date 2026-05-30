import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_JSON_URL = new URL("../../package.json", import.meta.url);
const CLI_ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.js");

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

export function codexAuthCommand() {
  return {
    command: process.execPath,
    args: [CLI_ENTRY, "key", "print"],
    timeout_ms: 5000,
    refresh_interval_ms: 0
  };
}

function quoteCommandPart(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

export function claudeApiKeyHelper() {
  return [process.execPath, CLI_ENTRY, "key", "print"].map(quoteCommandPart).join(" ");
}

export function computeAppStatus(setup, service) {
  const githubTokenPresent = setup.auth.github_token.source !== "missing";
  const apiKeyPresent = setup.auth.api_key.exists;
  const hasAerialClient = setup.clients.codex.state === "aerial" || setup.clients.claude.state === "aerial";
  const serviceHealthy = service.supported !== false && service.health?.aerial === true;
  const ok = apiKeyPresent && githubTokenPresent && hasAerialClient && serviceHealthy;
  const nextSteps = [];
  const hints = [];
  if (!githubTokenPresent) nextSteps.push("run: aerial login");
  if (!hasAerialClient) nextSteps.push("run: aerial setup codex or aerial setup claude");
  if (hasAerialClient && !apiKeyPresent) nextSteps.push("run: aerial setup codex or aerial setup claude to recreate the local Aerial key");
  if (service.supported !== false && !service.service?.loaded) {
    if (serviceHealthy) {
      hints.push("Aerial is running in the foreground but no background service is installed; run `aerial service install` so it starts on reboot.");
    } else {
      nextSteps.push("run: aerial service install");
    }
  }
  if (setup.auth.github_token.source === "env") {
    hints.push("AERIAL_GITHUB_TOKEN is set for this process only; run aerial login without that env var to persist a service-readable login.");
  }
  return { schema: "aerial.status.v1", ok, setup, service, nextSteps, hints };
}
