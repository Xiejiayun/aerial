export const PROXY_MODE_DISABLED = "disabled";
export const PROXY_MODE_AUTO = "auto";

export function normalizeProxyMode(value) {
  return value === PROXY_MODE_AUTO ? PROXY_MODE_AUTO : PROXY_MODE_DISABLED;
}

export function normalizeProxyEndpoint(value) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return undefined;
  }
  const protocol = url.protocol === "socks:" || url.protocol === "socks5h:" ? "socks5:" : url.protocol;
  if (!["http:", "https:", "socks5:"].includes(protocol)) return undefined;
  if (!url.hostname) return undefined;
  const pathPart = `${url.pathname || "/"}${url.search || ""}${url.hash || ""}`;
  if (pathPart !== "/") return undefined;
  const auth = url.username ? `${url.username}${url.password ? `:${url.password}` : ""}@` : "";
  return `${protocol}//${auth}${url.host}`;
}

export function isSocksProxyEndpoint(value) {
  const endpoint = normalizeProxyEndpoint(value);
  return Boolean(endpoint?.startsWith("socks5://"));
}

export function redactProxyEndpoint(value) {
  const normalized = normalizeProxyEndpoint(value);
  const text = normalized || (typeof value === "string" ? value : undefined);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    if (!url.username && !url.password) return normalized || text;
    const protocol = url.protocol === "socks:" || url.protocol === "socks5h:" ? "socks5:" : url.protocol;
    if (normalized) return `${protocol}//redacted@${url.host}`;
    url.protocol = protocol;
    url.username = "redacted";
    url.password = "";
    return url.toString();
  } catch {
    return text;
  }
}

export function redactProxySource(value) {
  if (typeof value !== "string") return value;
  return value.replace(/\b(?:https?|socks5h?|socks):\/\/[^\s),]+/g, (url) => redactProxyEndpoint(url) || url);
}
