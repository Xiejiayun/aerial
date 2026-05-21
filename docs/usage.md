# Aerial MVP Usage

This document describes the current MVP implementation.

## 1. Install

```bash
npm install -g @jiayunxie/aerial
```

After install, the CLI is available as `aerial`.

For local development against the repo source:

```bash
git clone https://github.com/Xiejiayun/aerial.git
cd aerial
npm install -g .
# or run without global install:
node src/cli.js --help
```

## 2. Configure Local Clients

```bash
aerial setup all --model <model-id>
```

Aerial creates a local API key, stores it privately, and configures supported clients to use it. On Windows, restart the terminal or VS Code after first setup so newly persisted user environment variables are visible to Codex.

## 3. Login To GitHub

```bash
aerial login
```

Open the printed URL, enter the user code, and authorize the GitHub OAuth device flow. Aerial saves the GitHub access token locally and exchanges it for short-lived Copilot JWTs when proxy requests arrive.

## 4. Start Server

```bash
aerial start
```

Default URL: `http://127.0.0.1:18181`.

## 5. Configure Codex CLI

```bash
aerial setup codex --model <model-id>
```

The setup command backs up and merges `~/.codex/config.toml`, then persists the local key for new user sessions when the platform supports it.

For a dry inspection without touching your real config, set `HOME`/`USERPROFILE` to a temporary directory before running this command.

## 6. Configure Claude Code

```bash
aerial setup claude --model <model-id>
```

The setup command backs up and merges `~/.claude/settings.json`, using `apiKeyHelper = "aerial key print"` and `ANTHROPIC_BASE_URL=http://127.0.0.1:18181`. When you pass `--model` or set Aerial's `defaultModel`, it also writes Claude Code's default `model` to that Aerial-routed model.

If Claude Code was previously pointed at another Anthropic-compatible gateway, setup removes stale `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL`, and `ANTHROPIC_DEFAULT_*_MODEL` entries from the managed `env` block.

For a dry inspection without touching your real config, set `HOME`/`USERPROFILE` to a temporary directory before running this command.

## 7. Verify

```bash
aerial doctor
aerial probe
```

Each model returned by `/v1/models` includes an `aerial` field that tells you whether the MVP can route it:

```json
"aerial": {
  "supported": true,
  "routes": ["responses", "responses_websocket", "chat"],
  "notes": []
}
```

Use `responses` models for Codex, `messages` models for Claude Code, and `chat` models only for generic Chat Completions clients. `responses_websocket` means Aerial can optionally use Copilot's upstream `ws:/responses` transport for streaming Responses calls when `AERIAL_RESPONSES_WEBSOCKET=on` is set; with the opt-in off (default), Aerial always uses HTTP upstream Responses. Models marked with `embeddings_not_implemented` or `no_supported_endpoint_advertised` need additional Aerial work before they are first-class choices.

## 7.5 Manage Setup

```bash
aerial setup status [--json]
aerial setup restore <codex|claude|all> --latest
aerial disable
```

`aerial setup status` reports whether each supported client is currently configured to route through Aerial, plus the local API key and GitHub token files. The state for each client is one of:

- `aerial` — fully configured for the current Aerial host/port.
- `aerial-stale` — was configured by Aerial, but the file no longer matches (for example, host or port was changed via `aerial config set`).
- `aerial-drift` — partial Aerial markers, likely from manual edits.
- `not-aerial` — file exists with no Aerial signature.
- `missing` — file does not exist.
- `invalid` — file exists but failed to parse.

`--json` prints a machine-readable report under the stable schema `aerial.setup-status.v1`:

```json
{
  "schema": "aerial.setup-status.v1",
  "platform": "darwin",
  "config": { "host": "127.0.0.1", "port": 18181 },
  "auth": {
    "api_key":      { "file": "/Users/you/Library/Application Support/aerial/api_key", "exists": true },
    "github_token": { "file": "/Users/you/Library/Application Support/aerial/github_token", "exists": false }
  },
  "clients": {
    "codex": {
      "target": "codex",
      "state": "aerial",
      "file": "/Users/you/.codex/config.toml",
      "backups": ["/Users/you/.codex/config.toml.aerial-backup-2026-05-20T10-00-00-000Z"],
      "model": "gpt-4.1",
      "baseUrl": "http://127.0.0.1:18181/v1"
    },
    "claude": {
      "target": "claude",
      "state": "aerial",
      "file": "/Users/you/.claude/settings.json",
      "backups": [],
      "model": "claude-sonnet-4.6",
      "baseUrl": "http://127.0.0.1:18181"
    }
  }
}
```

