import path from "node:path";
import { requiredArgValue, parseConfigHost, parseConfigPort } from "../helpers.js";
import { launchCoworkClaude, validateClaudeArguments } from "../../cowork/launcher.js";
import { validateInvestigationEffort } from "../../cowork/transport.js";
import { loadConfig, readStoredApiKey } from "../../shared/config.js";
import { localBaseUrl } from "../../shared/urls.js";

const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const displayValue = value => String(value ?? "unknown").replace(/[\x00-\x1f\x7f-\x9f]/g, " ");

export async function listCoworkModelsForCli(api, { readConfig = loadConfig, readKey = readStoredApiKey, fetchImpl = globalThis.fetch } = {}) {
  const config = readConfig();
  if (!config.cowork) return api.listCoworkModels();
  const directory = path.resolve(api.coworkDirectory());
  if (typeof config.cowork.profileDirectory !== "string" || path.resolve(config.cowork.profileDirectory) !== directory) {
    return api.listCoworkModels();
  }
  const base = localBaseUrl({ host: parseConfigHost(config.host), port: parseConfigPort(config.port) });
  const key = readKey();
  if (!key) throw new Error("The configured Cowork service needs its existing local Aerial key. Check aerial service status before listing models.");
  let response, body;
  try {
    response = await fetchImpl(`${base}/_aerial/cowork/catalog`, {
      headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30000), redirect: "error"
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Cowork catalog request failed.");
    }
    body = await response.json();
  } catch {
    throw new Error("Cannot read the configured Cowork service catalog. Check the local key, update or start Aerial, then retry; no second profile writer was opened.");
  }
  if (body?.provider !== "cowork" || typeof body.configured !== "boolean") throw new Error("The local service did not return a valid Cowork catalog.");
  if (!body.configured) return api.listCoworkModels();
  if (typeof body.profileDirectory !== "string" || path.resolve(body.profileDirectory) !== directory || !Array.isArray(body.models)) {
    throw new Error("The local Cowork service catalog belongs to a different profile or has an invalid shape.");
  }
  return body.models;
}

export function assertCoworkRuntime({ platform = process.platform, nodeVersion = process.versions.node } = {}) {
  if (platform !== "win32") throw new Error("Cowork authentication currently requires Windows. Existing Aerial GitHub Copilot commands remain available on this platform.");
  const major = Number(String(nodeVersion).split(".")[0]);
  if (!Number.isInteger(major) || major < 24) throw new Error("Cowork commands require Node.js 24 or newer. Existing Aerial commands retain their current Node.js requirement.");
}

