import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { configDir } from "../shared/paths.js";
import { authenticate, createAuthSession } from "./auth.js";
import { createCoworkTransport, COWORK_INVESTIGATION_PROMPT, validateInvestigationEffort } from "./transport.js";
import { createCoworkGateway } from "./gateway.js";
import { createOperationStore } from "./operations.js";
import { coworkError, isSupportedCoworkModel, modelSupportedEfforts, modelVerifiedEfforts, requireAuthorizedProfile, requireCoworkRuntime, selectCoworkEffort, validateProfile } from "./profile.js";
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
  // Keep the default outside AppData so packaged hosts and normal shells share it.
  return path.join(os.homedir(), ".aerial", "cowork");
}

export function readCoworkProfile(directory) {
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

const readProfile = readCoworkProfile;

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

export function profileForStorage(profile) {
  // Persist an explicit allowlist. An imported diagnostic document must never
  // accidentally write bearer tokens or arbitrary fields into the profile.
  return {
    version: 1, origin: profile.origin, clientId: profile.clientId,
    resourceId: profile.resourceId, scope: profile.scope,
    authorityHost: profile.authorityHost, tenantId: profile.tenantId,
    evidence: { source: profile.evidence.source, observedAt: profile.evidence.observedAt },
    capabilities: {
      connectorsDisabled: profile.capabilities.connectorsDisabled,
      completion: profile.capabilities.completion,
      eventCorrelation: profile.capabilities.eventCorrelation,
      verifiedEfforts: profile.capabilities.verifiedEfforts,
      ...(profile.capabilities.verifiedModelEfforts !== undefined ? { verifiedModelEfforts: profile.capabilities.verifiedModelEfforts } : {}),
      ...(profile.capabilities.verifiedModelConversationReuse !== undefined ? { verifiedModelConversationReuse: profile.capabilities.verifiedModelConversationReuse } : {})
    },
    ...(profile.localTrial ? { localTrial: profile.localTrial } : {})
  };
}

export function configureCowork({ file, directory = coworkDirectory(), allowUnverifiedCloudTools = false } = {}) {
  if (!file) throw coworkError("INVALID_PROFILE", "Supply a protocol profile JSON file.", { statusCode: 400 });
  if (typeof allowUnverifiedCloudTools !== "boolean") throw coworkError("INVALID_PROFILE", "allowUnverifiedCloudTools must be an explicit boolean option.", { statusCode: 400 });
  let input;
  try {
    const source = path.resolve(file);
    if (fs.statSync(source).size > 64 * 1024) throw new Error("Profile too large");
    input = JSON.parse(fs.readFileSync(source, "utf8"));
  } catch { throw coworkError("INVALID_PROFILE", "The protocol profile must be readable JSON within 64 KiB.", { statusCode: 400 }); }
  // An imported profile cannot opt the user into a local risk policy. Only the
  // explicit configure option enables it; ordinary reconfiguration is strict.
  const localTrial = allowUnverifiedCloudTools ? { allowUnverifiedCloudTools: true } : undefined;
  const profile = validateProfile({ ...input, localTrial, accountFile: path.join(directory, "account.json") });
  requireAuthorizedProfile(profile);
  const saved = profileForStorage(profile);
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
    return { ok: true, profileFile: target, inferenceReady: isInferenceReady(profile), ...isolationStatus(profile) };
  } finally { release(); }
}

function isInferenceReady(profile, models) {
  try {
    validateProfile(profile, { requireLive: true });
    return models ? models.some(model => modelSupportedEfforts(profile, model).length > 0)
      : Boolean(profile.capabilities.verifiedEfforts?.length || Object.values(profile.capabilities.verifiedModelEfforts || {}).some(efforts => efforts.length));
  }
  catch { return false; }
}

function isolationStatus(profile) {
  const cloudToolIsolation = profile.capabilities.connectorsDisabled === "verified" ? "verified" : "unverified";
  return { cloudToolIsolation, experimentalTrial: cloudToolIsolation === "unverified" && profile.localTrial?.allowUnverifiedCloudTools === true };
}

export function publicModels(models) {
  return models.map(model => {
    let slug = model.displayName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (/^(anthropic|claude)$/i.test(model.provider) && !slug.includes("claude")) slug = `claude-${slug}`;
    const suffix = createHash("sha256").update(model.upstreamId).digest("hex").slice(0, 8);
    return { ...model, publicId: `cowork/${slug || "model"}-${suffix}` };
  });
}

function verifiedCatalog(profile, models) {
  return publicModels(models).map(model => ({ ...model, supported: isSupportedCoworkModel(model), verifiedEfforts: modelSupportedEfforts(profile, model) }));
}

