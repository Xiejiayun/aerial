import { assertDirectConnection } from "../shared/config.js";

export async function upstreamFetch(url, init = {}) {
  init.signal?.throwIfAborted();
  assertDirectConnection();
  return globalThis.fetch(url, init);
}