export async function runCoworkCli(command, args, {
  core, launch = launchCoworkClaude, runtime, print = console.log, warn = console.error,
  readConfig = loadConfig, readKey = readStoredApiKey, fetchImpl = globalThis.fetch
} = {}) {
  assertCoworkRuntime(runtime);
  const separator = args.indexOf("--");
  const options = separator < 0 ? args : args.slice(0, separator);
  const claudeArgs = separator < 0 ? [] : args.slice(separator + 1);
  const profile = command === "configure" ? requiredArgValue(options, "--profile") : undefined;
  if (command === "configure" && !profile?.trim()) throw new Error("aerial cowork configure requires --profile <json> containing the authorized-session protocol evidence.");
  let model;
  if (["run", "probe", "verify"].includes(command)) {
    model = requiredArgValue(options, "--model");
    if (!model?.trim()) throw new Error(`aerial cowork ${command} requires --model <id>. Run aerial cowork models and explicitly select an available route.`);
    if (command === "run") validateClaudeArguments(claudeArgs);
  }
  const effort = ["run", "probe", "verify"].includes(command) ? requiredArgValue(options, "--effort") : undefined;
  if (command === "verify" && effort === undefined) throw new Error("aerial cowork verify requires --effort <low|medium|high|xhigh|max>.");
  if (["run", "probe", "verify"].includes(command)) validateInvestigationEffort(effort);
  const origin = command === "auth" ? requiredArgValue(options, "--origin") : undefined;
  if (origin) {
    const url = new URL(origin);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Cowork --origin must be an HTTPS origin without credentials, path, query or fragment.");
  }
  const api = core || await import("../../cowork/index.js");
  if (command === "configure") {
    const allowUnverifiedCloudTools = options.includes("--allow-unverified-cloud-tools");
    const report = await api.configureCowork({ file: profile, ...(allowUnverifiedCloudTools ? { allowUnverifiedCloudTools: true } : {}) });
    if (report?.experimentalTrial) warn("Experimental Cowork trial enabled: cloud-tool isolation remains unverified. Claude's local tool permissions do not control Cowork's cloud tools.");
    print("Cowork protocol profile saved. Run aerial cowork auth, then aerial cowork doctor to check its evidence and identity.");
    return 0;
  }
  if (command === "auth") {
    print("Opening the Microsoft Windows sign-in window. Complete account selection and MFA there; close the Aerial sign-in window to cancel.");
    await api.authenticateCowork({ interactive: true, ...(origin ? { origin } : {}) });
    print("Cowork identity saved. Run aerial cowork models to inspect the available routes.");
    return 0;
  }
  if (command === "doctor") {
    const report = await api.inspectCowork();
    if (options.includes("--json")) print(JSON.stringify(report, null, 2));
    else {
      print(`Cowork: ${report.ok ? "ready" : "not ready"}`);
      if (report.status) print(`  status: ${report.status}`);
      if (report.authentication || report.catalog) print(`  authentication: ${report.authentication || "unknown"}; catalog: ${report.catalog || "unknown"}`);
      if (report.cloudToolIsolation) print(`  cloud-tool isolation: ${report.cloudToolIsolation}${report.status === "ready_experimental" ? " (experimental trial enabled)" : ""}`);
      for (const check of report.checks || []) print(`  ${check.ok ? "ok" : "failed"}: ${check.message || check.name || check.id}`);
      if (report.error) print(`  ${typeof report.error === "string" ? report.error : report.error.message || report.error.code}`);
      print("This check does not send an inference request.");
    }
    return report.ok ? 0 : 1;
  }
  if (command === "models") {
    const result = await listCoworkModelsForCli(api, { readConfig, readKey, fetchImpl });
    if (options.includes("--json")) print(JSON.stringify(result, null, 2));
    else {
      const models = Array.isArray(result) ? result : result.models || result.data || [];
      for (const entry of models) {
        const values = entry.supportedEfforts || entry.supported_effort_levels;
        const advertised = Array.isArray(values) ? values.filter(value => EFFORTS.has(value)) : [];
        const preferred = entry.defaultEffort || entry.default_effort_level;
        print(`${displayValue(entry.publicId || entry.id)}  ${displayValue(entry.displayName || entry.display_name || entry.name)}  provider=${displayValue(entry.provider)}`);
        print(`  advertised effort: ${advertised.length ? advertised.join(", ") : "unknown"}; default: ${EFFORTS.has(preferred) ? preferred : "unknown"}`);
      }
      if (!models.length) print("No Cowork model routes are available for this identity.");
      print("Catalog effort values are advertised capabilities, not model/effort verification evidence.");
      print("Verify a route with: aerial cowork verify --model <id> --effort <level>");
      print("Select an exact route with: aerial cowork run --model <id> [--effort <level>]");
    }
    return 0;
  }
  if (command === "run") {
    warn("Cowork compatibility mode: simulated tools, buffered output, and estimated usage. Model requests consume Cowork allowance.");
    const result = await launch({
      model, ...(effort !== undefined ? { effort } : {}), executable: requiredArgValue(options, "--claude"), args: claudeArgs,
      openSession: api.openCoworkSession, warn
    });
    return result.exitCode;
  }
  if (command === "probe") {
    warn("Sending one fixed synthetic Cowork text probe. This consumes Cowork allowance and does not establish Claude Code tool compatibility.");
    const report = await api.probeCowork({ model, ...(effort !== undefined ? { effort } : {}) });
    print(JSON.stringify(report, null, 2));
    return report.ok === false ? 1 : 0;
  }
  if (command === "verify") {
    warn("Sending one fixed-text model/effort verification. This consumes Cowork allowance and does not prove internal reasoning behavior or cloud-tool isolation. Stop Aerial first if it owns this profile (aerial service stop).");
    const report = await api.verifyCoworkRoute({ model, effort });
    const accepted = report?.ok === true && report.accepted === true && report.effort === effort
      && (report.model === model || report.upstreamModel === model)
      && typeof report.evidenceFile === "string" && path.isAbsolute(report.evidenceFile);
    const safeReport = { model: typeof report?.model === "string" ? report.model : model, effort, accepted,
      ...(typeof report?.upstreamModel === "string" ? { upstreamModel: report.upstreamModel } : {}),
      ...(typeof report?.evidenceFile === "string" && path.isAbsolute(report.evidenceFile) ? { evidenceFile: report.evidenceFile } : {}) };
    print(JSON.stringify(safeReport, null, 2));
    if (!accepted) warn("Cowork route verification did not pass; this command did not establish an accepted model/effort pair.");
    return accepted ? 0 : 1;
  }
  if (command === "operations") {
    const records = await api.listCoworkOperations();
    if (options.includes("--json")) print(JSON.stringify(records, null, 2));
    else {
      for (const record of records) print(`${record.id}  phase=${record.phase}  remote=${record.remoteState || "unknown"}  local=${record.localOutcome || "unknown"}`);
      if (!records.length) print("No Cowork operation records.");
    }
    return 0;
  }
  if (command === "release") {
    const id = options[0];
    if (!id?.trim()) throw new Error("aerial cowork release requires an operation ID from aerial cowork operations.");
    await api.releaseCoworkOperation({ id });
    print(`Released retry protection for ${id}. This does not cancel a remote task or send inference. A later retry can consume additional Cowork allowance.`);
    return 0;
  }
  throw new Error(`Unknown Cowork command: ${command}`);
}
