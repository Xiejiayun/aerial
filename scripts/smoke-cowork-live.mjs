#!/usr/bin/env node
// Explicit live acceptance test. This uses the production authentication,
// profile gate, transport, gateway, and launcher; it never promotes evidence.
// It consumes Cowork usage when a previously verified profile permits inference.
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { openCoworkSession } from "../src/cowork/index.js";
import { launchCoworkClaude, SUPPORTED_CLAUDE_VERSIONS } from "../src/cowork/launcher.js";
import { createPrivateSessionDirectory, writePrivateJson } from "../src/cowork/private-files.js";

const TIMEOUT_MS = 300_000;
const CAPTURE_BYTES = 1024 * 1024;
const OUTPUT_BYTES = 64 * 1024;
const STAT_KEYS = ["requests", "upstreamTurns", "toolCalls", "toolResults", "errors", "reused"];
const FAILURE_CODES = new Set([
  "INVALID_ARGUMENT", "PROTOCOL_UNVERIFIED", "PROFILE_REQUIRED", "PROFILE_IN_USE", "INVALID_PROFILE",
  "AUTH_REQUIRED", "AUTH_DENIED", "AUTH_CANCELED", "AUTH_DEPENDENCIES_MISSING", "AUTH_HELPER_FAILED",
  "AUTH_INVALID_TOKEN", "AUTH_INVALID_RECORD", "ACCOUNT_CHANGED", "MODEL_REQUIRED", "MODEL_UNAVAILABLE",
  "MODEL_UNSUPPORTED", "UNSUPPORTED_CAPABILITY", "UNSUPPORTED_PLATFORM", "UNSUPPORTED_RUNTIME",
  "PROTOCOL_CHANGED", "UPSTREAM_UNAVAILABLE", "UPSTREAM_REJECTED", "SUBMISSION_UNKNOWN",
  "RESULT_UNAVAILABLE", "ROUTE_NOT_USED", "LIVE_SMOKE_TIMEOUT", "LIVE_SMOKE_INTERRUPTED",
  "LIVE_SMOKE_CAPTURE_LIMIT", "LIVE_SMOKE_CLI_RESULT_INVALID", "LIVE_SMOKE_VALIDATION_FAILED"
]);

function failure(code) {
  return Object.assign(new Error(code), { code });
}

export function parseLiveSmokeArguments(args) {
  let values;
  try {
    ({ values } = parseArgs({ args, allowPositionals: false, strict: true, options: {
      "profile-dir": { type: "string" }, claude: { type: "string" }, model: { type: "string" },
      "deny-write": { type: "boolean", default: false }, help: { type: "boolean", default: false }
    } }));
  } catch { throw failure("INVALID_ARGUMENT"); }
  if (values.help) return { help: true };
  if (!values["profile-dir"] || !path.isAbsolute(values["profile-dir"])
    || !values.claude || !path.isAbsolute(values.claude) || !/\.exe$/i.test(values.claude)
    || !values.model?.trim() || values.model !== values.model.trim()) throw failure("INVALID_ARGUMENT");
  return { directory: values["profile-dir"], executable: values.claude, model: values.model, denyWrite: values["deny-write"] };
}

function boundedCapture() {
  const chunks = [];
  let bytes = 0, retained = 0;
  return {
    append(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      const remaining = CAPTURE_BYTES - retained;
      if (remaining > 0) {
        const kept = buffer.subarray(0, remaining);
        chunks.push(Buffer.from(kept));
        retained += kept.length;
      }
    },
    snapshot() { return { bytes, truncated: bytes > retained, text: Buffer.concat(chunks).toString("utf8") }; }
  };
}

function redact(text, localKey) {
  let value = String(text);
  if (localKey) value = value.split(localKey).join("<local-key-redacted>");
  return value
    .replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer <redacted>")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "<jwt-redacted>")
    .replace(/\bsk-ant-[A-Za-z0-9_-]+\b/g, "<api-key-redacted>")
    .replace(/((?:ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|authorization)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, "$1<redacted>");
}

function snapshotStats(stats) {
  return Object.fromEntries(STAT_KEYS.map(key => [key, Number.isSafeInteger(stats?.[key]) && stats[key] >= 0 ? stats[key] : null]));
}

function readRegularFile(file, limit) {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return { exists: false, valid: true };
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) return { exists: true, valid: false };
  return { exists: true, valid: true, text: fs.readFileSync(file, "utf8") };
}

