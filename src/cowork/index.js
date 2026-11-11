import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { configDir } from "../shared/paths.js";
import { authenticate, createAuthSession } from "./auth.js";
import { createCoworkTransport, COWORK_INVESTIGATION_PROMPT } from "./transport.js";
import { createCoworkGateway } from "./gateway.js";
import { createOperationStore } from "./operations.js";
import { coworkError, requireAuthorizedProfile, requireCoworkRuntime, validateProfile } from "./profile.js";
import { ensurePrivateDirectory, writePrivateJson } from "./private-files.js";

// Observed with Claude Code 2.1.281 against synthetic local requests. These
// headers allow protocol parsing, not signed thinking or native model features.
export const CLAUDE_BETAS = Object.freeze([
  "claude-code-20250219", "interleaved-thinking-2025-05-14",
  "mid-conversation-system-2026-04-07", "effort-2025-11-24"
]);

export function coworkDirectory() {
  if (process.env.AERIAL_COWORK_CONFIG_DIR?.trim()) return path.resolve(process.env.AERIAL_COWORK_CONFIG_DIR);
  if (process.env.AERIAL_CONFIG_DIR?.trim()) return path.join(configDir(), "cowork");
  return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "aerial", "cowork");
}

function readProfile(directory) {
  const file = path.join(directory, "profile.json");
  let value;
  try { value = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) {
    throw coworkError("PROFILE_REQUIRED", error.code === "ENOENT"
      ? "Configure a Cowork protocol profile from authorized-session evidence: aerial cowork configure --profile <file>. See docs/usage.md."
      : "Cowork profile is unreadable or invalid JSON. Correct it before continuing.", { statusCode: 503 });
  }
  return validateProfile({ ...value, accountFile: path.join(directory, "account.json") });
}

export function acquireProfileLock(directory) {
  ensurePrivateDirectory(directory);
  const file = path.join(directory, "profile.lock");
  const marker = { pid: process.pid, nonce: randomUUID(), startedAt: new Date().toISOString() };
  let descriptor;
  try { descriptor = fs.openSync(file, "wx", 0o600); }
  catch (error) {
    if (error.code === "EEXIST") throw coworkError("PROFILE_IN_USE", "Cowork profile is locked. Close its existing session. After a crash, inspect the lock and confirm its process has exited before recovering it; it is never stolen automatically.", { statusCode: 409 });
    throw error;
  }
  try { fs.writeFileSync(descriptor, JSON.stringify(marker)); fs.fsyncSync(descriptor); }
  catch (error) { fs.closeSync(descriptor); fs.unlinkSync(file); throw error; }
  fs.closeSync(descriptor);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    let current;
    try { current = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    if (current.nonce !== marker.nonce) throw coworkError("PROFILE_LOCK_CHANGED", "Cowork lock ownership changed; the replacement lock was preserved.");
    fs.unlinkSync(file);
  };
}

export function configureCowork({ file, directory = coworkDirectory() } = {}) {
  if (!file) throw coworkError("INVALID_PROFILE", "Supply a protocol profile JSON file.", { statusCode: 400 });
  let input;
  try {
    const source = path.resolve(file);
    if (fs.statSync(source).size > 64 * 1024) throw new Error("Profile too large");
    input = JSON.parse(fs.readFileSync(source, "utf8"));
  } catch { throw coworkError("INVALID_PROFILE", "The protocol profile must be readable JSON within 64 KiB.", { statusCode: 400 }); }
  const profile = validateProfile({ ...input, accountFile: path.join(directory, "account.json") });
  requireAuthorizedProfile(profile);
  // Persist an explicit allowlist. An imported diagnostic document must never
  // accidentally write bearer tokens or arbitrary fields into the profile.
  const saved = {
    version: 1, origin: profile.origin, clientId: profile.clientId,
    resourceId: profile.resourceId, scope: profile.scope,
    authorityHost: profile.authorityHost, tenantId: profile.tenantId,
    evidence: { source: profile.evidence.source, observedAt: profile.evidence.observedAt },
    capabilities: {
      connectorsDisabled: profile.capabilities.connectorsDisabled,
      completion: profile.capabilities.completion,
      eventCorrelation: profile.capabilities.eventCorrelation,
      verifiedEfforts: profile.capabilities.verifiedEfforts
    }
  };
  const release = acquireProfileLock(directory);
  try {
    const target = path.join(directory, "profile.json");
    if (fs.existsSync(target)) {
      const old = readProfile(directory);
      if (old.clientId !== saved.clientId || old.resourceId !== saved.resourceId || old.origin !== saved.origin) {
        throw coworkError("PROFILE_CHANGED", "Use a separate AERIAL_COWORK_CONFIG_DIR for a different client, resource, or origin; the current account and recovery records were preserved.", { statusCode: 409 });
      }
    }
    writePrivateJson(target, saved);
    return { ok: true, profileFile: target, inferenceReady: isVerified(profile) };
  } finally { release(); }
}

