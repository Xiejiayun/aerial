# Aerial Images API

## Goal and scope

Ship image generation and editing in the existing local npm service. An Images
client uses the same GitHub login, Aerial key, service lifecycle, and upstream
proxy configuration as existing conversation clients. Prepare version 0.3.9 for
review; publishing follows the existing main-only release workflow after merge.

This extends the original MVP's image exclusion. It does not add a website,
public hosting, image storage/history, background jobs, a new CLI image command,
MCP tools, or native Codex image-tool support. Conversation setup continues to
require the model's existing Responses or Messages route.

## API contract

| Local method/path | Copilot method/path | Model route annotation |
| --- | --- | --- |
| POST /v1/images/generations | POST /v1/images/generations | image_generation |
| POST /v1/images/edits | POST /v1/images/edits | image_edit |

Models and supported endpoints are discovered from Copilot's live `/models`
catalog. Do not hardcode an image model, infer a route from `type: image`, remap
model aliases, or turn a conversation request into an image request. The model
selects accepted sizes, formats, quality levels, file types and parameter shapes.

Generation JSON and edit JSON/multipart are forwarded byte-for-byte, including
multipart boundaries, repeated files, masks, and unknown upstream options.
Local authentication runs before reading uploads. The existing total request
limit remains 32 MiB, counting multipart framing and JSON/base64 expansion.
Requests are buffered for replay on one authentication retry; uploads are not
streamed end-to-end. Client-facing binding remains loopback-only, without CORS.

## Transport and failure behavior

Small image handlers call the existing transport with cache observation
disabled. The transport still owns token refresh, upstream proxy routing,
request cancellation, status codes, and response header filtering. Conversation
handlers keep their current defaults. Image handlers do not apply reasoning,
conversation cache policy, or encrypted tool replay transformations.

Disabling cache observation avoids parsing image request bodies and cloning or
parsing large base64 JSON responses. JSON, binary, and SSE response bodies stream
unchanged through the existing backpressure-aware server writer. No image bytes
or prompts are persisted or logged by the service; callers own output files.

On upstream 401, discard the rejected response, refresh once, and replay the
identical buffered upload. Preserve subsequent errors, including 400/403/429/5xx,
without automatic retry. Keep allowed retry, rate-limit and request-ID headers.
Do not silently regenerate, upscale, return fabricated results, or claim refunds
when a client cancels after upstream processing has begun.

## Discovery and usage

Annotate images independently as `image_generation` and `image_edit`, and add
`imageGenerations`/`imageEdits` counts to probe and proxy status reports. Standard
probes, including `--live`, never spend image allowance; explicitly report image
inference as unchecked. An image-only catalog is discoverable but does not make
a conversation live probe pass.

Ship Node.js examples in the published usage guide for model discovery, a native
4K generation request, a PNG download, and multipart editing. Examples keep keys
in the caller's backend, allow a suitable generation timeout, and surface
upstream errors. Restart loaded service processes after an npm upgrade.

## Acceptance and verification

- Both routes work through a real local HTTP listener with local bearer or
  x-api-key authentication, and reject invalid keys before reading uploads.
- Preserve JSON and multipart bytes, repeated files, masks, options, response
  data/usage, streaming events, and diagnostics. Do not clone image responses.
- Enforce upload limits; retry only once on 401 with identical bytes; cancel
  upstream sockets and streaming bodies on disconnect. Keep health responsive.
- Discover only advertised image routes; probe never invokes image inference.
- Run the complete test suite, syntax checks, CLI smoke, npm packaging, secret
  scan, dependency audit, and a clean tarball installation smoke test.
- Verify a real 3840x2160 generation and a multipart edit through the new HTTP
  routes with the user's account. Keep generated artifacts and credentials out
  of Git/npm. Report actual results and any CI checks still pending in the PR.
