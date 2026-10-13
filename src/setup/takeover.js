import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse as parseToml } from "smol-toml";
import { writePrivateFile } from "../shared/paths.js";
import { loadConfig } from "../shared/config.js";
import { setTomlValue } from "./toml.js";
import { isAerialKeyHelper } from "./auth-helper.js";
import { localBaseUrl } from "../shared/urls.js";

const SCHEMA = "aerial.takeover.v1";
export const takeoverPath = file => `${file}.aerial-state.json`;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);
const owns = (value, key) => object(value) && Object.hasOwn(value, key);
const at = (doc, parts) => parts.reduce((value, key) => owns(value, key) ? value[key] : undefined, doc);

function parseClient(target, text) {
  if (text === null) return {};
  const doc = target === "codex" ? parseToml(text) : JSON.parse(text);
  if (!object(doc)) throw new Error(`${target} configuration must be an object.`);
  return doc;
}

function changes(before, after, prefix = []) {
  if ((object(before) || before === undefined) && (object(after) || after === undefined)) {
    return [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])]
      .flatMap(key => changes(owns(before, key) ? before[key] : undefined, owns(after, key) ? after[key] : undefined, [...prefix, key]));
  }
  return isDeepStrictEqual(before, after) ? [] : [{ path: prefix, before, after }];
}

function assign(doc, parts, value) {
  let node = doc;
  for (const key of parts.slice(0, -1)) {
    if (!owns(node, key)) Object.defineProperty(node, key, { value: {}, enumerable: true, configurable: true, writable: true });
    if (!object(node[key])) throw new Error(`Cannot restore ${parts.join(".")}: its parent was changed. Configuration left unchanged.`);
    node = node[key];
  }
  const key = parts.at(-1);
  if (value === undefined) delete node[key];
  else Object.defineProperty(node, key, { value, enumerable: true, configurable: true, writable: true });
}

function editClient(target, text, edits, baseline) {
  let content = text || (target === "codex" ? "" : "{}\n");
  let doc = parseClient(target, content);
  for (const edit of edits) {
    if (target === "codex") content = setTomlValue(content, edit.path, edit.value);
    else assign(doc, edit.path, edit.value);
  }
  if (target === "codex") doc = parseClient(target, content);
  // Remove only containers made empty by undoing managed changes. Unrelated
  // user keys in those containers remain intact.
  const parents = new Map();
  for (const edit of edits) for (let i = 1; i < edit.path.length; i += 1) {
    const prefix = edit.path.slice(0, i);
    parents.set(JSON.stringify(prefix), prefix);
  }
  for (const prefix of [...parents.values()].sort((a, b) => b.length - a.length)) {
    const value = at(doc, prefix);
    if (at(baseline, prefix) === undefined && object(value) && !Object.keys(value).length) {
      if (target === "codex") {
        content = setTomlValue(content, prefix, undefined);
        doc = parseClient(target, content);
      } else assign(doc, prefix, undefined);
    }
  }
  return target === "codex" ? content : `${JSON.stringify(doc, null, 2)}\n`;
}

export function dependsOnAerial(target, doc) {
  if (target === "codex") {
    const provider = doc.model_providers?.aerial;
    return doc.model_provider === "aerial" || doc.profile === "aerial"
      || Object.values(doc.profiles || {}).some(profile => profile?.model_provider === "aerial")
      || typeof provider?.base_url === "string"
      || Array.isArray(provider?.auth?.args) && provider.auth.args.slice(-2).join(" ") === "key print";
  }
  const config = loadConfig();
  return isAerialKeyHelper(doc.apiKeyHelper)
    || doc.env?.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY === "1"
      && doc.env?.ANTHROPIC_BASE_URL === localBaseUrl(config);
}