export function selectCoworkModel(models, selected) {
  if (!selected) throw coworkError("MODEL_REQUIRED", "Choose an exact Anthropic model from aerial cowork models and pass --model <id>.", { statusCode: 400 });
  const matches = models.filter(entry => entry.publicId === selected || entry.upstreamId === selected);
  if (matches.length !== 1) throw coworkError("MODEL_UNAVAILABLE", "The selected Cowork model is not uniquely available in the current account catalog; no fallback was used.", { statusCode: 400 });
  const route = matches[0];
  if (!isSupportedCoworkModel(route)) {
    throw coworkError("MODEL_UNSUPPORTED", "Select an Anthropic Opus, Sonnet or Fable route from the Cowork catalog.", { statusCode: 400 });
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
      return { ok: true, ...result, modelCount: models.length, inferenceReady: isInferenceReady(profile, models), ...isolationStatus(profile) };
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
    return verifiedCatalog(profile, await createCoworkTransport({ profile, auth }).models({ signal }));
  } finally { try { await auth?.close(); } finally { release(); } }
}

export async function inspectCowork({ directory = coworkDirectory(), signal } = {}, dependencies = {}) {
  let release, auth;
  try {
    (dependencies.checkRuntime || requireCoworkRuntime)();
    release = (dependencies.acquireLock || acquireProfileLock)(directory);
    const profile = (dependencies.readProfile || readProfile)(directory);
    auth = (dependencies.authFactory || createAuthSession)({ profile });
    const models = verifiedCatalog(profile, await (dependencies.transportFactory || createCoworkTransport)({ profile, auth }).models({ signal }));
    const ready = isInferenceReady(profile, models);
    const isolation = isolationStatus(profile);
    return { ok: ready, status: ready ? (isolation.experimentalTrial ? "ready_experimental" : "ready") : "protocol_unverified",
      authentication: "verified", catalog: "verified", inferenceReady: ready, ...isolation, models };
  } catch (error) {
    return { ok: false, status: error.code || "COWORK_ERROR", error: error.message, inferenceReady: false };
  } finally { try { await auth?.close(); } finally { release?.(); } }
}

function identityDirectory(directory, identity) {
  const identityKey = createHash("sha256").update(JSON.stringify({ tenantId: identity.tenantId.toLowerCase(), objectId: identity.objectId.toLowerCase() })).digest("hex");
  return path.join(directory, "operations", identityKey);
}