export async function runLiveSmoke({ directory, executable, model, denyWrite }) {
  try {
    if (!fs.statSync(directory).isDirectory() || !fs.statSync(executable).isFile()) throw failure("INVALID_ARGUMENT");
  } catch { throw failure("INVALID_ARGUMENT"); }

  const started = Date.now();
  const root = createPrivateSessionDirectory();
  const workspace = path.join(root, "workspace");
  const isolatedHome = path.join(root, "home");
  const configDirectory = path.join(isolatedHome, ".claude");
  const appData = path.join(isolatedHome, "AppData", "Roaming");
  const localAppData = path.join(isolatedHome, "AppData", "Local");
  for (const folder of [workspace, configDirectory, appData, localAppData]) fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  // Every child directory/file inherits the verified private root ACL. The
  // random input is never included in the prompt, so correct output needs Read.
  const input = path.join(workspace, "input.txt");
  const output = path.join(workspace, "output.txt");
  const inputText = `Cowork live read/write nonce: ${randomBytes(24).toString("hex")}\nMixed Case synthetic fixture.\n`;
  const expectedOutput = inputText.toUpperCase();
  fs.writeFileSync(input, inputText, { encoding: "utf8", flag: "wx", mode: 0o600 });
  writePrivateJson(path.join(configDirectory, "settings.json"), { alwaysThinkingEnabled: false });
  const reportFile = path.join(root, "live-report.json");
  const report = {
    version: 1, kind: "real-claude-real-cowork", status: "unverified", verified: false,
    scenario: denyWrite ? "write-permission-denied" : "read-write-roundtrip",
    startedAt: new Date(started).toISOString(), completedAt: null, elapsedMs: null,
    supportedClaudeVersions: SUPPORTED_CLAUDE_VERSIONS, claudeVersion: null, requestedModel: model,
    route: null, actualModelIdentity: "unreported", workspace, timeoutMs: TIMEOUT_MS,
    syntheticInput: inputText, expectedOutput, output: null, checks: {}, gatewayEvents: [],
    operationRecovery: "Production records stay in the selected profile; this script never releases or resubmits unknown operations."
  };
  // An interrupted process leaves an explicitly unverified report, never a pass.
  writePrivateJson(reportFile, report);

  const env = {
    ...process.env, CLAUDE_CONFIG_DIR: configDirectory, USERPROFILE: isolatedHome, HOME: isolatedHome,
    APPDATA: appData, LOCALAPPDATA: localAppData, DISABLE_AUTOUPDATER: "1", NO_PROXY: "127.0.0.1,localhost"
  };
  const signals = new EventEmitter();
  const controller = new AbortController();
  const stdout = boundedCapture(), stderr = boundedCapture();
  let stopCode, session, launchResult, caught, child;
  let stage = "opening_session";
  const stop = (code, signal) => {
    stopCode ||= code;
    controller.abort(failure(stopCode));
    // The launcher owns abort, child termination (including a forced fallback),
    // awaited gateway/auth cleanup, and the profile lock. Do not race past it.
    signals.emit(signal);
  };
  const onInterrupt = () => stop("LIVE_SMOKE_INTERRUPTED", "SIGINT");
  const onTerminate = () => stop("LIVE_SMOKE_INTERRUPTED", "SIGTERM");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  const timer = setTimeout(() => stop("LIVE_SMOKE_TIMEOUT", "SIGTERM"), Math.max(1, TIMEOUT_MS - (Date.now() - started)));
  const prompt = "Use Read to read input.txt in the current working directory. Then use Write to create output.txt containing the exact uppercase ASCII conversion of all text from input.txt. Preserve all whitespace and the final newline. Do not guess or invent the file contents. Complete both tool operations before your final reply. If Write is denied by permissions, report that denial and stop without retrying or using another tool; include the exact, unchanged first line you read from input.txt in your final response so the verifier can confirm the read. Reply COWORK_LIVE_DONE after success, or COWORK_LIVE_WRITE_DENIED followed by that original first line after a permission denial.";

  process.stderr.write("Live Cowork acceptance test: this may consume Cowork usage. Only synthetic files are used; the production profile gate remains required.\n");
  try {
    controller.signal.throwIfAborted();
    launchResult = await launchCoworkClaude({
      model, executable, cwd: workspace, env, signals,
      args: ["--safe-mode", "--strict-mcp-config", "--no-session-persistence", "--tools", "Read,Write",
        "--permission-mode", denyWrite ? "manual" : "acceptEdits", ...(denyWrite ? ["--permission-prompts", "none"] : []),
        "--max-turns", "6", "--output-format", "json", "--print", prompt],
      openSession: async ({ model: selectedModel, signal }) => {
        // No dependency injection or profile rewriting: requireLive runs before
        // authentication, and all inference uses the real production transport.
        session = await openCoworkSession({ model: selectedModel, directory, signal: AbortSignal.any([signal, controller.signal]),
          log: event => { if (report.gatewayEvents.length < 200) report.gatewayEvents.push(event); } });
        report.route = { publicId: session.route.publicId, upstreamId: session.route.upstreamId,
          displayName: session.route.displayName, provider: session.route.provider };
        report.cloudToolIsolation = session.capabilities.cloudToolIsolation;
        report.experimentalTrial = session.capabilities.experimentalTrial === true;
        return session;
      },
      runVersion: (file, args, options) => spawnSync(file, args, { ...options, cwd: workspace, env }),
      spawnImpl: (file, args, options) => {
        controller.signal.throwIfAborted();
        stage = "running_claude";
        child = spawn(file, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
        child.stdout.on("data", chunk => stdout.append(chunk));
        child.stderr.on("data", chunk => stderr.append(chunk));
        return child;
      },
      warn: message => {
        if (message.startsWith("Cowork disconnected locally.")) report.localDisconnectWarning = true;
        else if (message.startsWith("Experimental Cowork trial:")) report.experimentalTrialWarning = true;
      }
    });
    stage = "validating_result";
    if (stopCode) throw failure(stopCode);
    const captured = stdout.snapshot();
    if (captured.truncated || stderr.snapshot().truncated) throw failure("LIVE_SMOKE_CAPTURE_LIMIT");
    let result;
    try { result = JSON.parse(captured.text.trim()); }
    catch { throw failure("LIVE_SMOKE_CLI_RESULT_INVALID"); }
    if (!result || typeof result !== "object" || Array.isArray(result)
      || typeof result.is_error !== "boolean" || !Array.isArray(result.permission_denials)) throw failure("LIVE_SMOKE_CLI_RESULT_INVALID");
    const denials = result.permission_denials.map(entry => entry?.tool_name);
    const stats = snapshotStats(session?.stats);
    const actualInput = readRegularFile(input, OUTPUT_BYTES);
    const actualOutput = readRegularFile(output, OUTPUT_BYTES);
    report.output = actualOutput.valid && actualOutput.exists ? actualOutput.text : null;
    report.claudeResult = { isError: result.is_error, numTurns: Number.isSafeInteger(result.num_turns) ? result.num_turns : null,
      permissionDenials: denials.map(name => ["Read", "Write"].includes(name) ? name : "unexpected-tool") };
    report.checks = {
      childExitedZero: launchResult.exitCode === 0 && child?.exitCode === 0,
      claudeReportedSuccess: result.is_error === false,
      selectedRouteMatched: session?.route?.publicId === model || session?.route?.upstreamId === model,
      realGatewayUsed: stats.requests > 0 && stats.upstreamTurns > 0,
      atLeastTwoToolCalls: stats.toolCalls >= 2, atLeastTwoToolResults: stats.toolResults >= 2,
      noGatewayErrors: stats.errors === 0,
      inputUnchanged: actualInput.valid && actualInput.text === inputText,
      // Counters include repeated conversation history. The unpredictable input
      // echoed after denial provides separate evidence that Read actually ran.
      ...(denyWrite ? { outputAbsent: !actualOutput.exists,
        readEvidenceReturned: typeof result.result === "string" && result.result.includes(inputText.split("\n", 1)[0]),
        writeDenied: denials.includes("Write"), noOtherPermissionDenials: denials.every(name => name === "Write") }
        : { exactUppercaseOutput: actualOutput.valid && actualOutput.text === expectedOutput, noPermissionDenials: denials.length === 0 })
    };
    if (!Object.values(report.checks).every(value => value === true)) throw failure("LIVE_SMOKE_VALIDATION_FAILED");
    report.status = "passed";
    report.verified = true;
  } catch (error) {
    caught = error;
    report.failure = { code: stopCode || (FAILURE_CODES.has(error?.code) ? error.code : "LIVE_SMOKE_FAILED"), stage };
    report.status = error?.code === "PROTOCOL_UNVERIFIED" ? "unverified" : "failed";
  } finally {
    clearTimeout(timer);
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
    // launchCoworkClaude has already awaited its production close path, including
    // operation persistence. Do not inspect/recover/release that store here.
    report.completedAt = new Date().toISOString();
    report.elapsedMs = Date.now() - started;
    report.stats = snapshotStats(session?.stats || launchResult?.stats);
    report.child = launchResult ? { exitCode: launchResult.exitCode, signal: launchResult.signal || null } : null;
    report.claudeVersion = launchResult?.claudeVersion || null;
    report.remoteCancellation = stopCode ? "not-confirmed" : "not-requested";
    report.stdout = stdout.snapshot();
    report.stderr = stderr.snapshot();
    report.stdout.text = redact(report.stdout.text, session?.apiKey);
    report.stderr.text = redact(report.stderr.text, session?.apiKey);
    if (report.output !== null) report.output = redact(report.output, session?.apiKey);
    writePrivateJson(reportFile, report);
  }
  // Do not print captured model output, exception messages, session objects,
  // authentication metadata, or private settings. The private report is retained.
  return { ok: !caught && report.verified, status: report.status, scenario: report.scenario,
    ...(report.failure ? { failure: report.failure } : {}), reportFile, workspace, elapsedMs: report.elapsedMs,
    stats: report.stats, checks: report.checks };
}

async function main() {
  const options = parseLiveSmokeArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write("Usage: node scripts/smoke-cowork-live.mjs --profile-dir <absolute directory> --claude <absolute native .exe> --model <exact catalog ID> [--deny-write]\nRuns live inference only after the production profile gate passes. Retains a private synthetic workspace and report.\n");
    return;
  }
  const summary = await runLiveSmoke(options);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (!summary.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    process.stderr.write(`${JSON.stringify({ ok: false, status: "failed", verified: false,
      code: FAILURE_CODES.has(error?.code) ? error.code : "LIVE_SMOKE_FAILED" })}\n`);
    process.exitCode = 1;
  });
}
