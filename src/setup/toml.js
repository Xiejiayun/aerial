import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { parseForESLint } from "toml-eslint-parser";

const keyPath = (key) => key.keys.map(part => part.type === "TOMLBare" ? part.name : part.value);
const startsWithPath = (value, prefix) => prefix.every((part, index) => value[index] === part);
const samePath = (a, b) => a.length === b.length && startsWithPath(a, b);
const keyText = (key) => /^[\w-]+$/.test(key) ? key : JSON.stringify(key);

function inlineValue(value) {
  if (Array.isArray(value)) return `[ ${value.map(inlineValue).join(", ")} ]`;
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return `{ ${Object.entries(value).map(([key, val]) => `${keyText(key)} = ${inlineValue(val)}`).join(", ")} }`;
  }
  return stringifyToml({ value }).trim().replace(/^value\s*=\s*/, "");
}

function readDocument(content) {
  // smol-toml is the client's semantic validation gate. The syntax tree gives
  // ranges for edits without mistaking text inside strings for table headers.
  const doc = parseToml(content);
  const ast = parseForESLint(content).ast;
  const nodes = ast.body[0].body;
  const entries = nodes.flatMap(node => node.type === "TOMLTable"
    ? node.body.map(entry => ({ node: entry, path: [...node.resolvedKey, ...keyPath(entry.key)] }))
    : [{ node, path: keyPath(node.key) }]);
  return { doc, nodes, entries };
}

function getPath(doc, parts) {
  let value = doc;
  for (const key of parts) {
    if (!value || !Object.hasOwn(value, key)) return undefined;
    value = value[key];
  }
  return value;
}

function assignPath(doc, parts, value) {
  let node = doc;
  for (const part of parts.slice(0, -1)) {
    if (!Object.hasOwn(node, part)) Object.defineProperty(node, part, { value: {}, writable: true, enumerable: true, configurable: true });
    if (!node[part] || typeof node[part] !== "object" || Array.isArray(node[part])) {
      throw new Error(`Cannot update TOML path ${parts.join(".")}: ${part} is not a table.`);
    }
    node = node[part];
  }
  const last = parts.at(-1);
  if (value === undefined) delete node[last];
  else Object.defineProperty(node, last, { value, writable: true, enumerable: true, configurable: true });
}

function replaceRanges(content, edits) {
  let result = content;
  for (const { range: [from, to], text = "" } of edits.sort((a, b) => b.range[0] - a.range[0])) {
    result = result.slice(0, from) + text + result.slice(to);
  }
  return result;
}

function validated(content) {
  parseToml(content);
  return content;
}

// Update one semantic path, including quoted keys, dotted assignments, inline
// tables, and standard tables. Unrelated source and comments stay in place.
export function setTomlValue(content, parts, value) {
  const { doc, nodes, entries } = readDocument(content);
  const ancestor = entries.find(entry => startsWithPath(parts, entry.path));
  if (ancestor) {
    const exact = samePath(ancestor.path, parts);
    if (exact && value === undefined) return validated(replaceRanges(content, [{ range: ancestor.node.range }]));
    let next = value;
    if (!exact) {
      const table = getPath(doc, ancestor.path);
      if (!table || typeof table !== "object" || Array.isArray(table)) throw new Error(`TOML ${ancestor.path.join(".")} must be a table.`);
      assignPath(table, parts.slice(ancestor.path.length), value);
      next = table;
    }
    return validated(replaceRanges(content, [{ range: ancestor.node.value.range, text: inlineValue(next) }]));
  }

  const edits = [];
  for (const node of nodes) {
    if (node.type === "TOMLTable" && startsWithPath(node.resolvedKey, parts)) {
      edits.push({ range: node.range });
    } else {
      const children = node.type === "TOMLTable" ? node.body : [node];
      const base = node.type === "TOMLTable" ? node.resolvedKey : [];
      for (const entry of children) {
        if (startsWithPath([...base, ...keyPath(entry.key)], parts)) edits.push({ range: entry.range });
      }
    }
  }
  let next = replaceRanges(content, edits);
  if (value === undefined) return validated(next);
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  if (value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)) {
    let tree = value;
    for (const part of [...parts].reverse()) tree = { [part]: tree };
    next = `${next.trimEnd()}${next.trim() ? newline + newline : ""}${stringifyToml(tree).replace(/\n/g, newline)}`;
  } else {
    const firstTable = readDocument(next).nodes.find(node => node.type === "TOMLTable");
    const at = firstTable?.range[0] ?? next.length;
    const before = next.slice(0, at);
    const line = `${parts.map(keyText).join(".")} = ${inlineValue(value)}${newline}`;
    next = before + (before && !before.endsWith("\n") ? newline : "") + line + next.slice(at);
  }
  return validated(next);
}

export const setTomlRootString = (content, key, value) => setTomlValue(content, [key], value);
export function upsertTomlSection(content, section, values) {
  const parts = section.split(".");
  const current = getPath(parseToml(content), parts);
  const children = Object.fromEntries(Object.entries(current || {}).filter(([, value]) =>
    value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)));
  return setTomlValue(content, parts, { ...children, ...values });
}
export const removeTomlSection = (content, section) => setTomlValue(content, section.split("."), undefined);
