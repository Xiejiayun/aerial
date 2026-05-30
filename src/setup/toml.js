import { stringify as stringifyToml } from "smol-toml";

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tomlScalar(value) {
  return stringifyToml({ value }).trim().replace(/^value\s*=\s*/, "");
}

function serializeBlock(values) {
  const text = stringifyToml(values).trimEnd();
  return text ? text.split("\n") : [];
}

function sectionName(line) {
  const match = /^\s*\[\[?(.+?)\]?\]\s*(?:#.*)?$/.exec(line);
  if (!match) return undefined;
  const inner = match[1].trim();
  if (!inner) return undefined;
  const segment = `(?:"[^"]*"|'[^']*'|[A-Za-z0-9_-]+)`;
  return new RegExp(`^${segment}(?:\\s*\\.\\s*${segment})*$`).test(inner) ? inner : undefined;
}

function isSectionHeader(line) {
  return sectionName(line) !== undefined;
}

function isSectionOrChild(line, section) {
  const name = sectionName(line);
  return name === section || name?.startsWith(`${section}.`);
}

export function setTomlRootString(content, key, value) {
  const line = `${key} = ${tomlScalar(value)}`;
  const source = content.split(/\r?\n/);
  const firstSection = source.findIndex(isSectionHeader);
  const rootLines = firstSection === -1 ? source : source.slice(0, firstSection);
  const restLines = firstSection === -1 ? [] : source.slice(firstSection);
  const re = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  const existing = rootLines.findIndex((rootLine) => re.test(rootLine));
  if (existing === -1) {
    let insertAt = rootLines.length;
    while (insertAt > 0 && !rootLines[insertAt - 1].trim()) insertAt -= 1;
    rootLines.splice(insertAt, 0, line);
  } else {
    rootLines[existing] = line;
  }
  const merged = [...rootLines, ...restLines].join("\n");
  return `${merged.trimEnd()}\n`;
}

export function upsertTomlSection(content, section, values) {
  const heading = `[${section}]`;
  const block = [heading, ...serializeBlock(values)];
  const source = content.split(/\r?\n/);
  const start = source.findIndex((line) => sectionName(line) === section);
  if (start === -1) {
    const base = content.trimEnd();
    return `${base ? `${base}\n\n` : ""}${block.join("\n")}\n`;
  }
  let end = source.length;
  for (let i = start + 1; i < source.length; i += 1) {
    if (isSectionHeader(source[i])) {
      end = i;
      break;
    }
  }
  while (end > start + 1 && !source[end - 1].trim()) end -= 1;
  source.splice(start, end - start, ...block);
  return `${source.join("\n").trimEnd()}\n`;
}

export function removeTomlSection(content, section) {
  const source = content.split(/\r?\n/);
  const kept = [];
  let removed = false;
  for (let i = 0; i < source.length;) {
    if (isSectionOrChild(source[i], section)) {
      removed = true;
      i += 1;
      while (i < source.length && !isSectionHeader(source[i])) i += 1;
      while (i < source.length && !source[i].trim()) i += 1;
    } else {
      kept.push(source[i]);
      i += 1;
    }
  }
  if (!removed) return content.trim() ? `${content.trimEnd()}\n` : "";
  const merged = kept.join("\n").trim();
  return merged ? `${merged}\n` : "";
}
