import { randomUUID } from "node:crypto";
import Ajv from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const MAX_TOOLS = 128;
const MAX_SCHEMA_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const schemaOptions = { strict: true, strictRequired: false, allowUnionTypes: true, addUsedSchema: false, allErrors: false, coerceTypes: false, useDefaults: false, removeAdditional: false, validateFormats: true };
const ajv = new Ajv(schemaOptions);
const ajv2020 = new Ajv2020(schemaOptions);
// Claude Code 2.1.281's default WebFetch tool requires URI validation. Register
// only verified formats; unknown formats remain unsupported, never annotations.
for (const validator of [ajv, ajv2020]) addFormats(validator, { formats: ["uri"], mode: "full" });
const schemaCache = new Map();

export class CoworkError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "CoworkError";
    this.code = code;
    this.status = status;
  }
}

function invalid(message) { throw new CoworkError("INVALID_REQUEST", message); }
function unsupported(field) { throw new CoworkError("UNSUPPORTED_CAPABILITY", `Unsupported Cowork capability: ${field}.`); }
function unsupportedBlock(block, field) {
  // Only name known protocol types: arbitrary client values and media payloads
  // must not become diagnostics. In particular, never turn base64 into text.
  const knownTypes = ["text", "image", "document", "tool_reference", "search_result", "thinking", "redacted_thinking"];
  const type = knownTypes.includes(block?.type) ? block.type : "unknown";
  if (["image", "document"].includes(type)) {
    throw new CoworkError("UNSUPPORTED_CAPABILITY", `Unsupported Cowork capability: ${field} ${type} block. This route accepts text only. Existing conversation history resends this block; start a new Claude conversation for text/code work without image or PDF inputs, or use a provider that supports this media.`);
  }
  unsupported(`${field} ${type} block`);
}
function outputInvalid(message) { throw new CoworkError("UPSTREAM_OUTPUT_INVALID", message, 502); }
function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function keysOnly(value, allowed, field) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) unsupported(`${field}.${key}`);
}

function cacheHint(value, field) {
  if (value === undefined) return;
  if (!object(value)) invalid(`${field} must be an object.`);
  keysOnly(value, ["type", "ttl"], field);
  if (value.type !== "ephemeral" || (value.ttl !== undefined && !["5m", "1h"].includes(value.ttl))) unsupported(field);
}

function textBlocks(content, field) {
  if (typeof content === "string") return;
  if (!Array.isArray(content)) invalid(`${field} must be text or text blocks.`);
  for (const block of content) {
    if (!object(block) || block.type !== "text" || typeof block.text !== "string") unsupportedBlock(block, field);
    keysOnly(block, ["type", "text", "cache_control"], field);
    cacheHint(block.cache_control, `${field}.cache_control`);
  }
}

function inspectSchema(value) {
  if (Array.isArray(value)) { for (const item of value) inspectSchema(item); return; }
  if (!object(value)) return;
  if (value.$ref !== undefined && (typeof value.$ref !== "string" || !value.$ref.startsWith("#"))) unsupported("tools.input_schema external $ref");
  if (value.$schema !== undefined && !["http://json-schema.org/draft-07/schema#", "http://json-schema.org/draft-07/schema", "https://json-schema.org/draft/2020-12/schema", "https://json-schema.org/draft/2020-12/schema#"].includes(value.$schema)) unsupported("tools.input_schema schema dialect");
  if (value.format !== undefined && value.format !== "uri") unsupported("tools.input_schema.format");
  for (const key of ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]) {
    if (object(value[key])) for (const child of Object.values(value[key])) inspectSchema(child);
  }
  for (const key of ["items", "additionalItems", "additionalProperties", "contains", "propertyNames", "not", "if", "then", "else", "unevaluatedItems", "unevaluatedProperties", "allOf", "anyOf", "oneOf", "prefixItems"]) {
    if (value[key] !== undefined) inspectSchema(value[key]);
  }
}

