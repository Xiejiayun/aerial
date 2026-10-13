// Copilot does not expose an Anthropic tokenizer. These allowances deliberately
// leave headroom, but are estimates, not a guarantee that a request fits a model.
const IMAGE_TOKENS = 4096;
const BINARY_DOCUMENT_TOKENS = 8192;

export function estimateInputTokens(payload) {
  let mediaTokens = 0;
  const serialized = JSON.stringify(payload, (key, value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if (["image", "image_url", "input_image"].includes(value.type)) {
        mediaTokens += IMAGE_TOKENS;
        const { source, image_url, url, data, ...metadata } = value;
        return metadata;
      }
      if (value.type === "document" && ["base64", "url"].includes(value.source?.type)) {
        mediaTokens += BINARY_DOCUMENT_TOKENS;
        const { source, ...metadata } = value;
        return metadata;
      }
      if (value.type === "base64" && typeof value.data === "string") {
        mediaTokens += value.media_type?.startsWith("image/") ? IMAGE_TOKENS : BINARY_DOCUMENT_TOKENS;
        const { data, ...metadata } = value;
        return metadata;
      }
    }
    if (typeof value === "string" && /^data:[^,]+;base64,/i.test(value)) {
      mediaTokens += /^data:image\//i.test(value) ? IMAGE_TOKENS : BINARY_DOCUMENT_TOKENS;
      return "[binary content]";
    }
    return value;
  });

  let ascii = 0;
  let otherBytes = 0;
  for (const character of serialized) {
    if (character.codePointAt(0) < 128) ascii += 1;
    else otherBytes += Buffer.byteLength(character, "utf8");
  }
  // Include all request fields and structural overhead. Counting non-ASCII by
  // UTF-8 bytes avoids the severe undercount from characters / 4 for CJK text.
  return Math.max(1, Math.ceil((ascii / 3 + otherBytes + mediaTokens) * 1.2));
}
