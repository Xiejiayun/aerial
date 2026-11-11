import { randomUUID } from "node:crypto";
import { coworkError, requireAuthorizedProfile, validateProfile } from "./profile.js";
import { eventFieldTypes, readCoworkCompletion } from "./events.js";

export const COWORK_INVESTIGATION_PROMPT = "Protocol connectivity check. Reply with exactly COWORK_PROTOCOL_TEXT_OK as plain text. Do not call tools, open files, access connected services, or take any other action.";

export function validateInvestigationEffort(effort) {
  if (effort !== undefined && !["low", "medium", "high", "xhigh", "max"].includes(effort)) {
    throw coworkError("UNSUPPORTED_CAPABILITY", "Cowork text probe effort must be low, medium, high, xhigh or max.", { statusCode: 400 });
  }
}

async function boundedJson(response, { maxBytes = 2 * 1024 * 1024, signal } = {}) {
  if (!response.body) throw coworkError("PROTOCOL_CHANGED", "Cowork returned no JSON response body.");
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  const cancel = () => { reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    signal?.throwIfAborted();
    while (true) {
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      length += value.length;
      if (length > maxBytes) throw coworkError("PROTOCOL_CHANGED", "Cowork JSON response exceeded its size limit.");
      chunks.push(value);
    }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { throw coworkError("PROTOCOL_CHANGED", "Cowork returned invalid JSON."); }
  } finally {
    signal?.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function upstreamError(status, submitted = false) {
  const code = status === 401 ? "AUTH_REQUIRED" : status === 403 ? "AUTH_DENIED" : "UPSTREAM_REJECTED";
  return coworkError(code, `Cowork upstream returned HTTP ${status}.`, { statusCode: status >= 400 && status < 500 ? status : 502, submitted });
}

function headersFor(lease, conversationId, route, effort) {
  const config = [];
  if (route) config.push(`model=${route.upstreamId}`);
  if (effort) config.push(`reasoningEffort=${effort}`);
  return {
    authorization: `Bearer ${lease.bearer}`, "content-type": "application/json", accept: "application/json",
    origin: "https://copilot.cloud.microsoft", referer: "https://copilot.cloud.microsoft/",
    "x-tenant-id": lease.identity.tenantId, "x-user-id": lease.identity.objectId,
    "x-conversation-id": conversationId, "x-request-id": randomUUID(),
    "x-copilot-timezone": Intl.DateTimeFormat().resolvedOptions().timeZone,
    ...(config.length ? { "x-container-config": config.join(";") } : {})
  };
}

// Read-only protocol discovery can validate a candidate WAM configuration
// before it has authorized-session evidence. This function cannot submit work.
export async function readCoworkModelCatalog({ profile: input, lease, signal, fetchImpl = fetch } = {}) {
  const profile = validateProfile(input);
  const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000);
  combined.throwIfAborted();
  const conversationId = `${lease.identity.tenantId}:${lease.identity.objectId}:${randomUUID()}`;
  let response;
  try {
    response = await fetchImpl(`${profile.origin}/v1/models`, { method: "GET", headers: headersFor(lease, conversationId), signal: combined, redirect: "error" });
  } catch (error) {
    combined.throwIfAborted();
    throw coworkError("UPSTREAM_UNAVAILABLE", "Unable to read the Cowork model directory.");
  }
  if (!response.ok) { await response.body?.cancel(); throw upstreamError(response.status); }
  const payload = await boundedJson(response, { signal: combined });
  if (!Array.isArray(payload?.models)) throw coworkError("PROTOCOL_CHANGED", "Cowork model directory did not contain a models array.");
  const seen = new Set();
  return payload.models.map((item) => {
    if (!item || typeof item.id !== "string" || !/^[A-Za-z0-9._:/-]{1,200}$/.test(item.id)
      || typeof item.display_name !== "string" || !item.display_name || typeof item.provider !== "string"
      || seen.has(item.id)) throw coworkError("PROTOCOL_CHANGED", "Cowork returned an invalid or duplicate model entry.");
    seen.add(item.id);
    return { upstreamId: item.id, displayName: item.display_name, provider: item.provider };
  });
}

export function createCoworkTransport({ profile: input, auth, route, fetchImpl = fetch } = {}) {
  const profile = validateProfile(input);
  requireAuthorizedProfile(profile);
  if (!auth || typeof auth.getToken !== "function") throw coworkError("INVALID_PROFILE", "Cowork transport requires an authentication session.", { statusCode: 400 });
  const models = async ({ signal } = {}) => {
    const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000);
    const lease = await auth.getToken({ signal: combined });
    return readCoworkModelCatalog({ profile, lease, signal: combined, fetchImpl });
  };
  const executeCore = async ({ prompt, effort, signal, operationId, onPhase = async () => {}, onEvent } = {}, investigation = false) => {
    if (!investigation) validateProfile(profile, { requireLive: true });
    if (!route || typeof route.upstreamId !== "string" || !/^[A-Za-z0-9._:/-]{1,200}$/.test(route.upstreamId)) throw coworkError("MODEL_UNAVAILABLE", "Choose an exact model ID from the verified Cowork directory.", { statusCode: 400 });
    if (typeof prompt !== "string" || !prompt || Buffer.byteLength(prompt) > 4 * 1024 * 1024) throw coworkError("INVALID_REQUEST", "Cowork prompt must be nonempty text within the 4 MiB limit.", { statusCode: 400 });
    if (investigation) validateInvestigationEffort(effort);
    else if (effort !== undefined && !profile.capabilities.verifiedEfforts.includes(effort)) throw coworkError("UNSUPPORTED_CAPABILITY", "This Cowork effort value has not been verified for the configured protocol.", { statusCode: 400 });
    const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(900_000)]) : AbortSignal.timeout(900_000);
    const lease = await auth.getToken({ signal: combined });
    combined.throwIfAborted();
    const conversationId = `${lease.identity.tenantId}:${lease.identity.objectId}:${randomUUID()}`;
    const messageId = randomUUID();
    const context = { operationId, conversationId, messageId };
    const headers = headersFor(lease, conversationId, route, effort);
    let subscription;
    let submitted = false;
    try {
      await onPhase("SUBSCRIBING", context);
      subscription = await fetchImpl(`${profile.origin}/v1/subscribe?conversationId=${encodeURIComponent(conversationId)}&_nonce=${randomUUID()}`, {
        headers: { ...headers, accept: "text/event-stream" }, signal: combined, redirect: "error"
      });
      if (!subscription.ok) throw upstreamError(subscription.status);
      if (!subscription.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) throw coworkError("PROTOCOL_CHANGED", "Cowork subscription did not return an SSE stream.");
      combined.throwIfAborted();
      // The owner persists this transition before the only inference POST.
      await onPhase("SUBMITTING", context);
      combined.throwIfAborted();
      submitted = true;
      const response = await fetchImpl(`${profile.origin}/v1/messages`, {
        method: "POST", headers, signal: combined, redirect: "error",
        body: JSON.stringify({ content: [{ type: "text", text: prompt }], conversationId, messageId, queue: true, role: "user",
          connectorsConfig: { connectors: [], include_defaults: false, packages: [] } })
      });
      await onEvent?.({ kind: "submission_response", httpStatus: response.status });
      if (!response.ok) { await response.body?.cancel(); throw upstreamError(response.status, true); }
      const accepted = await boundedJson(response, { maxBytes: 64 * 1024, signal: combined });
      const submissionEvidence = { httpStatus: response.status, fieldTypes: eventFieldTypes(accepted) };
      await onEvent?.({ kind: "submission_body", ...submissionEvidence });
      if (response.status !== 202 || accepted?.status !== "accepted"
        || (accepted.conversationId !== undefined && accepted.conversationId !== conversationId)
        || (accepted.messageId !== undefined && accepted.messageId !== messageId)) throw coworkError("SUBMISSION_UNKNOWN", "Cowork submission acceptance could not be verified; it will not be resubmitted.", { submitted: true });
      await onPhase("ACCEPTED", context);
      const result = await readCoworkCompletion(subscription, { signal: combined, conversationId, messageId, onEvent });
      await onPhase("RESULT_RECEIVED", context);
      return { ...result, conversationId, messageId, submissionEvidence };
    } catch (error) {
      if (error?.code && typeof error.submitted === "boolean") {
        if (submitted) error.submitted = true;
        throw error;
      }
      if (combined.aborted) throw coworkError(submitted ? "SUBMISSION_UNKNOWN" : "LOCAL_TIMEOUT", submitted
        ? "Cowork disconnected or timed out after submission; the remote task may still be running."
        : "Cowork was canceled or timed out before submission.", { submitted, statusCode: 504 });
      throw coworkError(submitted ? "SUBMISSION_UNKNOWN" : "UPSTREAM_UNAVAILABLE", submitted
        ? "Cowork submission or result delivery failed; it will not be resubmitted automatically."
        : "Cowork subscription could not be established.", { submitted });
    } finally {
      if (subscription?.body && !subscription.body.locked) await subscription.body.cancel().catch(() => {});
    }
  };
  const execute = (options) => executeCore(options, false);
  // P0 has its own fixed, text-only request. It cannot run arbitrary client
  // prompts or promote observed protocol behavior to verified capability flags.
  const investigateText = async ({ effort, signal, operationId, onPhase, onEvent } = {}) => {
    const result = await executeCore({ prompt: COWORK_INVESTIGATION_PROMPT, effort, signal, operationId, onPhase, onEvent }, true);
    return {
      investigation: true, expectedTextMatched: result.text.trim() === "COWORK_PROTOCOL_TEXT_OK",
      ...(effort !== undefined ? { requestedEffort: effort } : {}),
      completionEvidence: result.completionEvidence, correlationEvidence: result.correlationEvidence,
      submissionEvidence: result.submissionEvidence,
      conversationId: result.conversationId, messageId: result.messageId
    };
  };
  return { models, execute, investigateText };
}
