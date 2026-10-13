export function localBaseUrl({ host, port }, pathname = "") {
  const hostname = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const url = new URL(`http://${hostname}:${port}${pathname || "/"}`);
  return pathname ? url.href : url.origin;
}
