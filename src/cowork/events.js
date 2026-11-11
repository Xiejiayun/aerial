import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import { coworkError } from "./profile.js";

const gunzipAsync = promisify(gunzip);
const DEFAULT_LIMITS = { frameBytes: 1024 * 1024, decodedBytes: 4 * 1024 * 1024, totalBytes: 32 * 1024 * 1024, eventCount: 20_000 };
const OBSERVED_KINDS = new Set(["message", "session", "cs", "tk", "q", "dx", "fr", "rl", "error", "err"]);
const OBSERVED_FIELDS = new Set([
  "servers", "packages", "v", "ts", "type", "items", "cnt", "mid", "eid", "stop", "content", "ri",
  "st", "turns", "dur", "tc", "loop_guard", "salvage", "tcc", "conversationId", "requestMessageId", "messageId",
  "t", "message", "code", "model", "modelSelection"
]);
const OBSERVED_ITEM_FIELDS = new Set([
  "id", "name", "title", "description", "type", "url", "transport", "status", "enabled", "tools", "toolCount",
  "serverId", "packageId", "version", "command", "args", "env", "headers", "config", "capabilities", "error",
  "inputSchema", "outputSchema", "parameters", "arguments", "annotations"
]);
const OBSERVED_STATUSES = new Set(["ok", "started", "running", "queued", "error", "failed", "cancelled", "canceled"]);
const OBSERVED_STOP_REASONS = new Set(["end_turn", "tool_use", "max_tokens", "stop_sequence", "pause_turn", "refusal", "stop", "length", "content_filter", "tool_calls"]);
const OBSERVATION_SAMPLE_LIMIT = 5;

export function eventFieldTypes(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { $type: value === null ? "null" : Array.isArray(value) ? "array" : typeof value };
  return Object.fromEntries(Object.keys(value).slice(0, 40).map((key) => [
    /^[A-Za-z0-9_-]{1,80}$/.test(key) ? key : "<unrecognized-field-name>",
    value[key] === null ? "null" : Array.isArray(value[key]) ? "array" : typeof value[key]
  ]));
}

function observationFieldTypes(value, fields) {
  // Keys inside server/tool metadata may themselves contain identifiers. Keep
  // only fixed schema names, even though no values are copied into the summary.
  return Object.fromEntries(Object.entries(eventFieldTypes(value)).map(([key, type]) => [
    key === "$type" || fields.has(key) ? key : "<unrecognized-field-name>", type
  ]));
}

function nonnegativeCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function eventProtocolEvidence(event, { conversationId, messageId } = {}) {
  const data = event.data;
  const evidence = {
    kind: OBSERVED_KINDS.has(event.event) ? event.event : "<unrecognized-event>",
    compressed: event.compressed === true,
    fieldTypes: observationFieldTypes(data, OBSERVED_FIELDS)
  };
  if (!data || typeof data !== "object" || Array.isArray(data)) return evidence;
  evidence.correlation = Object.fromEntries(["conversationId", "requestMessageId", "messageId", "mid", "eid"].map((key) => {
    const present = Object.hasOwn(data, key);
    const comparison = { present };
    // These are equality observations only. Completion validation distinguishes
    // q/rl request IDs from an fr assistant ID; eid has no verified ID semantics.
    if (present && typeof conversationId === "string") comparison.matchesConversationId = data[key] === conversationId;
    if (present && typeof messageId === "string") comparison.matchesMessageId = data[key] === messageId;
    return [key, comparison];
  }));
  if (event.event === "cs") {
    if (data.servers && typeof data.servers === "object" && !Array.isArray(data.servers)) {
      const keys = Object.keys(data.servers);
      evidence.serverCount = keys.length;
      evidence.serverValueFieldTypes = keys.slice(0, OBSERVATION_SAMPLE_LIMIT).map((key) => observationFieldTypes(data.servers[key], OBSERVED_ITEM_FIELDS));
    }
    if (Array.isArray(data.packages)) evidence.packageCount = data.packages.length;
  }
  if (event.event === "tk") {
    if (Array.isArray(data.items)) {
      evidence.itemCount = data.items.length;
      evidence.itemFieldTypes = data.items.slice(0, OBSERVATION_SAMPLE_LIMIT).map((item) => observationFieldTypes(item, OBSERVED_ITEM_FIELDS));
    }
    if (nonnegativeCount(data.cnt)) evidence.reportedCount = data.cnt;
  }
  if (event.event === "rl") {
    if (OBSERVED_STATUSES.has(data.st)) evidence.status = data.st;
    if (nonnegativeCount(data.tc)) evidence.toolCallCount = data.tc;
  }
  if (event.event === "fr" && OBSERVED_STOP_REASONS.has(data.stop)) evidence.stopReason = data.stop;
  return evidence;
}

async function decodeData(raw, maxOutputLength) {
  let value;
  try { value = JSON.parse(raw); } catch { throw coworkError("PROTOCOL_CHANGED", "Cowork returned an event with invalid JSON.", { submitted: true }); }
  if (value?.compressed !== true) return { data: value, compressed: false };
  const encoded = value.data;
  if (typeof encoded !== "string" || !encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw coworkError("PROTOCOL_CHANGED", "Cowork returned an invalid compressed event envelope.", { submitted: true });
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) throw coworkError("PROTOCOL_CHANGED", "Cowork returned invalid Base64 event data.", { submitted: true });
  try {
    const expanded = await gunzipAsync(bytes, { maxOutputLength });
    return { data: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(expanded)), compressed: true, decodedBytes: expanded.length };
  } catch {
    throw coworkError("PROTOCOL_CHANGED", "Cowork compressed event is invalid or exceeds the decoded size limit.", { submitted: true });
  }
}

