import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomBytes, createHash } from "node:crypto";
import { loadConfig, readStoredApiKey } from "../src/shared/config.js";
import { claudeSettingsFile, codexConfigFile } from "../src/shared/paths.js";
import { localBaseUrl } from "../src/shared/urls.js";
import { createPrivateSessionDirectory, writePrivateJson } from "../src/cowork/private-files.js";
import { verifyClaudeVersion } from "../src/cowork/launcher.js";

const deny = process.argv.includes("--deny-write");
const executable = process.platform === "win32" ? "claude.exe" : "claude";
const hash = file => fs.existsSync(file) ? createHash("sha256").update(fs.readFileSync(file)).digest("hex") : null;
const beforeFiles = [claudeSettingsFile(), codexConfigFile()].map(file => ({ file, hash: hash(file) }));
const root = createPrivateSessionDirectory();
const workspace = path.join(root, "workspace");
fs.mkdirSync(workspace);
const input = `Persistent Cowork nonce: ${randomBytes(24).toString("hex")}\nMixed Case synthetic fixture.\n`;
fs.writeFileSync(path.join(workspace, "input.txt"), input, { flag: "wx" });
const config = loadConfig();
const key = readStoredApiKey();
const reportFile = path.join(root, "persistent-report.json");
const report = { status: "running", startedAt: new Date().toISOString(), scenario: deny ? "write-denied" : "read-write",
  workspace, noLauncherOrSettingsOverlay: true, clientConfigurationUnchanged: false };
writePrivateJson(reportFile, report);
const status = async () => {
  const response = await fetch(localBaseUrl(config, "/_aerial/cowork/status"), {
    headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(60000), redirect: "error"
  });
  const body = await response.json();
  if (!response.ok || body.provider !== "cowork" || !body.configured || !body.ready || body.model !== config.cowork?.model
    || body.profileDirectory !== config.cowork.profileDirectory || body.effort !== config.cowork.effort) throw new Error("Persistent Cowork service is not ready.");
  return body;
};
let child, timer, stdout = "", stderr = "";
try {
  if (!key || !config.cowork) throw new Error("Configure the persistent Cowork provider before running this live test.");
  report.claudeVersion = verifyClaudeVersion(executable);
  const before = await status();
  const prompt = "Use Read to read input.txt. Then use Write to create output.txt with the exact uppercase ASCII conversion of all text in input.txt, preserving whitespace and the final newline. Do not guess its contents. If Write is denied, stop without retrying or using another tool, and include the exact original first line from input.txt in your final response.";
  // The actual user's saved settings choose the route and authentication. No
  // model, base URL, key, settings overlay or routing environment is injected.
  child = spawn(executable, ["--safe-mode", "--strict-mcp-config", "--no-session-persistence",
    "--permission-mode", deny ? "manual" : "acceptEdits", ...(deny ? ["--permission-prompts", "none"] : []),
    "--max-turns", "6", "--output-format", "json", "--print", prompt],
  { cwd: workspace, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], shell: false });
  let overflow = false, timedOut = false;
  const capture = (name, chunk) => {
    if (name === "stdout") stdout += chunk.toString(); else stderr += chunk.toString();
    if (stdout.length + stderr.length > 512 * 1024) { overflow = true; child.kill(); }
  };
  child.stdout.on("data", chunk => capture("stdout", chunk));
  child.stderr.on("data", chunk => capture("stderr", chunk));
  timer = setTimeout(() => { timedOut = true; child.kill(); }, 300000);
  const [exitCode] = await once(child, "close");
  clearTimeout(timer);
  const result = JSON.parse(stdout.trim());
  const after = await status();
  const denials = (result.permission_denials || []).map(item => item.tool_name);
  const usedModels = Object.keys(result.modelUsage || {});
  const outputFile = path.join(workspace, "output.txt");
  const output = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, "utf8") : undefined;
  report.checks = {
    childExitedZero: exitCode === 0, finishedWithinLimits: !overflow && !timedOut,
    claudeReportedSuccess: result.is_error === false,
    clientReportedOnlyCoworkModel: usedModels.length === 1 && usedModels[0] === config.cowork.model,
    realCoworkUsed: after.stats.upstreamTurns > before.stats.upstreamTurns,
    oneCoworkConversation: after.conversationReuseVerified === true && after.stats.conversations - before.stats.conversations === 1,
    localToolsUsed: after.stats.toolCalls - before.stats.toolCalls >= 2 && after.stats.toolResults - before.stats.toolResults >= 2,
    noGatewayErrors: after.stats.errors === before.stats.errors,
    inputUnchanged: fs.readFileSync(path.join(workspace, "input.txt"), "utf8") === input,
    ...(deny ? { outputAbsent: output === undefined, writeDenied: denials.includes("Write"),
      readConfirmed: typeof result.result === "string" && result.result.includes(input.split("\n")[0]),
      noOtherDenials: denials.every(name => name === "Write") }
      : { exactUppercaseOutput: output === input.toUpperCase(), noDenials: denials.length === 0 })
  };
  report.model = after.model;
  report.effort = after.effort;
  report.cloudToolIsolation = after.cloudToolIsolation;
  report.statsDelta = Object.fromEntries(Object.keys(after.stats).map(name => [name, after.stats[name] - before.stats[name]]));
  report.clientConfigurationUnchanged = beforeFiles.every(item => hash(item.file) === item.hash);
  if (!report.clientConfigurationUnchanged || !Object.values(report.checks).every(Boolean)) throw new Error("Persistent Cowork live acceptance failed.");
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error.message).split(key || "synthetic-unused-key").join("[redacted]");
  report.stdout = stdout.slice(0, 32000).split(key || "synthetic-unused-key").join("[redacted]");
  report.stderr = stderr.slice(0, 32000).split(key || "synthetic-unused-key").join("[redacted]");
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  report.completedAt = new Date().toISOString();
  writePrivateJson(reportFile, report);
  console.log(JSON.stringify({ status: report.status, scenario: report.scenario, reportFile, checks: report.checks, statsDelta: report.statsDelta }, null, 2));
}