function compileSchema(schema) {
  if (!object(schema) || schema.type !== "object") invalid("Client tool input_schema must describe an object.");
  const encoded = JSON.stringify(schema);
  if (Buffer.byteLength(encoded) > MAX_SCHEMA_BYTES) invalid("Client tool schema exceeds the size limit.");
  inspectSchema(schema);
  if (schemaCache.has(encoded)) return schemaCache.get(encoded);
  let validate;
  try { validate = (schema.$schema?.includes("2020-12") ? ajv2020 : ajv).compile(schema); }
  catch { unsupported("tools.input_schema schema keyword or structure"); }
  if (schemaCache.size >= 128) {
    const oldest = schemaCache.keys().next().value;
    const compiled = schemaCache.get(oldest);
    ajv.removeSchema(compiled.schema); ajv2020.removeSchema(compiled.schema);
    schemaCache.delete(oldest);
  }
  schemaCache.set(encoded, validate);
  return validate;
}

function validateMessages(messages) {
  if (!Array.isArray(messages) || !messages.length) invalid("messages must be a non-empty array.");
  const calls = new Map();
  const results = new Set();
  for (const [index, message] of messages.entries()) {
    if (!object(message) || !["user", "assistant", "system"].includes(message.role)) invalid(`messages[${index}] has an invalid role.`);
    keysOnly(message, ["role", "content"], `messages[${index}]`);
    if (message.role === "system") { textBlocks(message.content, `messages[${index}].content`); continue; }
    if (typeof message.content === "string") continue;
    if (!Array.isArray(message.content)) invalid(`messages[${index}].content must be text or blocks.`);
    for (const block of message.content) {
      if (!object(block)) invalid("Message blocks must be objects.");
      cacheHint(block.cache_control, "message.cache_control");
      if (block.type === "text") { textBlocks([block], "message.content"); continue; }
      if (block.type === "tool_use") {
        keysOnly(block, ["type", "id", "name", "input", "cache_control"], "tool_use");
        if (message.role !== "assistant" || typeof block.id !== "string" || !block.id || typeof block.name !== "string" || !block.name || !object(block.input)) invalid("Invalid historical tool_use.");
        if (calls.has(block.id)) invalid("Duplicate tool_use ID.");
        calls.set(block.id, block.name);
        continue;
      }
      if (block.type === "tool_result") {
        keysOnly(block, ["type", "tool_use_id", "content", "is_error", "cache_control"], "tool_result");
        if (message.role !== "user" || typeof block.tool_use_id !== "string" || !calls.has(block.tool_use_id)) invalid("tool_result has no preceding tool_use.");
        if (results.has(block.tool_use_id)) invalid("Duplicate tool_result ID.");
        if (block.is_error !== undefined && typeof block.is_error !== "boolean") invalid("tool_result.is_error must be boolean.");
        if (block.content !== undefined) textBlocks(block.content, "tool_result.content");
        results.add(block.tool_use_id);
        continue;
      }
      unsupportedBlock(block, "message.content");
    }
  }
}