export async function* readCoworkEvents(response, { signal, limits: overrides = {} } = {}) {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  if (!response.body) throw coworkError("PROTOCOL_CHANGED", "Cowork returned no event stream.", { submitted: true });
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let bytes = 0;
  let count = 0;
  let decodedBytes = 0;
  let cancelPromise;
  const cancel = () => { cancelPromise ||= reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    signal?.throwIfAborted();
    while (true) {
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      bytes += value?.length || 0;
      if (bytes > limits.totalBytes) throw coworkError("PROTOCOL_CHANGED", "Cowork event stream exceeded the total size limit.", { submitted: true });
      try { buffer += decoder.decode(value, { stream: !done }); }
      catch { throw coworkError("PROTOCOL_CHANGED", "Cowork event stream contained invalid UTF-8.", { submitted: true }); }
      let separator;
      while ((separator = /\r\n\r\n|\n\n|\r\r/.exec(buffer))) {
        const block = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator[0].length);
        if (Buffer.byteLength(block) > limits.frameBytes) throw coworkError("PROTOCOL_CHANGED", "Cowork event exceeded the frame size limit.", { submitted: true });
        let event = "message";
        let id;
        const data = [];
        for (const line of block.split(/\r\n|\n|\r/)) {
          const colon = line.indexOf(":");
          const name = colon === -1 ? line : line.slice(0, colon);
          let text = colon === -1 ? "" : line.slice(colon + 1);
          if (text.startsWith(" ")) text = text.slice(1);
          if (name === "event") event = text;
          else if (name === "id" && !text.includes("\0")) id = text;
          else if (name === "data") data.push(text);
        }
        if (!data.length) continue;
        if (++count > limits.eventCount) throw coworkError("PROTOCOL_CHANGED", "Cowork event count exceeded its limit.", { submitted: true });
        const parsed = await decodeData(data.join("\n"), limits.decodedBytes);
        decodedBytes += parsed.decodedBytes || Buffer.byteLength(data.join("\n"));
        if (decodedBytes > limits.totalBytes) throw coworkError("PROTOCOL_CHANGED", "Cowork decoded events exceeded the total size limit.", { submitted: true });
        yield { event, id, data: parsed.data, compressed: parsed.compressed };
      }
      if (Buffer.byteLength(buffer) > limits.frameBytes) throw coworkError("PROTOCOL_CHANGED", "Cowork partial event exceeded the frame size limit.", { submitted: true });
      if (done) {
        if (buffer.trim()) throw coworkError("PROTOCOL_CHANGED", "Cowork event stream ended with an incomplete frame.", { submitted: true });
        break;
      }
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    cancel();
    await cancelPromise;
    reader.releaseLock();
  }
}

export async function readCoworkCompletion(response, { signal, conversationId, messageId, onEvent, limits } = {}) {
  let final;
  let seenFinal = false;
  for await (const event of readCoworkEvents(response, { signal, limits })) {
    const data = event.data;
    await onEvent?.(eventProtocolEvidence(event, { conversationId, messageId }));
    if (!data || typeof data !== "object" || Array.isArray(data)) throw coworkError("PROTOCOL_CHANGED", "Cowork returned a non-object event.", { submitted: true });
    // Observed q/rl mid fields identify the submitted request, while fr.mid
    // identifies the assistant response and may differ from the request ID.
    if ((data.conversationId !== undefined && data.conversationId !== conversationId)
      || (data.requestMessageId !== undefined && data.requestMessageId !== messageId)
      || (typeof messageId === "string" && messageId.length > 0 && (event.event === "q" || event.event === "rl")
        && Object.hasOwn(data, "mid") && data.mid !== messageId)) throw coworkError("PROTOCOL_CHANGED", "Cowork returned an event for a different operation.", { submitted: true });
    if (event.event === "error" || event.event === "err") throw coworkError("UPSTREAM_REJECTED", "Cowork reported a task error.", { submitted: true });
    if (event.event === "fr") {
      if (seenFinal || typeof data.content !== "string") throw coworkError("PROTOCOL_CHANGED", "Cowork returned an invalid or duplicate final result.", { submitted: true });
      seenFinal = true;
      final = { text: data.content };
    }
    if (event.event === "rl") {
      if (data.st === "ok") {
        if (!seenFinal) throw coworkError("PROTOCOL_CHANGED", "Cowork completed without a final result.", { submitted: true });
        const correlationEvidence = typeof messageId === "string" && messageId.length > 0
          ? data.requestMessageId === messageId ? "request-message-id" : data.mid === messageId ? "request-mid" : undefined
          : undefined;
        if (!correlationEvidence) throw coworkError("PROTOCOL_CHANGED", "Cowork completion did not identify the submitted request.", { submitted: true });
        return { ...final, completionEvidence: "fr-plus-rl-ok", correlationEvidence };
      }
      if (["error", "failed", "cancelled", "canceled"].includes(data.st)) throw coworkError("UPSTREAM_REJECTED", "Cowork ended the task without success.", { submitted: true });
      if (data.st !== "started" && data.st !== "running" && data.st !== "queued") throw coworkError("PROTOCOL_CHANGED", "Cowork returned an unrecognized task state.", { submitted: true });
    }
  }
  // A candidate final result followed by EOF does not prove remote completion.
  throw coworkError("SUBMISSION_UNKNOWN", "Cowork disconnected before confirmed task completion; the remote task may still be running.", { submitted: true });
}