function isVerified(profile) {
  try { validateProfile(profile, { requireLive: true }); return Boolean(clientEffort(profile)); }
  catch { return false; }
}

function clientEffort(profile) {
  return ["low", "medium", "high", "xhigh"].find(value => profile.capabilities.verifiedEfforts.includes(value));
}

export function publicModels(models) {
  return models.map(model => {
    let slug = model.displayName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (/anthropic|claude/i.test(`${model.provider} ${model.displayName}`) && !slug.includes("claude")) slug = `claude-${slug}`;
    const suffix = createHash("sha256").update(model.upstreamId).digest("hex").slice(0, 8);
    return { ...model, publicId: `cowork/${slug || "model"}-${suffix}` };
  });
}

export function selectCoworkModel(models, selected) {
  if (!selected) throw coworkError("MODEL_REQUIRED", "Choose an exact Opus model from aerial cowork models and pass --model <id>.", { statusCode: 400 });
  const matches = models.filter(entry => entry.publicId === selected || entry.upstreamId === selected);
  if (matches.length !== 1) throw coworkError("MODEL_UNAVAILABLE", "The selected Cowork model is not uniquely available in the current account catalog; no fallback was used.", { statusCode: 400 });
  const route = matches[0];
  if (!/\bopus\b/i.test(route.displayName) || !/claude|anthropic/i.test(`${route.displayName} ${route.provider}`)) {
    throw coworkError("MODEL_UNSUPPORTED", "This local trial is limited to an explicitly selected Claude Opus route.", { statusCode: 400 });
  }
  return route;
}

export async function authenticateCowork({ interactive = true, origin, directory = coworkDirectory(), signal } = {}) {
  requireCoworkRuntime();
  const release = acquireProfileLock(directory);
  try {
    const profile = readProfile(directory);
    if (origin && new URL(origin).origin !== profile.origin) throw coworkError("PROFILE_CHANGED", "The supplied origin differs from the recorded authorized-session evidence.", { statusCode: 400 });
    const result = await authenticate(profile, { interactive, signal });
    const auth = createAuthSession({ profile });
    try {
      const models = await createCoworkTransport({ profile, auth }).models({ signal });
      return { ok: true, ...result, modelCount: models.length, inferenceReady: isVerified(profile) };
    } finally { await auth.close(); }
  } finally { release(); }
}

export async function listCoworkModels({ directory = coworkDirectory(), signal } = {}) {
  requireCoworkRuntime();
  const release = acquireProfileLock(directory);
  let auth;
  try {
    const profile = readProfile(directory);
    auth = createAuthSession({ profile });
    return publicModels(await createCoworkTransport({ profile, auth }).models({ signal }));
  } finally { try { await auth?.close(); } finally { release(); } }
}

export async function inspectCowork({ directory = coworkDirectory(), signal } = {}) {
  let release, auth;
  try {
    requireCoworkRuntime();
    release = acquireProfileLock(directory);
    const profile = readProfile(directory);
    auth = createAuthSession({ profile });
    const models = publicModels(await createCoworkTransport({ profile, auth }).models({ signal }));
    const ready = isVerified(profile);
    return { ok: ready, status: ready ? "ready" : "protocol_unverified", authentication: "verified", catalog: "verified", inferenceReady: ready, models };
  } catch (error) {
    return { ok: false, status: error.code || "COWORK_ERROR", error: error.message, inferenceReady: false };
  } finally { try { await auth?.close(); } finally { release?.(); } }
}

function identityDirectory(directory, identity) {
  const identityKey = createHash("sha256").update(JSON.stringify({ tenantId: identity.tenantId.toLowerCase(), objectId: identity.objectId.toLowerCase() })).digest("hex");
  return path.join(directory, "operations", identityKey);
}

