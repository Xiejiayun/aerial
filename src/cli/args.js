export function argValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export function requiredArgValue(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

export function parseConfigPort(value) {
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) throw new Error("port must be an integer between 1 and 65535");
  const port = Number(text);
  if (port < 1 || port > 65535) throw new Error("port must be an integer between 1 and 65535");
  return port;
}

export function parseConfigHost(value) {
  const host = String(value).trim().toLowerCase();
  if (host === "127.0.0.1" || host === "localhost" || host === "::1") return host;
  throw new Error("host must be a loopback address: 127.0.0.1, localhost, or ::1");
}
