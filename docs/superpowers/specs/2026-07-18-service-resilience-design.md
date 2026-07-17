# Aerial Service Resilience Design

Date: 2026-07-18

## Problem

An installed Aerial background service can become temporarily or permanently unavailable after running for some time.

The local service logs contain repeated fatal `ERR_HTTP_HEADERS_SENT` exceptions from `src/proxy/server.js`. The failure sequence is:

1. A proxied Fetch `Response` starts streaming to the Node `ServerResponse`, so the status and headers are committed.
2. Reading or writing the response body fails after that point.
3. The outer request error handler tries to replace the partial response with a JSON error and calls `setHeader` again.
4. Node throws `ERR_HTTP_HEADERS_SENT` from inside the error handler. The rejected async server callback is unhandled and terminates the process.

On macOS, launchd currently restarts Aerial only after an unsuccessful or signal-based exit. That has recovered the observed crashes, but it still permits a loaded service to remain stopped after a clean exit. Windows Task Scheduler has no equivalent process-level recovery in the current task definition, so preventing this crash is important on both platforms.

## Goals

- A response-body failure after headers are committed must not terminate the Aerial process.
- A client disconnect while the server is waiting for backpressure must not leave a request handler stuck indefinitely.
- Errors that happen before headers are committed must continue to return the existing structured JSON error response.
- A loaded macOS LaunchAgent must remain continuously supervised until `aerial service stop` or uninstall explicitly unloads it.
- Streaming behavior, authentication, status codes, and service lifecycle commands must retain their current contracts.

## Non-goals

- Buffering complete upstream responses before sending them.
- Adding a new retry policy for individual inference requests.
- Replacing launchd or Task Scheduler with an Aerial-specific daemon.
- Redesigning Windows Task Scheduler recovery in this change.
- Refactoring unrelated proxy or service lifecycle code.

## Design

### Response ownership

`writeNodeResponse` remains the only function that commits and streams a Fetch `Response` to Node's `ServerResponse`.

The outer request handler will distinguish two error phases:

- Before `res.headersSent`: return the existing JSON error with status 413, 503, or 500.
- After `res.headersSent`: do not change status, headers, or append a second JSON document. Log the request failure, then destroy the incomplete response when it is still open. The affected client observes a truncated/failed request and can retry, while the server remains available for later requests.

The handler will also treat an already destroyed response or an abort-shaped error as a request abort and avoid writing to it.

### Backpressure and disconnects

When `res.write` returns `false`, the current implementation waits only for `drain`. The replacement wait will settle on `drain`, response `close`, response `error`, or request abort. All temporary listeners will be removed when one outcome wins.

- `drain` resumes streaming.
- `close` or abort stops streaming and cancels the Fetch body reader.
- `error` propagates to the outer phase-aware error handler.

This keeps the normal streaming path unchanged while preventing disconnected clients from stranding an async request handler.

### macOS supervision

The generated LaunchAgent will use boolean `KeepAlive = true` instead of the conditional `SuccessfulExit`/`Crashed` dictionary. `RunAtLoad` and `ThrottleInterval = 10` remain unchanged.

This means launchd keeps the job running regardless of the previous exit status. Explicit service stop and uninstall remain valid because both use `launchctl bootout`, which unloads the job rather than merely signaling its process. Reinstall continues to regenerate the plist.

### Observability

Existing `request_end` error logging remains the authoritative record of the failed request. No request bodies, credentials, or new sensitive fields will be logged. A post-header failure will include the original error message in the existing redacted structured log path.

## Testing

Add regression coverage that proves:

1. A response stream that emits a chunk and then errors does not crash the process; the partial request fails and a subsequent `/health` request still returns 200.
2. A failure before headers are sent still returns the current structured JSON error response.
3. A disconnect/backpressure wait terminates without waiting forever or trying to write a second response.
4. The generated macOS plist contains boolean `KeepAlive` and no conditional `SuccessfulExit` or `Crashed` entries.
5. Existing service start, stop, restart, install, and proxy server tests continue to pass.

Run the focused server/service tests first, followed by the complete `npm test` suite using the repository's available Node binary.

## Success criteria

- The captured `ERR_HTTP_HEADERS_SENT` failure mode has a regression test that fails before the fix and passes after it.
- After a mid-stream failure, the same server process answers a health request successfully.
- No code path calls `setHeader` after `res.headersSent` is true.
- A freshly rendered macOS plist expresses unconditional supervision.
- The full test suite passes with no unrelated worktree changes included.
