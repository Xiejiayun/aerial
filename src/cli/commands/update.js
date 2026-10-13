import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readPackageVersion } from "../helpers.js";

const PACKAGE_NAME = "@jiayunxie/aerial";
const PACKAGE_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const MANUAL_UPDATE = `npm install -g ${PACKAGE_NAME}@latest`;
const USAGE = "Usage: aerial update [--check] (alias: aerial upgrade)";
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function windowsNpmCli() {
  const pathValue = Object.entries(process.env).find(([key]) => key.toLowerCase() === "path")?.[1] || "";
  const directories = [path.dirname(process.execPath), ...pathValue.split(path.delimiter).filter(Boolean)];
  const candidates = [
    process.env.npm_execpath,
    ...directories.map((dir) => path.join(dir.replace(/^"|"$/g, ""), "node_modules", "npm", "bin", "npm-cli.js"))
  ];
  const cli = candidates.find((file) => file && path.basename(file) === "npm-cli.js" && fs.existsSync(file));
  if (!cli) throw new Error(`Cannot locate npm. Install Node.js with npm, then run: ${MANUAL_UPDATE}`);
  return cli;
}

export function runUpdateNpm(args, { stdio = "pipe", timeout = 30000 } = {}) {
  // Execute npm's JavaScript entry directly on Windows: .cmd shims require a
  // shell and would introduce another layer of argument/path quoting.
  const windows = process.platform === "win32";
  return spawnSync(windows ? process.execPath : "npm", windows ? [windowsNpmCli(), ...args] : args, {
    cwd: os.homedir(),
    encoding: "utf8",
    windowsHide: true,
    stdio,
    timeout
  });
}

function requireNpm(result, action) {
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || String(result.stderr || result.stdout || "").trim()
      || `exit ${result.status ?? result.signal ?? "unknown"}`;
    throw new Error(`${action} failed: ${detail}\nRetry with: ${MANUAL_UPDATE}`);
  }
  return String(result.stdout || "").trim();
}

function compareVersions(current, latest) {
  if (!STABLE_VERSION.test(current) || !STABLE_VERSION.test(latest)) {
    throw new Error(`Cannot compare Aerial versions (${JSON.stringify(current)}, ${JSON.stringify(latest)}). Use: ${MANUAL_UPDATE}`);
  }
  const a = current.split(".").map(BigInt);
  const b = latest.split(".").map(BigInt);
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}

function requireGlobalInstall(root, packageRoot) {
  let matches = false;
  if (path.isAbsolute(root)) {
    const target = path.join(root, ...PACKAGE_NAME.split("/"));
    try {
      // npm link and installs from a source checkout must remain under the
      // developer's control, even when the global entry resolves to this copy.
      matches = !fs.lstatSync(target).isSymbolicLink()
        && path.relative(fs.realpathSync(target), fs.realpathSync(packageRoot)) === "";
    } catch {}
  }
  if (!matches) {
    throw new Error(`This Aerial copy is not an npm global installation managed by the active npm. Update it with its original package manager, or install the global CLI with: ${MANUAL_UPDATE}`);
  }
}

export function runUpdateCli(args, {
  runNpm = runUpdateNpm,
  packageRoot = PACKAGE_ROOT,
  platform = process.platform,
  log = console.log
} = {}) {
  if (args.some((arg) => !["--check", "--help", "-h"].includes(arg))) throw new Error(USAGE);
  if (args.includes("--help") || args.includes("-h")) {
    log(`${USAGE}\n\nInstall the latest stable Aerial release from your configured npm registry.\n  --check  Show the current and latest versions without installing.\n\nAfter updating, restart running Aerial processes to load the new version.`);
    return;
  }

  const manifest = pathToFileURL(path.join(packageRoot, "package.json"));
  const current = readPackageVersion(manifest);
  log(`Current Aerial: ${current}`);
  log("Checking the configured npm registry for the latest release...");
  const raw = requireNpm(runNpm([
    "view", `${PACKAGE_NAME}@latest`, "version", "--json", "--prefer-online", "--fetch-retries=0", "--fetch-timeout=15000"
  ]), "Checking for Aerial updates");
  let latest;
  try { latest = JSON.parse(raw); } catch {}
  if (typeof latest !== "string" || !STABLE_VERSION.test(latest)) {
    throw new Error("npm returned an invalid latest Aerial version; no update was attempted.");
  }
  const comparison = compareVersions(current, latest);
  log(`Latest Aerial in this registry: ${latest}`);
  if (comparison >= 0) {
    log(comparison === 0
      ? `Aerial ${current} is already up to date in the configured npm registry.`
      : `Aerial ${current} is newer than this registry's latest (${latest}); skipping downgrade.`);
    return;
  }
  if (args.includes("--check")) {
    log(`Update available: ${current} -> ${latest}. Run: aerial update`);
    return;
  }

  const root = requireNpm(runNpm(["root", "--global"]), "Locating the npm global installation");
  requireGlobalInstall(root, packageRoot);
  log(`Updating Aerial: ${current} -> ${latest}...`);
  // Pin the version just checked and let npm reject incompatible Node engines.
  requireNpm(runNpm([
    "install", "--global", `${PACKAGE_NAME}@${latest}`, "--engine-strict", "--force=false", "--no-fund", "--no-audit"
  ], { stdio: "inherit", timeout: 300000 }), "Installing the Aerial update");
  const installed = readPackageVersion(manifest);
  if (installed !== latest) {
    throw new Error(`npm finished, but this Aerial installation reports ${installed} (expected ${latest}). Check your npm global prefix and PATH. Retry with: ${MANUAL_UPDATE}`);
  }
  log(`Updated Aerial: ${current} -> ${installed}.`);
  if (platform === "win32" || platform === "darwin") {
    log("If you use the background service, run:\n  aerial service install\n  aerial service restart");
  }
  log("Restart any foreground Aerial process or service you manage yourself to load the new version.");
}