export async function probeCowork({ model, directory = coworkDirectory(), signal } = {}) {
  requireCoworkRuntime();
  const release = acquireProfileLock(directory);
  let auth, store, record;
  const observations = [];
  try {
    const profile = readProfile(directory);
    auth = createAuthSession({ profile });
    const models = publicModels(await createCoworkTransport({ profile, auth }).models({ signal }));
    const route = selectCoworkModel(models, model);
    const lease = await auth.getToken({ signal });
    const operationDirectory = ensurePrivateDirectory(identityDirectory(directory, lease.identity));
    store = createOperationStore({ directory: operationDirectory, route });
    // Each explicit probe command is a new, intentional synthetic operation.
    // It is not a retry of an interrupted client request.
    ({ record } = store.claim({ body: { model: route.publicId, messages: [{ role: "user", content: COWORK_INVESTIGATION_PROMPT }] }, idempotencyKey: randomUUID() }));
    const result = await createCoworkTransport({ profile, auth, route }).investigateText({
      signal, operationId: record.id,
      onPhase: (phase, ids) => store.phase(record, phase, ids),
      onEvent: observation => { if (observations.length < 200) observations.push(observation); }
    });
    store.succeed(record, { type: "investigation", expectedTextMatched: result.expectedTextMatched });
    return { ok: result.expectedTextMatched, operationId: record.id, model: route.publicId,
      upstreamModel: route.upstreamId, ...result, observations, protocolPromoted: false };
  } catch (error) {
    if (store && record) store.fail(record, error);
    return { ok: false, code: error.code || "COWORK_ERROR", error: error.message,
      operationId: record?.id, observations, protocolPromoted: false };
  } finally { try { await auth?.close(); } finally { release(); } }
}

function operationStores(directory) {
  const parent = path.join(directory, "operations");
  if (!fs.existsSync(parent)) return [];
  if (fs.lstatSync(parent).isSymbolicLink()) throw coworkError("OPERATION_STORE_INVALID", "Cowork operation storage must not be a link.");
  return fs.readdirSync(parent, { withFileTypes: true }).filter(entry => /^[a-f0-9]{64}$/.test(entry.name)).map(entry => {
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw coworkError("OPERATION_STORE_INVALID", "Cowork identity storage must be a real directory.");
    return createOperationStore({ directory: path.join(parent, entry.name), route: {} });
  });
}

export function listCoworkOperations({ directory = coworkDirectory() } = {}) {
  const release = acquireProfileLock(directory);
  try { return operationStores(directory).flatMap(store => store.list()); }
  finally { release(); }
}

export function releaseCoworkOperation({ id, directory = coworkDirectory() } = {}) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id || "")) throw coworkError("INVALID_REQUEST", "Supply an operation ID from aerial cowork operations.", { statusCode: 400 });
  const release = acquireProfileLock(directory);
  try {
    const matches = operationStores(directory).filter(store => store.list().some(record => record.id === id));
    if (matches.length !== 1) throw coworkError("OPERATION_NOT_FOUND", "The operation was not uniquely found.", { statusCode: 404 });
    matches[0].release(id);
    return { ok: true, id };
  } finally { release(); }
}

export async function openCoworkSession({ model, directory = coworkDirectory(), signal } = {}, dependencies = {}) {
  const runtime = dependencies.checkRuntime || requireCoworkRuntime;
  runtime();
  signal?.throwIfAborted();
  const release = (dependencies.acquireLock || acquireProfileLock)(directory);
  let auth, gateway;
  let closing;
  const close = () => closing ||= (async () => {
    try { await gateway?.close(); }
    finally { try { await auth?.close(); } finally { release(); } }
  })();
  try {
    const profile = (dependencies.readProfile || readProfile)(directory);
    validateProfile(profile, { requireLive: true });
    auth = (dependencies.authFactory || createAuthSession)({ profile });
    const transportFactory = dependencies.transportFactory || createCoworkTransport;
    const models = publicModels(await transportFactory({ profile, auth }).models({ signal }));
    signal?.throwIfAborted();
    const route = selectCoworkModel(models, model);
    const transport = transportFactory({ profile, auth, route });
    const capabilities = {
      allowedBetas: [...CLAUDE_BETAS], supportedEfforts: profile.capabilities.verifiedEfforts,
      thinkingMode: "disabled", mode: "cowork-emulated", streaming: "buffered-completion", usage: "estimated"
    };
    if (!capabilities.supportedEfforts.length) throw coworkError("UNSUPPORTED_CAPABILITY", "The installed Claude client sends effort. Verify at least one Cowork effort value before starting the trial.", { statusCode: 400 });
    capabilities.clientEffort = clientEffort(profile);
    if (!capabilities.clientEffort) throw coworkError("UNSUPPORTED_CAPABILITY", "No verified effort can be saved by the supported Claude client.", { statusCode: 400 });
    const lease = await auth.getToken({ signal });
    signal?.throwIfAborted();
    // Account switching must not reuse another identity's results or retry keys.
    const operationDirectory = identityDirectory(directory, lease.identity);
    (dependencies.ensureDirectory || ensurePrivateDirectory)(operationDirectory);
    const apiKey = randomBytes(32).toString("base64url");
    gateway = (dependencies.gatewayFactory || createCoworkGateway)({ key: apiKey, route, capabilities,
      execute: transport.execute, operationDirectory, timeoutMs: 900_000 });
    const baseUrl = await gateway.listen(0);
    signal?.throwIfAborted();
    return { baseUrl, apiKey, model: route.publicId, route, capabilities, stats: gateway.stats, close };
  } catch (error) { await close(); throw error; }
}
