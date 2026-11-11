import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { acquireProfileLock, coworkDirectory, publicModels, selectCoworkModel, readCoworkProfile, profileForStorage } from "../src/cowork/index.js";
import { createAuthSession } from "../src/cowork/auth.js";
import { createCoworkTransport, COWORK_CONVERSATION_PROBES, validateInvestigationEffort } from "../src/cowork/transport.js";
import { createOperationStore } from "../src/cowork/operations.js";
import { coworkError, requireCoworkRuntime, selectCoworkEffort, validateProfile } from "../src/cowork/profile.js";
import { ensurePrivateDirectory, writePrivateJson } from "../src/cowork/private-files.js";
import { createHash } from "node:crypto";

// This explicit live helper has no retry loop. Both fixed probes are journaled
// separately; an interrupted run remains blocked until operations are reviewed.
export async function verifyCoworkConversationReuse({ model, effort = "medium", directory = coworkDirectory(), signal } = {}, dependencies = {}) {
  if (typeof model !== "string" || !model.trim() || !path.isAbsolute(directory)) throw coworkError("INVALID_REQUEST", "Supply an exact model and absolute profile directory.", { statusCode: 400 });
  validateInvestigationEffort(effort);
  (dependencies.checkRuntime || requireCoworkRuntime)();
  signal?.throwIfAborted();
  const release = (dependencies.acquireLock || acquireProfileLock)(directory);
  let auth, store, record, route, evidenceFile, capabilityRecorded = false;
  const results = [];
  const observations = [];
  try {
    const profile = validateProfile((dependencies.readProfile || readCoworkProfile)(directory), { requireLive: true });
    auth = (dependencies.authFactory || createAuthSession)({ profile });
    const transportFactory = dependencies.transportFactory || createCoworkTransport;
    route = selectCoworkModel(publicModels(await transportFactory({ profile, auth }).models({ signal })), model);
    selectCoworkEffort(profile, route, effort);
    const lease = await auth.getToken({ signal });
    signal?.throwIfAborted();
    const owner = createHash("sha256").update(JSON.stringify({ tenantId: lease.identity.tenantId.toLowerCase(), objectId: lease.identity.objectId.toLowerCase() })).digest("hex");
    const operationDirectory = (dependencies.ensureDirectory || ensurePrivateDirectory)(path.join(directory, "operations", owner));
    store = (dependencies.operationStoreFactory || createOperationStore)({ directory: operationDirectory, route, conversationReuse: true });
    const transport = transportFactory({ profile, auth, route });
    const sessionId = `cowork-conversation-verification-v2:${route.upstreamId}:${effort}`;
    for (let turn = 0; turn < COWORK_CONVERSATION_PROBES.length; turn++) {
      ({ record } = store.claim({ body: { model: route.publicId,
        messages: [{ role: "user", content: COWORK_CONVERSATION_PROBES[turn].prompt }], output_config: { effort } },
        sessionId, idempotencyKey: `${sessionId}:${turn}` }));
      const result = await transport.investigateConversationTurn({ turn, conversationKey: record.conversationKey,
        effort, signal, operationId: record.id, onPhase: (phase, ids) => store.phase(record, phase, ids),
        onEvent: event => {
          if (observations.length >= 200) return;
          // Keep lifecycle/equality evidence only. No upstream values, unknown
          // field names, request IDs, response text or authentication metadata.
          const item = { turn, kind: ["submission_response", "submission_body", "message", "session", "cs", "tk", "q", "dx", "fr", "rl", "error", "err"].includes(event.kind) ? event.kind : "other" };
          if (Number.isSafeInteger(event.httpStatus) && event.httpStatus >= 100 && event.httpStatus <= 599) item.httpStatus = event.httpStatus;
          if (["ok", "started", "running", "queued", "error", "failed", "cancelled", "canceled"].includes(event.status)) item.status = event.status;
          if (event.correlation) item.correlation = Object.fromEntries(["conversationId", "requestMessageId", "messageId", "mid", "eid"].map(name => [name,
            Object.fromEntries(["present", "matchesConversationId", "matchesMessageId"].filter(field => typeof event.correlation[name]?.[field] === "boolean").map(field => [field, event.correlation[name][field]]))]));
          observations.push(item);
        } });
      const accepted = result.expectedTextMatched === true && result.requestedEffort === effort
        && result.responseNonceVerified === true
        && result.completionEvidence === "fr-plus-rl-ok" && ["request-mid", "request-message-id"].includes(result.correlationEvidence)
        && result.submissionEvidence?.httpStatus === 202;
      store.succeed(record, { type: "conversation-verification", accepted });
      results.push({ ...result, operationId: record.id });
      if (!accepted) throw coworkError("CONVERSATION_VERIFICATION_FAILED", "Cowork did not confirm the fixed conversation probe and request correlation.");
    }
    if (results[0].conversationId !== results[1].conversationId || results[0].messageId === results[1].messageId
      || typeof results[0].conversationId !== "string" || typeof results[0].messageId !== "string" || typeof results[1].messageId !== "string") {
      throw coworkError("CONVERSATION_VERIFICATION_FAILED", "Cowork probes did not share one conversation with distinct request IDs.");
    }
    signal?.throwIfAborted();
    const completedAuth = auth; auth = undefined; await completedAuth.close();
    signal?.throwIfAborted();
    const updated = validateProfile({ ...profile, capabilities: { ...profile.capabilities,
      verifiedModelConversationReuse: { ...profile.capabilities.verifiedModelConversationReuse, [route.upstreamId]: true } } });
    const evidence = { version: 2, source: "authorized-session", kind: "fixed-two-turn-conversation-reuse", observedAt: new Date().toISOString(),
      model: route.publicId, upstreamModel: route.upstreamId, effort, accepted: true,
      sameConversation: true, distinctMessageIds: true, contextMarkerRecalled: true, nonceVerified: true,
      observations,
      turns: results.map(result => ({ operationId: result.operationId, turn: result.turn, expectedTextMatched: true,
        completionEvidence: result.completionEvidence, correlationEvidence: result.correlationEvidence, nonceVerified: true, acceptedHttpStatus: 202 })) };
    evidenceFile = path.join(directory, `conversation-verification-${randomUUID()}.json`);
    const writeJson = dependencies.writeJson || writePrivateJson;
    writeJson(evidenceFile, evidence);
    writeJson(path.join(directory, "profile.json"), profileForStorage(updated));
    capabilityRecorded = true;
    return { ok: true, model: route.publicId, upstreamModel: route.upstreamId, effort, capabilityRecorded, evidenceFile,
      sameConversation: true, distinctMessageIds: true, contextMarkerRecalled: true, nonceVerified: true };
  } catch (error) {
    if (evidenceFile && !capabilityRecorded && fs.existsSync(evidenceFile)) fs.unlinkSync(evidenceFile);
    if (store && record) store.fail(record, error);
    return { ok: false, code: error.code || "COWORK_ERROR", capabilityRecorded: false,
      ...(route ? { model: route.publicId, upstreamModel: route.upstreamId } : {}), effort,
      operationId: error.operationId || record?.id, completedTurns: results.length, observations };
  } finally { try { await auth?.close(); } finally { release(); } }
}

export function parseConversationVerificationArguments(args) {
  const options = {};
  const names = { "--profile-dir": "directory", "--model": "model", "--effort": "effort" };
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--help" && args.length === 1) return { help: true };
    const name = names[args[index]], value = args[++index];
    if (!name || !value || value.startsWith("--") || Object.hasOwn(options, name)) throw coworkError("INVALID_REQUEST", "Invalid conversation verification arguments.");
    options[name] = value;
  }
  if (!options.model) throw coworkError("INVALID_REQUEST", "An exact --model is required.");
  return options;
}

async function main() {
  const options = parseConversationVerificationArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write("Usage: node scripts/verify-cowork-conversation.mjs --model <exact ID> [--profile-dir <absolute directory>] [--effort medium]\nSubmits two fixed live probes and records model-specific reuse evidence only after both pass. No automatic retries.\n");
    return;
  }
  const result = await verifyCoworkConversationReuse({ ...options, signal: AbortSignal.timeout(900_000) });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write(`${JSON.stringify({ ok: false, code: error.code || "COWORK_ERROR", capabilityRecorded: false })}\n`); process.exitCode = 1; });
}
