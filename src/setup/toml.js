function tomlValue(value) {
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(String(value));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function setTomlRootString(content, key, value) {
  const line = `${key} = ${tomlValue(value)}`;
  const source = content.split(/\r?\n/);
  const firstSection = source.findIndex((sourceLine) => /^\s*\[.*\]\s*(?:#.*)?$/.test(sourceLine));
  const rootLines = firstSection === -1 ? source : source.slice(0, firstSection);
  const restLines = firstSection === -1 ? [] : source.slice(firstSection);
  const root = rootLines.join("\n");
  const rest = restLines.join("\n");
  const re = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=.*$`, "m");
  const nextRoot = re.test(root) ? root.replace(re, line) : `${root.trimEnd()}${root.trimEnd() ? "\n" : ""}${line}`;
  if (!rest) return `${nextRoot.trimEnd()}\n`;
  return `${nextRoot.trimEnd()}\n${rest}`;
}

export function upsertTomlSection(content, section, values) {
  const heading = `[${section}]`;
  const lines = Object.entries(values).map(([key, value]) => `${key} = ${tomlValue(value)}`).join("\n");
  const block = `${heading}\n${lines}\n`;
  const source = content.split(/\r?\n/);
  const start = source.findIndex((line) => line.trim() === heading);
  if (start === -1) return `${content.trimEnd()}\n\n${block}`;
  let end = source.length;
  for (let i = start + 1; i < source.length; i += 1) {
    if (/^\s*\[.*\]\s*$/.test(source[i])) {
      end = i;
      break;
    }
  }
  source.splice(start, end - start, ...block.trimEnd().split("\n"));
  return `${source.join("\n").trimEnd()}\n`;
}
