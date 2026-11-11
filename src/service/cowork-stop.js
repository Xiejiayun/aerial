import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, readStoredApiKey } from "../shared/config.js";
import { localBaseUrl } from "../shared/urls.js";

const CLOSE_PATH = "/_aerial/cowork/close";
const MAX_REPLY_BYTES = 4096;

async function readReply(response) {
  if (!response.body) throw new Error("Cowork shutdown returned no confirmation.");
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > MAX_REPLY_BYTES) throw new Error("Cowork shutdown confirmation exceeded its limit.");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function closeCoworkBeforeStop({ config = loadConfig(), readKey = readStoredApiKey, fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  if (!config.cowork) return { closed: false, skipped: true };
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(config.host)
    || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw new Error("Cowork shutdown requires a configured loopback address and valid port.");
  }
  const key = readKey();
  if (!key) throw new Error("Cowork shutdown requires the existing local Aerial key.");
  try {
    const response = await fetchImpl(localBaseUrl(config, CLOSE_PATH), {
      method: "POST", headers: { authorization: `Bearer ${key}` },
      redirect: "error", signal: AbortSignal.timeout(timeoutMs)
    });
    if (response.status !== 200 && response.status !== 404) {
      await response.body?.cancel();
      throw new Error("Cowork shutdown was not confirmed.");
    }
    const reply = await readReply(response);
    if (response.status === 200 && reply?.ok === true && reply.provider === "cowork" && reply.closed === true) {
      return { closed: true };
    }
    // The pre-Cowork server cannot hold a Cowork profile lock. Accept only its
    // exact unknown-route reply so the first upgrade can restart that version.
    if (response.status === 404 && reply?.error?.type === "not_found"
      && reply.error.message === `No route for POST ${CLOSE_PATH}`) {
      return { closed: false, legacy: true };
    }
    throw new Error("Cowork shutdown returned an invalid confirmation.");
  } catch {
    // Never echo endpoint response text or fetch errors that could contain a key.
    throw new Error("Cowork shutdown was not confirmed; the service must remain running.");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  closeCoworkBeforeStop().then(() => { process.exitCode = 0; }, () => {
    console.error("Cowork shutdown was not confirmed; the service was not stopped.");
    process.exitCode = 1;
  });
}