Stability rules for `aerial.setup-status.v1`: new fields may be added at any level in future Aerial releases — consumers must ignore unknown keys. Existing fields will not be removed or repurposed without bumping the `schema` value. Field types remain constant within a schema version.

`aerial setup restore <codex|claude|all> --latest` restores the most recent `*.aerial-backup-<ISO>` snapshot for the named client. Before overwriting, it takes a `*.aerial-pre-restore-<ISO>` snapshot of the current file so the restore itself is reversible. With `all`, both clients are restored best-effort and the command exits non-zero if any individual restore failed. If there is no backup to restore, the command prints a note and exits 0.

`aerial disable` first runs `setup restore all --latest` and then, only if every client restore succeeded, uninstalls the local Aerial service via `aerial service uninstall`. If any client restore reports a failure, the service is left running and `aerial disable` exits non-zero; resolve the restore errors, then rerun `aerial disable` (or call `aerial service uninstall` directly once the client config is in the state you want).

## 7.6 Run Aerial As A Local Service

```bash
aerial service install
aerial service start
aerial service status [--json]
aerial service stop
aerial service restart
aerial service uninstall
```

Aerial ships a thin platform wrapper around the user-mode service primitives provided by the host OS — there is no Aerial-specific daemon. Two platforms are supported:

- macOS: a user-level launchd `LaunchAgent` at `~/Library/LaunchAgents/com.jiayunxie.aerial.plist` invokes a generated POSIX shell wrapper at `<config-dir>/bin/aerial-service.sh`. The plist is regenerated on every `aerial service install` with a `<!-- Generated by aerial; do not edit -->` header, `KeepAlive = { SuccessfulExit = false; Crashed = true }` so the agent only restarts on crash (not on a clean exit), `ThrottleInterval = 10` to cap restart cadence, and no `StandardOutPath`/`StandardErrorPath` keys (the wrapper owns stdio redirection so launchd does not hold a write fd that would race with rotation). The launchctl command path is `gui/<uid>` (per-user agent, no privilege escalation). Start/stop go through `launchctl bootstrap` and `launchctl bootout` against that domain — never `launchctl kill`.
- Windows: a Task Scheduler task named `AerialLocalProxy`, `/SC ONLOGON /RL LIMITED`, executes a PowerShell wrapper at `<config-dir>\bin\aerial-service.ps1` (default `%APPDATA%\aerial\bin\aerial-service.ps1`). The wrapper is regenerated on every `aerial service install`. The `/TR` argument is wrapped in escaped quotes so paths that contain spaces or non-ASCII characters work without manual quoting.
- Linux: not implemented in this release. `aerial service install|start|stop|restart|uninstall` throws an unsupported-platform error and exits 1; `aerial service status --json` still emits a schema-valid document with `"supported": false` and exits 1. Run `aerial start` directly or wrap it in your own init system.

