import { createHash } from "node:crypto";
import { logEvent } from "../shared/log.js";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const identity = (name, namespace) => JSON.stringify([namespace || "", name]);
const nonemptyString = (value) => typeof value === "string" && value.length > 0 && value.length <= 512;

function requestScope(payload) {
  const metadata = payload?.client_metadata;
  const thread = metadata?.thread_id;
  const session = metadata?.session_id;
  if (!nonemptyString(payload?.model) || !nonemptyString(thread || session)) return undefined;
  if ((thread !== undefined && !nonemptyString(thread)) || (session !== undefined && !nonemptyString(session))) return undefined;
  if (thread && session && thread !== session) return undefined;
  const installation = metadata?.["x-codex-installation-id"];
  if (installation !== undefined && !nonemptyString(installation)) return undefined;
  return digest(JSON.stringify([payload.model, installation || "", thread || session]));
}

function isCompaction(payload) {
  const value = payload?.client_metadata?.["x-codex-turn-metadata"];
  if (typeof value !== "string" || value.length > 65536) return false;
  try {
    return JSON.parse(value)?.request_kind === "compaction";
  } catch {
    return false;
  }
}

function declarations(payload) {
  return [
    ...(Array.isArray(payload?.tools) ? payload.tools : []),
    ...(Array.isArray(payload?.input) ? payload.input : [])
      .filter((item) => item?.type === "additional_tools")
      .flatMap((item) => Array.isArray(item.tools) ? item.tools : [])
  ];
}

function hasEncryption(schema) {
  if (!schema || typeof schema !== "object") return false;
  if (schema.encrypted === true) return true;
  return Object.values(schema).some(hasEncryption);
}

// Capture the generating request's declaration, never a later same-name tool.
// A single-function namespace retains its original metadata and parameters.
function encryptedDeclarations(tools, maxBytes) {
  const found = new Map();
  let bytes = 0;
  const add = (tool, namespace, declaration) => {
    if (tool?.type !== "function" || !nonemptyString(tool.name)) return;
    const key = identity(tool.name, namespace);
    const serialized = JSON.stringify(declaration);
    bytes += Buffer.byteLength(serialized);
    if (bytes > maxBytes) return;
    if (found.has(key) && found.get(key)?.serialized !== serialized) found.set(key, null);
    else if (!found.has(key)) found.set(key, { serialized, encrypted: hasEncryption(tool.parameters) });
  };
  for (const tool of tools) {
    if (tool?.type === "namespace" && nonemptyString(tool.name) && Array.isArray(tool.tools)) {
      for (const child of tool.tools) add(child, tool.name, { ...tool, tools: [child] });
    } else {
      add(tool, undefined, tool);
    }
  }
  // An oversized catalog might hide a conflicting declaration beyond the limit.
  return bytes > maxBytes ? new Map() : new Map([...found]
    .filter(([, value]) => value?.encrypted)
    .map(([key, value]) => [key, value.serialized]));
}

function callKey(scope, item) {
  if (item?.type !== "function_call" || !nonemptyString(item.call_id) || !nonemptyString(item.name)
    || (item.namespace !== undefined && !nonemptyString(item.namespace)) || typeof item.arguments !== "string") return undefined;
  return digest(JSON.stringify([scope, item.call_id, item.namespace || "", item.name, item.arguments]));
}

function mergeDeclarations(serialized) {
  const tools = [];
  const namespaces = new Map();
  for (const value of serialized) {
    const tool = JSON.parse(value);
    if (tool.type !== "namespace") {
      tools.push(tool);
      continue;
    }
    const { tools: children, ...metadata } = tool;
    const existing = namespaces.get(tool.name);
    if (existing) {
      if (existing.metadata !== JSON.stringify(metadata)) return undefined;
      existing.tool.tools.push(...children);
    } else {
      namespaces.set(tool.name, { metadata: JSON.stringify(metadata), tool });
      tools.push(tool);
    }
  }
  return tools;
}

export function createToolReplayCache({
  now = Date.now,
  maxEntries = 1024,
  maxBytes = 4 * 1024 * 1024,
  ttlMs = 6 * 60 * 60 * 1000
} = {}) {
  const entries = new Map();
  let bytes = 0;

  const remove = (key) => {
    bytes -= entries.get(key).bytes;
    entries.delete(key);
  };
  const expire = () => {
    const timestamp = now();
    for (const [key, entry] of entries) if (entry.expires <= timestamp) remove(key);
  };
  const remember = (key, declaration) => {
    const size = Buffer.byteLength(declaration) + key.length;
    if (size > maxBytes || maxEntries < 1 || ttlMs <= 0) return;
    expire();
    const existing = entries.get(key);
    // Conflicting observations cannot safely establish an original schema.
    if (existing) {
      if (existing.declaration !== declaration) existing.ambiguous = true;
      return;
    }
    while (entries.size >= maxEntries || bytes + size > maxBytes) remove(entries.keys().next().value);
    entries.set(key, { declaration, bytes: size, expires: now() + ttlMs, ambiguous: false });
    bytes += size;
  };

  return {
    prepare(payload) {
      const scope = requestScope(payload);
      if (!scope) return { payload };
      expire();
      const tools = declarations(payload);
      let next = payload;
      if (isCompaction(payload) && tools.length === 0 && Array.isArray(payload.input)
        && (payload.tools === undefined || Array.isArray(payload.tools))
        && (payload.tool_choice === undefined || ["auto", "none"].includes(payload.tool_choice))) {
        const originals = new Map();
        let conflict = false;
        for (const item of payload.input) {
          const key = callKey(scope, item);
          const entry = key && entries.get(key);
          if (!entry) continue;
          if (entry.ambiguous) { conflict = true; break; }
          const name = identity(item.name, item.namespace);
          if (originals.has(name) && originals.get(name) !== entry.declaration) { conflict = true; break; }
          originals.set(name, entry.declaration);
        }
        // A restored declaration also applies to other calls with that name.
        // A cache miss for one of them could represent an older schema version.
        for (const item of payload.input) {
          if (item?.type !== "function_call" || !originals.has(identity(item.name, item.namespace))) continue;
          const entry = entries.get(callKey(scope, item));
          if (!entry || entry.ambiguous || entry.declaration !== originals.get(identity(item.name, item.namespace))) {
            conflict = true;
            break;
          }
        }
        const restored = !conflict && mergeDeclarations(originals.values());
        if (restored?.length) {
          // Declarations are needed to decode history, not to grant new calls.
          next = { ...payload, tools: restored, tool_choice: "none" };
          logEvent("responses_tool_replay", { restoredTools: originals.size });
        }
      }

      // Codex uses SSE. Do not rely on asynchronous JSON telemetry clones to
      // populate a cache required by the immediately following request.
      const originals = payload.stream === true ? encryptedDeclarations(tools, maxBytes) : new Map();
      if (!originals.size) return { payload: next };
      const observe = (item) => {
        const key = callKey(scope, item);
        const declaration = originals.get(identity(item?.name, item?.namespace));
        if (key && declaration && (item.status === undefined || item.status === "completed")) remember(key, declaration);
      };
      return {
        payload: next,
        onResponsePayload(event) {
          if (event?.type === "response.output_item.done") observe(event.item);
          if (event?.type === "response.completed" && Array.isArray(event.response?.output)) event.response.output.forEach(observe);
        }
      };
    }
  };
}

export const responsesToolReplayCache = createToolReplayCache();
