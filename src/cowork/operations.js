import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { CoworkError, semanticRequest } from "./protocol.js";

const PHASES = ["CREATED", "AUTHENTICATING", "SUBSCRIBING", "READY_TO_SUBMIT", "SUBMITTING", "ACCEPTED", "RUNNING", "RESULT_RECEIVED"];
const FINAL = new Set(["SUCCEEDED", "FAILED", "UNKNOWN"]);

function digest(value) { return createHash("sha256").update(value).digest("hex"); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}
function problem(code, message, record) {
  const error = new CoworkError(code, message, 409);
  if (record) error.operationId = record.id;
  return error;
}

// The parent owns the account/profile lock. All mutations here are synchronous,
// so the metadata reaches disk before an async transport can submit a task.
export function createOperationStore({ directory, route, now = Date.now, resultTtlMs = 600_000, maxRecords = 1000, maxResultBytes = 16 * 1024 * 1024 } = {}) {
  if (!directory || !path.isAbsolute(directory)) throw new Error("An absolute operationDirectory is required.");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) throw new CoworkError("OPERATION_STORE_INVALID", "Cowork operation storage must be a real directory.", 503);
  const file = path.join(directory, "operations.json");
  let records = [];
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw new Error("Invalid operation metadata file.");
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (data.version !== 1 || !Array.isArray(data.records) || data.records.length > maxRecords || data.records.some(record => !record || typeof record.id !== "string" || typeof record.key !== "string" || typeof record.fingerprint !== "string" || typeof record.phase !== "string")) throw new Error("Invalid operation metadata.");
    records = data.records;
  } catch (error) {
    if (error.code !== "ENOENT") throw new CoworkError("OPERATION_STORE_INVALID", "Cowork operation metadata could not be read safely.", 503);
  }
  const results = new Map();
  let resultBytes = 0;
  const persist = () => {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      const fd = fs.openSync(temporary, "wx", 0o600);
      try { fs.writeFileSync(fd, `${JSON.stringify({ version: 1, records })}\n`); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      fs.renameSync(temporary, file);
    } catch {
      try { fs.unlinkSync(temporary); } catch { /* Only this write's temporary file. */ }
      throw new CoworkError("OPERATION_STORE_FAILED", "Cowork operation metadata could not be saved; no new task may be submitted.", 503);
    }
  };
  for (const record of records) {
    if (!FINAL.has(record.phase)) {
      record.phase = "UNKNOWN";
      record.remoteState = record.submitted ? "unknown" : "not_submitted";
      record.localOutcome = "process_interrupted";
    }
  }
  if (records.length) persist();

  function pruneResults() {
    for (const [id, entry] of results) {
      if (entry.expiresAt <= now()) { resultBytes -= entry.bytes; results.delete(id); }
    }
  }
  function known(record) {
    if (!records.includes(record)) throw new Error("Unknown operation.");
  }

  return {
    claim({ body, sessionId = "", idempotencyKey = "" }) {
      pruneResults();
      const fingerprint = digest(JSON.stringify(canonical({ route: { publicId: route.publicId, upstreamId: route.upstreamId }, request: semanticRequest(body) })));
      const key = digest(JSON.stringify({ sessionId, kind: idempotencyKey ? "explicit" : "fingerprint", value: idempotencyKey || fingerprint }));
      const previous = records.findLast(record => record.key === key && !record.releasedAt);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw problem("IDEMPOTENCY_CONFLICT", "This operation key belongs to a different request.", previous);
        if (previous.phase === "SUCCEEDED") {
          const cached = results.get(previous.id);
          if (cached) return { record: previous, message: cached.message, reused: true };
          throw problem("RESULT_UNAVAILABLE", "This operation completed but its result is no longer cached. Explicitly release it before regenerating.", previous);
        }
        if (previous.phase === "UNKNOWN") throw problem("SUBMISSION_UNKNOWN", "This operation may already have run. Inspect or explicitly release it before regenerating.", previous);
        if (previous.phase === "FAILED" && previous.submitted) {
          if (previous.remoteState === "succeeded") throw problem("RESULT_UNAVAILABLE", "The remote operation completed but no usable local result is available. Explicitly release it before regenerating.", previous);
          throw problem("OPERATION_ALREADY_SUBMITTED", "This operation was already submitted and failed or was rejected. Explicitly release it before retrying.", previous);
        }
        if (previous.phase !== "FAILED") throw problem("OPERATION_IN_PROGRESS", "This operation is already in progress.", previous);
      }
      if (records.length >= maxRecords) records = records.filter(record => !record.releasedAt);
      if (records.length >= maxRecords) throw new CoworkError("OPERATION_STORE_FULL", "Cowork operation history is full. Explicitly release reviewed operations before starting another operation.", 503);
      const record = {
        id: randomUUID(), messageId: `msg_aerial_${randomUUID().replaceAll("-", "")}`,
        key, fingerprint, phase: "CREATED", submitted: false,
        publicModel: route.publicId, upstreamModel: route.upstreamId,
        createdAt: now(), updatedAt: now(), remoteState: "not_submitted", delivery: "PENDING"
      };
      records.push(record);
      try { persist(); } catch (error) { records.pop(); throw error; }
      return { record, reused: false };
    },
    phase(record, phase, ids = {}) {
      known(record);
      if (!PHASES.includes(phase) || FINAL.has(record.phase) || PHASES.indexOf(phase) < PHASES.indexOf(record.phase)) throw new CoworkError("PROTOCOL_CHANGED", "Cowork transport reported an invalid operation phase.", 502);
      if (phase === "SUBMITTING" && record.submitted) throw new CoworkError("DUPLICATE_SUBMISSION", "A Cowork operation may submit only once.", 502);
      if (PHASES.indexOf(phase) > PHASES.indexOf("SUBMITTING") && !record.submitted) throw new CoworkError("PROTOCOL_CHANGED", "Cowork transport omitted the submission boundary.", 502);
      record.phase = phase;
      if (phase === "SUBMITTING") { record.submitted = true; record.remoteState = "unknown"; }
      if (["ACCEPTED", "RUNNING", "RESULT_RECEIVED"].includes(phase)) record.remoteState = "running";
      for (const key of ["conversationId", "messageId", "runId"]) {
        if (ids[key] !== undefined) {
          if (typeof ids[key] !== "string" || ids[key].length > 512) throw new CoworkError("PROTOCOL_CHANGED", "Invalid upstream operation identifier.", 502);
          record[`upstream${key[0].toUpperCase()}${key.slice(1)}`] = ids[key];
        }
      }
      record.updatedAt = now();
      persist();
    },
    succeed(record, message) {
      known(record);
      if (!record.submitted) throw new CoworkError("PROTOCOL_CHANGED", "Cowork transport omitted the submission boundary.", 502);
      record.phase = "SUCCEEDED"; record.remoteState = "succeeded"; record.updatedAt = now();
      persist();
      pruneResults();
      const bytes = Buffer.byteLength(JSON.stringify(message));
      while (results.size && resultBytes + bytes > maxResultBytes) {
        const [id, entry] = results.entries().next().value;
        resultBytes -= entry.bytes; results.delete(id);
      }
      if (bytes <= maxResultBytes) { results.set(record.id, { message, bytes, expiresAt: now() + resultTtlMs }); resultBytes += bytes; }
    },
    fail(record, error) {
      known(record);
      if (record.phase === "SUCCEEDED") return;
      const remote = error.remoteState;
      record.phase = record.submitted && !["rejected", "failed", "succeeded"].includes(remote) ? "UNKNOWN" : "FAILED";
      record.remoteState = remote || (record.submitted ? "unknown" : "not_submitted");
      record.localOutcome = error.code || "LOCAL_FAILED";
      record.updatedAt = now(); persist();
    },
    delivery(record, state) {
      known(record);
      if (!["WRITING", "LOCALLY_WRITTEN", "INTERRUPTED"].includes(state)) throw new Error("Invalid local delivery state.");
      record.delivery = state; record.updatedAt = now(); persist();
    },
    list() { return records.map(record => ({ ...record })); },
    release(id) {
      const record = records.find(item => item.id === id);
      if (!record) throw problem("OPERATION_NOT_FOUND", "Unknown Cowork operation.");
      if (!FINAL.has(record.phase)) throw problem("OPERATION_IN_PROGRESS", "An active operation cannot be released.", record);
      record.releasedAt = now(); persist();
    }
  };
}
