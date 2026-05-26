import crypto from "node:crypto";

export function randomApiKey() {
  return `aerial_${crypto.randomBytes(24).toString("base64url")}`;
}

export function hashApiKey(key, salt = crypto.randomBytes(16).toString("base64url")) {
  const hash = crypto.scryptSync(key, salt, 32).toString("base64url");
  return `scrypt$${salt}$${hash}`;
}

export function verifyApiKey(key, encoded) {
  if (!key || !encoded) return false;
  const [kind, salt, expected] = encoded.split("$");
  if (kind !== "scrypt" || !salt || !expected) return false;
  const actual = crypto.scryptSync(key, salt, 32);
  const expectedBuffer = Buffer.from(expected, "base64url");
  return actual.length === expectedBuffer.length && crypto.timingSafeEqual(actual, expectedBuffer);
}

export function redact(value) {
  if (!value) return "";
  if (value.length <= 8) return "********";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}