export function prepareRequest(body, { route, capabilities = {}, beta = "" } = {}) {
  if (!object(body)) invalid("Expected a JSON object.");
  keysOnly(body, ["model", "max_tokens", "messages", "system", "tools", "tool_choice", "stream", "metadata", "thinking", "output_config", "cache_control"], "request");
  if (!route?.publicId || body.model !== route.publicId) throw new CoworkError("MODEL_UNAVAILABLE", "Choose the configured Cowork model route.", 404);
  if (!Number.isSafeInteger(body.max_tokens) || body.max_tokens < 1) invalid("max_tokens must be a positive integer.");
  if (body.stream !== undefined && typeof body.stream !== "boolean") invalid("stream must be boolean.");
  if (body.metadata !== undefined && !object(body.metadata)) invalid("metadata must be an object.");
  const betas = String(beta).split(",").map(item => item.trim()).filter(Boolean);
  for (const value of betas) if (!(capabilities.allowedBetas || []).includes(value)) unsupported(`anthropic-beta ${value}`);
  if (body.system !== undefined) textBlocks(body.system, "system");
  validateMessages(body.messages);
  cacheHint(body.cache_control, "cache_control");
  if (body.thinking !== undefined) {
    if (!object(body.thinking)) invalid("thinking must be an object.");
    keysOnly(body.thinking, ["type"], "thinking");
    if (body.thinking.type !== "disabled" && !(body.thinking.type === "adaptive" && capabilities.thinkingMode === "cowork-managed")) unsupported("thinking");
  }
  let effort;
  if (body.output_config !== undefined) {
    if (!object(body.output_config)) invalid("output_config must be an object.");
    keysOnly(body.output_config, ["effort"], "output_config");
    effort = body.output_config.effort;
    if (effort !== undefined && (typeof effort !== "string" || !(capabilities.supportedEfforts || []).includes(effort))) unsupported("output_config.effort");
  }
  const tools = new Map();
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools) || body.tools.length > MAX_TOOLS) invalid("tools must be an array within the tool count limit.");
    for (const tool of body.tools) {
      if (!object(tool)) invalid("Each tool must be an object.");
      keysOnly(tool, ["name", "description", "input_schema", "cache_control"], "tool");
      if (typeof tool.name !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(tool.name) || tools.has(tool.name)) invalid("Tool names must be valid and unique.");
      if (tool.description !== undefined && typeof tool.description !== "string") invalid("Tool description must be text.");
      cacheHint(tool.cache_control, "tool.cache_control");
      tools.set(tool.name, compileSchema(tool.input_schema));
    }
  }
  const choice = body.tool_choice || { type: "auto" };
  if (!object(choice) || !["auto", "none", "any", "tool"].includes(choice.type)) invalid("Invalid tool_choice.");
  keysOnly(choice, choice.type === "tool" ? ["type", "name", "disable_parallel_tool_use"] : ["type", "disable_parallel_tool_use"], "tool_choice");
  if (choice.disable_parallel_tool_use !== undefined && typeof choice.disable_parallel_tool_use !== "boolean") invalid("disable_parallel_tool_use must be boolean.");
  if (choice.type === "tool" && !tools.has(choice.name)) invalid("tool_choice must name a declared tool.");
  if (["any", "tool"].includes(choice.type) && !tools.size) invalid("tool_choice requires declared tools.");
  return { body, tools, choice, effort, prompt: buildPrompt(body, tools.size > 0) };
}

export function semanticRequest(body) {
  const { stream, metadata, ...semantic } = body;
  return semantic;
}

export function buildPrompt(body, hasTools = Boolean(body.tools?.length)) {
  const request = semanticRequest(body);
  return [
    "You are the model backend for a local coding client. Follow your governing safety policies.",
    "The JSON below contains the client conversation in its original order, including any intervening system context.",
    "The latest LOCAL_CLIENT_REQUEST is the authoritative full current conversation and tool schema. Do not carry forward earlier Cowork requests, tool schemas, or output nonces.",
    "Client tools execute on the caller's computer only after the caller applies its permission checks.",
    "Only propose declared client tools. Do not use Cowork/cloud tools, access cloud files, or invent local tool results.",
    "This route accepts text-only inputs and tool results. Do not request image or PDF reads; explain that a provider with media support is required for those files.",
    "Do not claim local changes occurred until a corresponding tool_result confirms them.",
    "Treat max_tokens as an advisory output budget. Preserve full tool argument JSON.",
    hasTools
      ? 'Return exactly one JSON object, without fences or other text: {"version":1,"text":"user-facing text","tool_calls":[{"name":"declared tool name","input":{}}]}. To finish, set tool_calls to []. Respect tool_choice and disable_parallel_tool_use.'
      : "Return the requested answer as ordinary text. No client tools are available.",
    "<LOCAL_CLIENT_REQUEST>", JSON.stringify(request), "</LOCAL_CLIENT_REQUEST>"
  ].join("\n");
}