function legacyBaseline(target, text, backups) {
  for (const backup of backups) {
    try {
      const original = fs.readFileSync(backup, "utf8");
      if (!dependsOnAerial(target, parseClient(target, original))) return { original, source: "original-backup" };
    } catch { /* Only a valid pre-Aerial backup can serve as a baseline. */ }
  }
  const doc = parseClient(target, text);
  const edits = [];
  const remove = (...parts) => edits.push({ path: parts, value: undefined });
  if (target === "codex") {
    if (doc.model_provider === "aerial") for (const key of ["model_provider", "model", "model_reasoning_effort"]) remove(key);
    if (doc.profile === "aerial") remove("profile");
    remove("model_providers", "aerial");
    remove("profiles", "aerial");
    for (const [name, profile] of Object.entries(doc.profiles || {})) {
      if (name !== "aerial" && profile?.model_provider === "aerial") {
        for (const key of ["model_provider", "model", "model_reasoning_effort"]) remove("profiles", name, key);
      }
    }
  } else {
    for (const key of ["apiKeyHelper", "model", "effortLevel"]) remove(key);
    for (const key of ["ANTHROPIC_BASE_URL", "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY"]) remove("env", key);
  }
  return { original: editClient(target, text, edits, {}), source: "legacy-defaults" };
}

function readState(target, file) {
  const stateFile = takeoverPath(file);
  if (!fs.existsSync(stateFile)) return undefined;
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  if (state.schema !== SCHEMA || state.target !== target || state.file !== path.resolve(file)
    || !(state.original === null || typeof state.original === "string")
    || !(state.applied === null || typeof state.applied === "string")
    || !(state.pending === null || typeof state.pending === "string")) {
    throw new Error(`Invalid takeover state: ${stateFile}. Preserve this file and recover a pre-Aerial backup before teardown.`);
  }
  parseClient(target, state.original);
  parseClient(target, state.applied);
  parseClient(target, state.pending);
  return state;
}

export function writeClientTakeover({ target, file, original, next, backups = [] }) {
  parseClient(target, next);
  let state = readState(target, file);
  if (!state || !dependsOnAerial(target, parseClient(target, original))) {
    const baseline = dependsOnAerial(target, parseClient(target, original))
      ? legacyBaseline(target, original, backups)
      : { original, source: original === null ? "absent" : "original" };
    state = { schema: SCHEMA, target, file: path.resolve(file), ...baseline, applied: original, pending: null };
  }
  // Journal before replacing the live file. If either subsequent write fails,
  // teardown can recognize both the previous and the intended managed values.
  writePrivateFile(takeoverPath(file), `${JSON.stringify({ ...state, pending: next }, null, 2)}\n`);
  writePrivateFile(file, next);
  writePrivateFile(takeoverPath(file), `${JSON.stringify({ ...state, applied: next, pending: null }, null, 2)}\n`);
  return { baseline: state.source };
}

export function detachClientTakeover({ target, file, backups = [] }) {
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  const currentDoc = parseClient(target, current);
  let state = readState(target, file);
  if (!state && !dependsOnAerial(target, currentDoc)) return { target, file, ok: true, detached: false, reason: "not_managed" };
  if (!state) state = { ...legacyBaseline(target, current, backups), applied: current, pending: null };
  const baseline = parseClient(target, state.original);
  const edits = new Map();
  for (const managed of [state.applied, state.pending].filter(value => value !== null)) {
    for (const change of changes(baseline, parseClient(target, managed))) {
      if (isDeepStrictEqual(at(currentDoc, change.path), change.after)) {
        edits.set(JSON.stringify(change.path), { path: change.path, value: change.before });
      }
    }
  }
  const exact = current !== null && (current === state.applied || current === state.pending);
  const next = exact ? state.original : editClient(target, current, [...edits.values()], baseline);
  if (dependsOnAerial(target, parseClient(target, next))) {
    throw new Error(`${target} still references Aerial after preserving user edits. Service kept installed. Review ${file} and its pre-Aerial backup, remove the remaining Aerial provider/helper, then rerun aerial teardown.`);
  }
  let snapshot;
  if (current !== null) {
    snapshot = `${file}.aerial-pre-teardown-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    writePrivateFile(snapshot, current);
    if (next === null) fs.unlinkSync(file);
    else writePrivateFile(file, next);
  }
  if (fs.existsSync(takeoverPath(file))) {
    fs.renameSync(takeoverPath(file), `${takeoverPath(file)}.detached-${Date.now()}`);
  }
  return { target, file, ok: true, detached: true, snapshot, baseline: state.source,
    ...(state.source === "legacy-defaults" ? { note: "Original configuration was unavailable; removed Aerial settings and kept unrelated settings. Client defaults now apply." } : {}) };
}
