import { proxyFetch } from "./transport.js";

export function proxyImageGenerations(request) {
  return proxyFetch("/v1/images/generations", request, { observeCache: false });
}

export function proxyImageEdits(request) {
  // Preserve multipart boundaries, file bytes and JSON edits unchanged. Image
  // requests must not pass through the conversation/effort transformations.
  return proxyFetch("/v1/images/edits", request, { observeCache: false });
}
