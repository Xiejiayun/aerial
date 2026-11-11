import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createPrivateSessionDirectory, writePrivateJson } from "./private-files.js";

export const SUPPORTED_CLAUDE_VERSION = "2.1.322";
export const SUPPORTED_CLAUDE_VERSIONS = Object.freeze(["2.1.281", SUPPORTED_CLAUDE_VERSION]);
export const COWORK_CLIENT_EFFORTS = Object.freeze(["low", "medium", "high", "xhigh", "max"]);

const PROVIDER_FLAGS = [
  "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_MANTLE", "CLAUDE_CODE_USE_ANTHROPIC_AWS"
];
const BLOCKED_ARGUMENTS = new Set([
  "--model", "--fallback-model", "--settings", "--setting-sources", "--effort", "--betas", "--json-schema",
  "--cloud", "--environment", "--bg", "--background", "--remote-control", "--teleport", "--bare",
  "--resume", "-r", "--continue", "-c"
]);

export function validateClaudeArguments(args = []) {
  for (const arg of args) {
    const option = String(arg).split("=", 1)[0];
    if (BLOCKED_ARGUMENTS.has(option)) throw new Error(`Claude argument ${option} is not supported by isolated Cowork sessions. Select the route with aerial cowork run --model and keep provider settings managed by this session.`);
  }
}

export function buildCoworkClaudeSettings(session) {
  const url = new URL(session.baseUrl);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Cowork session must use an authenticated local loopback origin.");
  if (!session.apiKey || typeof session.apiKey !== "string" || !session.model || typeof session.model !== "string") throw new Error("Cowork session is missing its local authentication or selected model.");
  const env = {
    ...Object.fromEntries(PROVIDER_FLAGS.map(key => [key, "0"])),
    ANTHROPIC_BASE_URL: url.origin,
    ANTHROPIC_AUTH_TOKEN: session.apiKey,
    // Use one auth source for interactive sessions. A fresh API-key env value
    // prompts on every launch and conflicts with the session bearer token.
    ANTHROPIC_API_KEY: "",
    CLAUDE_CODE_OAUTH_TOKEN: "",
    ANTHROPIC_MODEL: session.model,
    ANTHROPIC_DEFAULT_MODEL: session.model,
    ANTHROPIC_SMALL_FAST_MODEL: session.model,
    CLAUDE_CODE_SUBAGENT_MODEL: session.model,
    ...Object.fromEntries(["OPUS", "SONNET", "HAIKU", "FABLE"].map(family => [`ANTHROPIC_DEFAULT_${family}_MODEL`, session.model])),
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
    // Claude 2.1.281 otherwise arms its first-party refusal fallback for Opus
    // 5.5 aliases and adds a fallback-credit beta. Cowork pins one exact route.
    CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK: "1",
    // 2.1.322 can force adaptive thinking for Opus 5.5 despite the legacy
    // MAX_THINKING_TOKENS setting. This adapter does not expose signed thinking.
    CLAUDE_CODE_DISABLE_THINKING: "1",
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    ENABLE_TOOL_SEARCH: "false",
    MAX_THINKING_TOKENS: "0",
    API_TIMEOUT_MS: "960000"
  };
  const effort = session.capabilities?.clientEffort;
  if (effort !== undefined) {
    if (!COWORK_CLIENT_EFFORTS.includes(effort)) throw new Error("Cowork session advertised an invalid client effort.");
    env.CLAUDE_CODE_EFFORT_LEVEL = effort;
  }
  return {
    model: session.model,
    modelOverrides: { [session.model]: session.model },
    apiKeyHelper: "",
    alwaysThinkingEnabled: false,
    // max is a session effort: Claude 2.1.322 sends it exactly from env, while
    // its persistent effortLevel fields only accept low through xhigh.
    ...(effort && effort !== "max" ? { effortLevel: effort, modelSettings: { [session.model]: { effortLevel: effort } } } : {}),
    env
  };
}

export function buildCoworkClaudeEnvironment(settings, inherited = process.env) {
  if (inherited.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST && !/^(0|false|no)$/i.test(inherited.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST)) throw new Error("Claude's provider is managed by its host. Cowork will not override that provider policy.");
  const clean = Object.fromEntries(Object.entries(inherited).filter(([key]) =>
    !/^ANTHROPIC_/i.test(key) && !/^CLAUDE_CODE_USE_/i.test(key)
    && !["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_EFFORT_LEVEL", "CLAUDE_CODE_SUBAGENT_MODEL", "MAX_THINKING_TOKENS"].includes(key)));
  return { ...clean, ...settings.env };
}

export function verifyClaudeVersion(executable = process.platform === "win32" ? "claude.exe" : "claude", runVersion = spawnSync) {
  const result = runVersion(executable, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 10000 });
  if (result.error || result.status !== 0) throw new Error("Cannot start Claude Code. Install its native executable or pass --claude <absolute-path>.");
  const version = /^([0-9]+\.[0-9]+\.[0-9]+)\b/.exec(String(result.stdout).trim())?.[1];
  if (!SUPPORTED_CLAUDE_VERSIONS.includes(version)) throw new Error(`Cowork was verified with Claude Code ${SUPPORTED_CLAUDE_VERSIONS.join(" and ")}; installed version is ${version || "unknown"}. Use a verified executable with --claude before starting a session.`);
  return version;
}