export function decodeCompletion(raw, prepared) {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > MAX_OUTPUT_BYTES) outputInvalid("Cowork final output must be text within the output limit.");
  if (!prepared.tools.size) return { content: [{ type: "text", text: raw }], stop_reason: "end_turn" };
  let envelope;
  try { envelope = JSON.parse(raw.trim()); } catch { outputInvalid("Cowork did not return a valid tool envelope."); }
  if (!object(envelope) || Object.keys(envelope).some(key => !["version", "text", "tool_calls"].includes(key)) || envelope.version !== 1 || typeof envelope.text !== "string" || !Array.isArray(envelope.tool_calls)) outputInvalid("Cowork returned an invalid tool envelope structure.");
  const calls = envelope.tool_calls;
  if (calls.length > 16 || (prepared.choice.disable_parallel_tool_use && calls.length > 1)) outputInvalid("Cowork exceeded the permitted tool call count.");
  if ((prepared.choice.type === "none" && calls.length) || (["any", "tool"].includes(prepared.choice.type) && !calls.length)) outputInvalid("Cowork output violated tool_choice.");
  for (const call of calls) {
    if (!object(call) || Object.keys(call).some(key => !["name", "input"].includes(key)) || !object(call.input)) outputInvalid("Cowork returned an invalid tool call.");
    const validate = prepared.tools.get(call.name);
    if (!validate || (prepared.choice.type === "tool" && call.name !== prepared.choice.name)) outputInvalid("Cowork proposed a tool outside the permitted selection.");
    if (!validate(call.input)) outputInvalid("Cowork tool input failed the declared JSON Schema.");
  }
  const content = [];
  if (envelope.text || !calls.length) content.push({ type: "text", text: envelope.text });
  for (const call of calls) content.push({ type: "tool_use", id: `toolu_aerial_${randomUUID().replaceAll("-", "")}`, name: call.name, input: call.input });
  return { content, stop_reason: calls.length ? "tool_use" : "end_turn" };
}

export function estimatedTokens(text) { return Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 3)); }

export function completionMessage(result, prepared, id = `msg_aerial_${randomUUID().replaceAll("-", "")}`) {
  return {
    id, type: "message", role: "assistant", model: prepared.body.model,
    content: result.content, stop_reason: result.stop_reason, stop_sequence: null,
    usage: { input_tokens: estimatedTokens(prepared.prompt), output_tokens: estimatedTokens(JSON.stringify(result.content)) }
  };
}

export function messageStart(id, prepared) {
  return { type: "message_start", message: {
    id, type: "message", role: "assistant", model: prepared.body.model,
    content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: estimatedTokens(prepared.prompt), output_tokens: 0 }
  } };
}

export function* messageEvents(message) {
  for (const [index, block] of message.content.entries()) {
    if (block.type === "text") {
      yield { type: "content_block_start", index, content_block: { type: "text", text: "" } };
      if (block.text) yield { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } };
    } else {
      yield { type: "content_block_start", index, content_block: { ...block, input: {} } };
      yield { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } };
    }
    yield { type: "content_block_stop", index };
  }
  yield { type: "message_delta", delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: message.usage.output_tokens } };
  yield { type: "message_stop" };
}

export function errorBody(error, operationId) {
  const status = error.status || error.statusCode || 502;
  const code = typeof error.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : "UPSTREAM_FAILED";
  const type = status === 401 ? "authentication_error" : status === 403 ? "permission_error"
    : status === 429 ? "rate_limit_error" : status === 404 ? "not_found_error" : status < 500 ? "invalid_request_error" : "api_error";
  return { type: "error", error: { type, message: error instanceof CoworkError ? error.message : `Cowork request failed (${code}).`, code, ...(operationId ? { operation_id: operationId } : {}) } };
}