Both wrappers do the same three things before exec-ing the proxy: (1) startup-rotate the captured stdio log (`aerial-stdio.log` → `.1` → `.2` → `.3`) if it has grown beyond the configured cap; (2) export `AERIAL_LOG_FILE=<config-dir>/logs/aerial.log`, plus `AERIAL_LOG_MAX_BYTES` and `AERIAL_LOG_BACKUPS` (default `5242880` / `3`, or whatever value was present in the installer's environment — see below), and — when `AERIAL_CONFIG_DIR` was set at install time — re-export `AERIAL_CONFIG_DIR` so the service sees the same config root as the installer; (3) `exec` `node src/cli.js start --host <host> --port <port>` with stdout and stderr appended to `aerial-stdio.log`. The structured event log is opt-in via `AERIAL_LOG_FILE`: when this env var is set (always set by the wrapper, never by foreground `aerial start`), structured events go to that file only; when unset, they go to stderr only. There is no double-write.

Wrapper env values are baked in at install time. If you set `AERIAL_LOG_MAX_BYTES` and/or `AERIAL_LOG_BACKUPS` in the shell before running `aerial service install`, the generated wrapper hard-codes those values and the next start of the service inherits them. Changing the env in another shell after install has no effect on the already-installed wrapper. To apply new values to an already-managed service, rerun `aerial service install` (which always regenerates the definition, including the wrapper) and then `aerial service restart` to swap the running process onto the regenerated wrapper.

`aerial service install` follows this state machine, in order, against the configured host/port:

1. Probe `GET /health` with a 1.5s timeout.
2. If the port answers with a non-Aerial response (any 200 with a body that does not declare `service=aerial`, or a 200 with a body that is not parseable JSON) → exit 1 with `reason=port_conflict`. No definition is written.
3. If the port answers as Aerial AND the local service manager reports the unit/task loaded → the definition (plist+wrapper on macOS, wrapper+`schtasks /Create` on Windows) is regenerated, but the already-running service is NOT restarted (the install command never starts a second instance, and never recycles the running one). Exit 0 with `ok=true`, `definitionUpdated=true`, and `note="already running (service-managed); definition refreshed; run \`aerial service restart\` to apply wrapper/env changes"`. On Windows, if `schtasks /Create` fails while refreshing the definition the command exits 1 with `reason=managed_definition_refresh_failed`; the running task is untouched.
4. If the port answers as Aerial AND the local service manager does NOT report the unit/task loaded → the definition is regenerated, but the service is NOT started. Exit 1 with `reason=foreground_running`, `definitionUpdated=true`, and an actionable next step: stop the foreground process, then run `aerial service start`. This guarantees `install` never causes two Aerial instances to fight for the port.
5. Otherwise (port absent) → write the definition, then start the service (`launchctl bootstrap` on macOS, `schtasks /Run` on Windows). Exit 0.

`aerial service start` enforces a similar shape: it refuses with `reason=not_installed` and exit 1 if the unit/task does not exist; it refuses with `reason=port_conflict` and exit 1 if a non-Aerial process owns the port; it refuses with `reason=foreground_running` and exit 1 if Aerial is already running in the foreground (not via the service manager); it returns idempotent success with `note=already running (service-managed)` if the service is already up; otherwise it starts the service. `aerial service stop` is idempotent (exit 0 + `note` when nothing is installed or nothing is running). `aerial service uninstall` is idempotent on the "no service installed" branch, but does NOT swallow real teardown failures: on macOS, if the service is loaded and `launchctl bootout` returns non-zero, the plist and wrapper are preserved and the command exits 1 with `reason=bootout_failed`; on Windows, if `schtasks /Delete` returns non-zero, the wrapper is preserved and the command exits 1 with `reason=delete_failed`. In both cases the message includes a retry pointer. `aerial service restart` blocks the start step when the stop step fails: if `stop` returns `ok=false`, the response includes `reason=stop_failed` and `start` is not attempted. `aerial disable` follows the same contract: it restores client configs first, then calls `serviceUninstall`. Only an `unsupported platform` exception is treated as a silent skip (Linux); any supported-platform uninstall failure (`ok=false` or non-`unsupported-platform` throw) propagates as exit 1 with a retry pointer at `aerial service uninstall`.

If GitHub login is not yet configured, install and start still succeed (when reachable) and emit a structured warning pointing at `aerial login`; proxy requests return 503 until you log in. After rotating the local API key or moving the config directory, restart the service with `aerial service restart` so the new credentials are picked up.

`aerial service status` reports a single aggregated view:

```json
{
  "schema": "aerial.service-status.v1",
  "platform": "darwin",
  "supported": true,
  "config": { "host": "127.0.0.1", "port": 18181 },
  "service": { "platform": "darwin", "installed": true, "loaded": true, "pid": 12345 },
  "health": { "ok": true, "status": 200, "body": { "ok": true, "service": "aerial" }, "aerial": true, "supervisor": "service-managed" },
  "logs": {
    "dir": "/Users/you/Library/Application Support/aerial/logs",
    "primary": { "file": ".../aerial.log", "exists": true, "size": 4096 },
    "stdio":   { "file": ".../aerial-stdio.log", "exists": true, "size": 1024 },
    "maxFileBytes": 5242880,
    "rotateKeep": 3,
    "source": "installed-wrapper"
  },
  "auth": {
    "api_key":      { "file": "...", "state": "present" },
    "github_token": { "file": "...", "state": "missing" }
  },
  "summary": "running (service-managed)"
}
```

`service.installed` reflects whether the unit / scheduled task exists; `service.loaded` reflects whether the service is currently running (launchd `PID` present, schtasks `Status = Running`). `health` probes `GET /health` with a 1.5s timeout; an unreachable proxy is reported as `{ "ok": false, "error": "<reason>" }` and does NOT fail the command on supported platforms. When the port answers but the body is not Aerial (or is not JSON), `health.portConflict=true` and `health.conflictReason=<reason>`; when the port answers as Aerial, `health.aerial=true` and `health.supervisor` is one of `"service-managed"` (unit/task is loaded) or `"foreground"` (someone is running `aerial start` directly). The `summary` field collapses the matrix to a single human-readable line: `"running (service-managed)"`, `"running (foreground)"`, `"port conflict (non-Aerial process on port)"`, `"installed (not running)"`, `"not installed"`, `"manager reports up but health failed"`, or `"unsupported"`. The `auth.*.state` field is tri-state: `"present"`, `"missing"`, or `"invalid"` (file exists but unreadable / empty); no network call to GitHub or to the Aerial proxy is made. The `logs.source` field tells you what `logs.maxFileBytes` / `logs.rotateKeep` actually describe: `"installed-wrapper"` means the values were parsed from the wrapper that is already on disk (so they reflect what the *currently installed* service will use on next start), and `"next-install-default"` means no installed wrapper was found and the values fall back to what the next `aerial service install` would bake from the current shell env. On unsupported platforms (Linux), `supported=false` and the command exits 1; the document is still schema-valid so scripts can branch on `supported`.

Stability rules for `aerial.service-status.v1` match `aerial.setup-status.v1`: additive evolution only, no field rename or repurpose without a schema bump.

## 7.7 Logs

Aerial writes two log files under the configured log directory (default `<config-dir>/logs`, override via `AERIAL_LOG_DIR`). Only the service wrapper opts in to file logging by default; running `aerial start` directly in a terminal still writes structured events to stderr.

- `aerial.log` — primary structured event log (`request_start`, `request_end`, `cache_observe`, `service_install`, etc.). One JSON object per line. Single line cap: 64 KiB; lines larger than that are replaced with a JSON marker `{"ts":...,"event":...,"truncated":true,"originalBytes":N}` so log readers stay parseable. Default file cap: 5 MiB before rotation (override via `AERIAL_LOG_MAX_BYTES`). Default ring size: 3 backups — `aerial.log`, `aerial.log.1`, `aerial.log.2`, `aerial.log.3`; oldest is dropped on the next rotation (override via `AERIAL_LOG_BACKUPS`).
- `aerial-stdio.log` — captures stdout/stderr from the child `aerial start` process when invoked through the service wrapper. This is the bucket for crash traces and any non-JSON output. The wrapper applies the same 5 MiB / 3-file rotation policy at startup (before exec-ing node) so a crashed run does not get appended to an indefinitely growing file.

The structured event writer is opt-in via `AERIAL_LOG_FILE`. When this env is unset (foreground `aerial start`, unit tests), `logEvent` writes to `console.error` only and never touches the filesystem. When the env is set (always by the wrapper), `logEvent` writes only to the file — `console.error` is suppressed for structured events to avoid double-writing into the wrapper-captured stdio. This is why `aerial.log` is created by the service path and absent from foreground runs.

Aerial never logs request bodies, raw GitHub tokens, raw Aerial API keys, or `Authorization` headers. Field-level redaction is applied to keys named `authorization`, `token`, `apiKey`, `api_key`, `githubToken`, `github_token`, `body`, `password`, or `secret`.

If the log directory cannot be created, the writer is disabled for the lifetime of the process and a single warning is written to stderr — Aerial keeps running. Use `aerial service status --json` to read the current `logs` block.



## 8. Probe Capabilities

```bash
aerial probe
```

This prints the current model matrix returned by Copilot plus Aerial's route annotations. It is the fastest way to see which models currently expose `responses`, `messages`, or `chat` routes.

For a low-cost end-to-end check:

```bash
aerial probe --live
```

`--live` sends one small request through the first available model for each supported route. Use `--json` when you want machine-readable output for CI or debugging.

For streaming `/v1/responses` requests, Aerial defaults to HTTP upstream Responses. Set `AERIAL_RESPONSES_WEBSOCKET=on` to opt into Copilot's upstream `ws:/responses` transport for streaming Responses calls; Aerial then converts upstream WebSocket events back to SSE for the local client. Direct client WebSocket upgrades to Aerial are still not exposed and return `501 Not Implemented`; clients should keep using HTTP `POST /v1/responses`.

## 9. Use Prompt Cache

Aerial does not implement a local prompt-content cache. It forwards cache protocol fields to Copilot and returns upstream usage fields unchanged. This is the intended design: prompts are not written to a local cache, and cache hits are controlled by the upstream service.

For Codex/OpenAI Responses clients, users normally do not need to send cache fields directly. A manual request can still override Aerial's defaults:

```bash
curl -s http://127.0.0.1:18181/v1/responses \
  -H "Authorization: Bearer $AERIAL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.4-mini",
    "input": "<long stable prefix first, variable request last>",
    "prompt_cache_retention": "in_memory",
    "prompt_cache_key": "my-project"
  }'
```

For Claude Code or Anthropic Messages clients, Aerial automatically adds Anthropic `cache_control` to stable `system` content when the client omits cache hints. You can still send `cache_control` manually to choose the exact breakpoint:

```json
{
  "model": "claude-sonnet-4.6",
  "max_tokens": 1024,
  "system": [
    {
      "type": "text",
      "text": "Long stable project context...",
      "cache_control": { "type": "ephemeral" }
    }
  ],
  "messages": [{ "role": "user", "content": "Summarize the current diff" }]
}
```

Aerial automatically applies ephemeral prompt cache hints for OpenAI-style `/v1/responses`, `/v1/chat/completions`, and Anthropic-style `/v1/messages` requests that do not set them. Override this only when needed:

```bash
aerial config set promptCacheRetention in_memory
# or: aerial config set promptCacheRetention 24h
# disable automatic cache hints: aerial config set promptCacheRetention off && aerial config set promptCacheKey off
# pin cache partition: aerial config set promptCacheKey my-project
# per process: export AERIAL_PROMPT_CACHE_RETENTION=in_memory && export AERIAL_PROMPT_CACHE_KEY=my-project
```

Look for these usage fields to confirm cache behavior:

- Responses/Chat: `usage.input_tokens_details.cached_tokens` or `usage.prompt_tokens_details.cached_tokens`.
- Messages: `usage.cache_creation_input_tokens` and `usage.cache_read_input_tokens`.
- Copilot details when present: `copilot_usage.token_details` entries with `cache_read` or `cache_write`.

When `aerial start` is running in a terminal, Aerial also writes cache-only metadata logs to stderr:

```json
{"event":"cache_request","route":"/v1/messages","cacheControlBlocks":1}
{"event":"cache_observe","route":"/v1/messages","usage":{"cacheRead":1920}}
```

These logs deliberately omit prompt text and request bodies. If `cached` stays zero, first check that the repeated prefix is identical and at least 1024 tokens. This matches OpenAI's prompt caching requirements; GitHub's public Copilot REST docs cover management and usage-metrics APIs, but do not document Copilot inference cache fields.

Best practice: put stable system/project/tool context first, put changing user input last, and keep the prefix identical between requests. OpenAI-style prompt caching generally needs at least 1024 tokens before hits appear.
## Troubleshooting

- `503 Missing GitHub token`: run `aerial login`.
- `401 Invalid or missing Aerial API key`: run `aerial setup all`, then restart the client terminal or VS Code.
- Claude Code cannot read key: ensure `aerial` is on `PATH`; it uses `aerial key print` as its helper.
- Upstream compatibility error: run `aerial doctor`, then retry with a model returned by `/v1/models`.
- `Unsupported parameter: max_tokens`: Aerial normalizes Chat Completions `max_tokens` into `max_completion_tokens` before forwarding to newer OpenAI models.
- Cache hit stays zero: ensure the stable prefix is long enough, unchanged, and placed before variable content. For Responses/Chat, try a stable `prompt_cache_key`; for Messages, keep stable content in `system` or put manual `cache_control` on the stable content block.
- Need to revert client config: run `aerial setup status` to see current state, then `aerial setup restore <codex|claude|all> --latest`. The current file is snapshotted as `*.aerial-pre-restore-<ISO>` before being overwritten.