export async function probeCowork({ model, effort, directory = coworkDirectory(), signal } = {}) {
  validateInvestigationEffort(effort);
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
    ({ record } = store.claim({ body: { model: route.publicId, messages: [{ role: "user", content: COWORK_INVESTIGATION_PROMPT }],
      ...(effort !== undefined ? { output_config: { effort } } : {}) }, idempotencyKey: randomUUID() }));
    const result = await createCoworkTransport({ profile, auth, route }).investigateText({
      effort, signal, operationId: record.id,
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

export async function verifyCoworkRoute({ model, effort, directory = coworkDirectory(), signal } = {}, dependencies = {}) {
  if (typeof model !== "string" || !model.trim() || effort === undefined) {
    throw coworkError("INVALID_REQUEST", "Route verification requires an exact model and an explicit effort.", { statusCode: 400 });
  }
  validateInvestigationEffort(effort);
  (dependencies.checkRuntime || requireCoworkRuntime)();
  signal?.throwIfAborted();
  const release = (dependencies.acquireLock || acquireProfileLock)(directory);
  let auth, store, record, route, evidenceFile, result;
  let capabilityRecorded = false;
  try {
    const profile = validateProfile((dependencies.readProfile || readProfile)(directory));
    requireAuthorizedProfile(profile);
    auth = (dependencies.authFactory || createAuthSession)({ profile });
    const transportFactory = dependencies.transportFactory || createCoworkTransport;
    const catalog = publicModels(await transportFactory({ profile, auth }).models({ signal }));
    signal?.throwIfAborted();
    route = selectCoworkModel(catalog, model);
    if (!route.supportedEfforts?.includes(effort)) {
      throw coworkError("UNSUPPORTED_CAPABILITY", "The Cowork catalog does not advertise this effort for the selected model.", { statusCode: 400 });
    }
    const updated = validateProfile({ ...profile, capabilities: { ...profile.capabilities,
      verifiedModelEfforts: { ...profile.capabilities.verifiedModelEfforts,
        [route.upstreamId]: [...new Set([...modelVerifiedEfforts(profile, route), effort])] } } });
    const lease = await auth.getToken({ signal });
    signal?.throwIfAborted();
    const operationDirectory = (dependencies.ensureDirectory || ensurePrivateDirectory)(identityDirectory(directory, lease.identity));
    store = (dependencies.operationStoreFactory || createOperationStore)({ directory: operationDirectory, route });
    // Repeating verification after an unknown submission must not create a new
    // remote operation. The operator can inspect and explicitly release it.
    const claimed = store.claim({ body: { model: route.publicId,
      messages: [{ role: "user", content: COWORK_INVESTIGATION_PROMPT }], output_config: { effort } },
      idempotencyKey: `cowork-route-verification:${route.upstreamId}:${effort}` });
    if (claimed.reused) {
      const error = coworkError("ROUTE_ALREADY_VERIFIED", "This verification operation already completed. Inspect or explicitly release it before running a new verification.", { statusCode: 409 });
      error.operationId = claimed.record?.id;
      throw error;
    }
    record = claimed.record;
    result = await transportFactory({ profile, auth, route }).investigateText({
      effort, signal, operationId: record.id, onPhase: (phase, ids) => store.phase(record, phase, ids)
    });
    const completionConfirmed = result.requestedEffort === effort && result.completionEvidence === "fr-plus-rl-ok"
      && ["request-mid", "request-message-id"].includes(result.correlationEvidence)
      && result.submissionEvidence?.httpStatus === 202;
    if (!completionConfirmed) throw coworkError("ROUTE_VERIFICATION_FAILED", "Cowork verification did not confirm acceptance, completion and request correlation.", { statusCode: 502 });
    const accepted = result.expectedTextMatched === true;
    store.succeed(record, { type: "route-verification", accepted });
    if (!accepted) throw coworkError("ROUTE_VERIFICATION_FAILED", "The fixed Cowork verification did not confirm text, acceptance, completion and request correlation.", { statusCode: 502 });
    signal?.throwIfAborted();
    // Finish authentication cleanup before committing capability evidence.
    // A cleanup failure must leave the previous profile unchanged.
    const completedAuth = auth;
    auth = undefined;
    await completedAuth.close();
    signal?.throwIfAborted();
    const evidence = { version: 1, source: "authorized-session", observedAt: new Date().toISOString(),
      model: route.publicId, upstreamModel: route.upstreamId, effort, accepted: true,
      expectedTextMatched: true, completionEvidence: "fr-plus-rl-ok", correlationEvidence: result.correlationEvidence,
      cloudToolIsolation: isolationStatus(profile).cloudToolIsolation };
    evidenceFile = path.join(path.resolve(directory), `route-verification-${randomUUID()}.json`);
    const writeJson = dependencies.writeJson || writePrivateJson;
    // Each file is replaced atomically. The profile is the commit point and is
    // only updated after its private evidence exists; failed commits remove it.
    writeJson(evidenceFile, evidence);
    writeJson(path.join(directory, "profile.json"), profileForStorage(updated));
    capabilityRecorded = true;
    return { ok: true, accepted: true, model: route.publicId, upstreamModel: route.upstreamId, effort,
      expectedTextMatched: true, completionEvidence: evidence.completionEvidence,
      correlationEvidence: evidence.correlationEvidence, capabilityRecorded, evidenceFile };
  } catch (error) {
    if (evidenceFile && !capabilityRecorded && fs.existsSync(evidenceFile)) fs.unlinkSync(evidenceFile);
    if (store && record) store.fail(record, error);
    return { ok: false, accepted: false, code: error.code || "COWORK_ERROR", error: error.message,
      ...(route ? { model: route.publicId, upstreamModel: route.upstreamId } : {}), effort,
      expectedTextMatched: result?.expectedTextMatched === true, capabilityRecorded: false,
      ...(record?.id || error.operationId ? { operationId: record?.id || error.operationId } : {}) };
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

export async function openCoworkSession({ model, effort, directory = coworkDirectory(), signal, log } = {}, dependencies = {}) {
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
    const models = verifiedCatalog(profile, await transportFactory({ profile, auth }).models({ signal }));
    signal?.throwIfAborted();
    const route = selectCoworkModel(models, model);
    const transport = transportFactory({ profile, auth, route });
    const capabilities = {
      allowedBetas: [...CLAUDE_BETAS], supportedEfforts: modelSupportedEfforts(profile, route),
      conversationReuseVerified: profile.capabilities.verifiedModelConversationReuse?.[route.upstreamId] === true,
      thinkingMode: "disabled", mode: "cowork-emulated", streaming: "buffered-completion", usage: "estimated",
      ...isolationStatus(profile)
    };
    if (!capabilities.supportedEfforts.length) throw coworkError("UNSUPPORTED_CAPABILITY", "The installed Claude client sends effort. Verify at least one Cowork effort value before starting the trial.", { statusCode: 400 });
    capabilities.clientEffort = selectCoworkEffort(profile, route, effort);
    if (!capabilities.clientEffort) throw coworkError("UNSUPPORTED_CAPABILITY", "No verified effort can be saved by the supported Claude client.", { statusCode: 400 });
    const lease = await auth.getToken({ signal });
    signal?.throwIfAborted();
    // Account switching must not reuse another identity's results or retry keys.
    const operationDirectory = identityDirectory(directory, lease.identity);
    (dependencies.ensureDirectory || ensurePrivateDirectory)(operationDirectory);
    const apiKey = randomBytes(32).toString("base64url");
    gateway = (dependencies.gatewayFactory || createCoworkGateway)({ key: apiKey, route, capabilities,
      execute: transport.execute, operationDirectory, timeoutMs: 900_000, ...(log ? { log } : {}) });
    const baseUrl = await gateway.listen(0);
    signal?.throwIfAborted();
    return { baseUrl, apiKey, model: route.publicId, route, catalog: models, capabilities, stats: gateway.stats, close };
  } catch (error) {
    try { await close(); }
    catch (cleanupError) { cleanupError.coworkCleanupFailed = true; throw cleanupError; }
    throw error;
  }
}