export async function launchCoworkClaude({
  model, effort, executable = process.platform === "win32" ? "claude.exe" : "claude", args = [], openSession,
  cwd = process.cwd(), env = process.env, warn = console.error,
  spawnImpl = spawn, runVersion = spawnSync, makeSessionDirectory = createPrivateSessionDirectory,
  writeSettings = writePrivateJson, signals = process
} = {}) {
  if (!model?.trim()) throw new Error("An explicitly selected Cowork model is required.");
  if (effort !== undefined && !COWORK_CLIENT_EFFORTS.includes(effort)) throw new Error("Cowork effort must be low, medium, high, xhigh or max.");
  validateClaudeArguments(args);
  if (/\.(?:cmd|bat)$/i.test(executable)) throw new Error("Use the native Claude executable, not a shell command file.");
  const claudeVersion = verifyClaudeVersion(executable, runVersion);
  // Reject host-managed routing before authentication or opening a gateway.
  buildCoworkClaudeEnvironment({ env: {} }, env);
  const controller = new AbortController();
  let session, directory, child, interrupted, forceTimer, closing;
  const closeSession = () => session ? closing ||= Promise.resolve().then(() => session.close()) : Promise.resolve();
  const interrupt = signal => {
    interrupted ||= signal;
    controller.abort(new Error("Cowork session cancelled locally."));
    child?.kill(signal);
    closeSession().catch(() => {}); // The awaited cleanup below reports this error.
    if (child && !forceTimer) {
      forceTimer = setTimeout(() => child?.kill("SIGKILL"), 5000);
      forceTimer.unref?.();
    }
  };
  const onInterrupt = () => interrupt("SIGINT");
  const onTerminate = () => interrupt("SIGTERM");
  signals.on("SIGINT", onInterrupt);
  signals.on("SIGTERM", onTerminate);
  try {
    session = await openSession({ model, ...(effort !== undefined ? { effort } : {}), signal: controller.signal });
    controller.signal.throwIfAborted();
    if (session.model !== model && !(session.route?.upstreamId === model && session.route.publicId === session.model)) throw new Error("Cowork opened a different model route than the one explicitly selected.");
    if (effort !== undefined && session.capabilities?.clientEffort !== effort) throw new Error("Cowork opened a different effort than the one explicitly selected.");
    if (session.capabilities?.experimentalTrial) warn("Experimental Cowork trial: cloud-tool isolation is unverified. Claude's local tool permissions do not control Cowork's cloud tools.");
    directory = makeSessionDirectory();
    const settingsFile = path.join(directory, "settings.json");
    const settings = buildCoworkClaudeSettings(session);
    writeSettings(settingsFile, settings);
    const childEnv = buildCoworkClaudeEnvironment(settings, env);
    // Keep user/project permission settings and managed policy in force. Only
    // the session overlay supplies routing; no permanent client file is edited.
    child = spawnImpl(executable, [...args, "--model", session.model, "--settings", settingsFile], {
      cwd, env: childEnv, windowsHide: true, stdio: "inherit", shell: false
    });
    const [exitCode, signal] = await once(child, "close");
    const printMode = args.some(arg => /^(?:-p|--print)(?:=|$)/.test(arg));
    const informationOnly = args.some(arg => ["--help", "-h", "--version", "-v"].includes(arg));
    if (exitCode === 0 && !interrupted && printMode && !informationOnly && session.stats?.requests === 0) {
      throw Object.assign(new Error("ROUTE_NOT_USED: Claude exited successfully without sending a request through this Cowork gateway. Check managed policy and active provider settings; this session is not verified."), { code: "ROUTE_NOT_USED" });
    }
    return { exitCode: interrupted === "SIGINT" ? 130 : interrupted ? 143 : exitCode ?? 1, signal: signal || interrupted, stats: session.stats, claudeVersion };
  } catch (error) {
    if (interrupted && controller.signal.aborted) return { exitCode: interrupted === "SIGINT" ? 130 : 143, signal: interrupted, stats: session?.stats, claudeVersion };
    throw error;
  } finally {
    signals.removeListener("SIGINT", onInterrupt);
    signals.removeListener("SIGTERM", onTerminate);
    if (forceTimer) clearTimeout(forceTimer);
    try {
      await closeSession();
    } finally {
      if (directory) {
        const directoryStat = fs.lstatSync(directory);
        if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error("Cowork session directory changed unexpectedly; refusing cleanup through a link.");
        // Delete only the settings file created by this invocation. Unexpected files
        // make rmdir fail rather than recursively deleting unrecognized data.
        const file = path.join(directory, "settings.json");
        if (fs.existsSync(file)) fs.unlinkSync(file);
        fs.rmdirSync(directory);
      }
      if (interrupted) warn("Cowork disconnected locally. A remote task may still be running unless the gateway confirmed its cancellation.");
    }
  }
}
