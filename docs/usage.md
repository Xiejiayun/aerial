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
node src/cli/index.js --help
```

## 1.5 Update

```bash
aerial update --check
aerial update
# equivalent:
aerial upgrade
```

`--check` prints the installed version and the configured npm registry's latest stable version without installing anything. A successful check exits zero whether or not an update is available. `aerial update` installs the newer release, verifies the installed version, and skips installation when already current or ahead of that registry's latest release. Failed registry checks or installs exit non-zero.

Updating requires an npm global installation managed by the active npm. Source checkouts, linked packages, local dependencies, and temporary `npx` copies can check for updates, but must be upgraded through their original installation method. The command uses npm's user configuration and proxy settings; Aerial's Copilot upstream proxy setting does not configure npm. npm's engine check prevents installing a release incompatible with your Node.js version.

Version checks prefer fresh registry metadata. Registry mirrors can still lag behind the official npm site, so the result describes the latest version served by your configured registry.

The command preserves Aerial's login and client configuration. Running processes continue using their loaded code until restarted. After upgrading a background installation, run:

```bash
aerial service install
aerial service restart
```

For foreground processes or a service you manage yourself, restart it using its usual method.

Older Aerial versions without `update` need a one-time upgrade with `npm install -g @jiayunxie/aerial@latest` before the new command is available.

## 2. Configure Local Clients

```bash
aerial login
aerial setup codex
# optional, if you use Claude Code too:
aerial setup claude
```

Aerial creates a local API key, stores it privately, asks you to choose from compatible Copilot models, and configures the selected clients to use it. Run `aerial login` before setup so model discovery can read your Copilot model list. There is intentionally no `aerial setup all` setup shortcut: Codex and Claude Code can need different model IDs, so setup stays client-specific. If Codex or Claude Code was already open, restart it after setup so it rereads the updated client config.

## 3. Login To GitHub

```bash
aerial login
```

Open the printed URL, enter the user code, and authorize the GitHub OAuth device flow. Aerial saves the GitHub access token locally and exchanges it for short-lived Copilot JWTs when proxy requests arrive.

## 3.5 Upstream Proxy Mode

```bash
aerial proxy status
aerial proxy enable
aerial proxy disable
```

Aerial's local server always listens on `127.0.0.1:18181`, but its own GitHub and Copilot upstream traffic can optionally go through a local HTTP(S) or SOCKS5 proxy. This helps in restricted regions where direct Copilot egress may return a smaller model catalog or omit Claude-compatible `/v1/messages` routes.

`aerial proxy enable` auto-discovers candidates from `AERIAL_UPSTREAM_PROXY`, standard proxy environment variables, macOS `scutil --proxy`, PAC files, common local SOCKS5 ports such as `1086` and `1080`, and common local HTTP proxy ports such as `1087` and `7890`. It validates that a candidate can reach GitHub and return GitHub's `/rate_limit` JSON before saving `upstreamProxyMode=auto` and the selected endpoint in Aerial's config. If no candidate works, it exits non-zero and leaves the previous config unchanged. PAC files are read with a 1 MiB limit.

SOCKS5 endpoints are first-class candidates. When Aerial selects `socks5://127.0.0.1:1086` from a Shadowsocks PAC file, the config stores that original endpoint; at runtime Aerial starts a loopback-only HTTP CONNECT bridge internally so GitHub/Copilot `fetch` and WebSocket traffic can use the same proxy dispatcher path as HTTP(S) proxies. Users do not need to discover or configure a separate HTTP bridge port.

For explicit overrides, `AERIAL_UPSTREAM_PROXY` accepts bare `http://`, `https://`, `socks://`, `socks5://`, and `socks5h://` endpoints. Aerial intentionally ignores proxy URLs with path, query, or hash components, because upstream proxy dispatchers expect a host-level proxy endpoint.

`aerial proxy status` prints the active mode, the direct or proxied egress IP/region, and the current Copilot route counts from `aerial probe` (`responses`, `responsesWebSocket`, `messages`, and `chat`). In disabled mode the endpoint is `direct`; in enabled mode the endpoint is the selected local proxy plus its discovery source. Use `--json` for the stable `aerial.proxy-status.v1` shape. If a proxy URL contains userinfo, status and enable diagnostics redact it before printing.

`aerial proxy disable` switches back to direct upstream traffic and clears the saved proxy endpoint. Running Aerial processes read this config for each upstream request, so no service restart is required for proxy enable/disable.

## 4. Start Server

```bash
aerial service install
```

Default URL: `http://127.0.0.1:18181`. `aerial service install` is the daily-use path on macOS and Windows because it installs and starts the local background service. Use `aerial start` only when you want a foreground debug process in the current terminal.

On Windows, Aerial registers a Task Scheduler task for your current user with limited privileges. A normal terminal is sufficient unless your local policy restricts task creation.

## 5. Configure Codex CLI

```bash
aerial setup codex
```

The setup command backs up and merges `~/.codex/config.toml`, asks you to choose a model whose Aerial routes include `responses`, then configures Codex to fetch the local Aerial key through a command-backed provider auth helper:

```toml
[model_providers.aerial]
base_url = "http://127.0.0.1:18181/v1"
wire_api = "responses"

[model_providers.aerial.auth]
command = "<node>"
args = ["<aerial-cli.js>", "key", "print"]
timeout_ms = 5000
refresh_interval_ms = 0
```

The local key is generated and stored by Aerial automatically. Users do not need to run `aerial key generate`, copy a key into `~/.codex/config.toml`, or export `AERIAL_API_KEY`.

For a dry inspection without touching your real config, set `HOME`/`USERPROFILE` to a temporary directory before running this command.

To skip the prompts, pass `--model <responses-model-id>` and/or `--effort <minimal|low|medium|high|xhigh|max|ultra>`. `none` is accepted as an alias for Codex `minimal`. Aerial resolves the request against the selected model's live Copilot capabilities: supported values are preserved, while unsupported values fall back to the nearest usable level (`ultra` currently becomes `max` on GPT-5.6 models, and `minimal` is sent as Copilot `none`). The resolved Codex value is written as root-level `model_reasoning_effort = "<effort>"`. Codex setup does not change Aerial `defaultEffort`, which remains the Claude proxy fallback. Under non-TTY (CI/pipes) the wizard does not prompt and falls back to `medium` when the selected model supports it.

## 6. Configure Claude Code

```bash
aerial setup claude
```

The setup command backs up and merges `~/.claude/settings.json`, asks you to choose a model whose Aerial routes include `messages`, then writes an absolute `apiKeyHelper` command and `ANTHROPIC_BASE_URL=http://127.0.0.1:18181`. The helper lets Claude Code read the local Aerial key automatically without relying on a shell `AERIAL_API_KEY` export or a refreshed `PATH`.

If Claude Code was previously pointed at another Anthropic-compatible gateway, setup removes stale `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL`, and `ANTHROPIC_DEFAULT_*_MODEL` entries from the managed `env` block.

For a dry inspection without touching your real config, set `HOME`/`USERPROFILE` to a temporary directory before running this command.

To skip the prompts, pass `--model <messages-model-id>` and/or `--effort <low|medium|high|xhigh|max|ultracode>`. Setup maps Copilot's model ID to a native Anthropic identity with `modelOverrides`, so Claude recognizes the model's capabilities. It saves effort in `modelSettings[<native-model>].effortLevel` (Claude Code 2.1.251+) and the legacy top-level `effortLevel`. Choices are the intersection of the client's persistent levels and the model's catalog capabilities. Unknown model capabilities are not presented as verified effort support. `max` cannot be persisted: setup reports the requested-to-saved change, up to `xhigh`, with the reason. Use `claude --effort max` for a single session when the upstream supports it. The legacy `ultracode` setup input resolves up to `xhigh`; it does not turn on Claude's separate workflow mode. The saved effort also updates Aerial-wide `defaultEffort` for requests that omit a client effort. Status reads the actual saved client setting and never substitutes this proxy fallback. Precedence for the Anthropic effort applied to a Claude Opus 4.7 request, in order:

1. An explicit `output_config.effort` in the request body takes precedence, then is resolved against the live model catalog when capability metadata is available.
2. A legacy `thinking: { type: "enabled", budget_tokens }` is translated to `thinking: { type: "adaptive" }` with a derived `output_config.effort`.
3. `thinking: { type: "adaptive" }` without an explicit effort is preserved as-is; Aerial does not inject a default.
4. Otherwise Aerial injects Aerial `defaultEffort` from `~/.aerial/config.json` as `output_config.effort`.
5. If no Aerial default is set, Aerial falls back to `medium`.

Non-Opus-4.7 Claude requests are not modified.

## 7. Verify

```bash
aerial status
aerial proxy status
aerial doctor
aerial probe
```

`aerial status` is the top-level daily check. It combines setup state, local auth files, service state, and health into one short report. Use `--json` for a machine-readable `aerial.status.v1` document.

`aerial proxy status` is the network-path check. Use it when Claude models disappear, when `/v1/messages` is `0`, or when you want to confirm whether direct or proxied egress is being used.

`aerial status --json` top-level fields: `schema`, `ok`, `setup`, `service`, `nextSteps`, `hints`. `nextSteps` lists actions you must take to reach `ok: true` (login / setup / service install / recover local key). `hints` lists non-blocking advisories that you should still pay attention to, such as `AERIAL_GITHUB_TOKEN` being set for the current shell only (the background service may not see it after reboot). Example:

```json
{
  "schema": "aerial.status.v1",
  "ok": false,
  "nextSteps": ["run: aerial setup codex or aerial setup claude"],
  "hints": ["AERIAL_GITHUB_TOKEN is set for this process only; run aerial login without that env var to persist a service-readable login."],
  "setup": { "...": "aerial.setup-status.v1 fields here" },
  "service": { "...": "aerial.service-status.v1 fields here" }
}
```

### Local HTTP endpoints

| Request | Local Aerial API key | Behavior |
| --- | --- | --- |
| `GET /` | not required | 200 + friendly status JSON pointing at `/health` and `aerial status`; no secrets in body |
| `GET /health` | not required | 200 + minimal `{ ok, service, host, port }` |
| `GET /v1/models` (with GitHub login) | not required | 200 + Copilot model list with Aerial route annotations |
| `GET /v1/models` (no GitHub login) | not required | 401 + `error.aerial.status = "login_required"` |
| `GET /v1/models` (GitHub login rejected by Copilot) | not required | 401/403 + `error.aerial.status = "upstream_auth_failed"` and `upstream_status` |
| `POST /v1/responses`, `/v1/messages`, `/v1/chat/completions` | required | 401 if key missing/invalid; otherwise proxied to Copilot |
| `POST /v1/messages/count_tokens` | required | Local input estimate, including system prompts, tools, messages, and tool results; malformed JSON returns 400 |

Token counts are estimates (`x-aerial-token-count: estimate`), not an upstream
tokenizer result or a guarantee that the request fits the context window. Aerial
counts the complete JSON input, uses UTF-8 bytes for non-ASCII text, and adds 20%
headroom. Images reserve 4,096 tokens each and binary documents reserve 8,192
before that headroom; base64 bytes are not counted as ordinary prompt text.
Text documents are counted as text. Large or multi-page media can exceed these
allowances; the model's actual usage and context limit remain authoritative.

None of these endpoints emit `WWW-Authenticate` or open CORS (`Access-Control-Allow-Origin: *`). The `login_required` and `upstream_auth_failed` JSON shapes never include tokens, keys, or filesystem paths.

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

Setup, status, restore, and teardown honor `CODEX_HOME` and `CLAUDE_CONFIG_DIR`;
otherwise they use `~/.codex` and `~/.claude`. Set `AERIAL_CONFIG_DIR` or use
`aerial --config-dir <directory> <command>` to select Aerial's own configuration.
Generated key helpers and service wrappers remember its absolute directory, so
they work when a GUI client or a new terminal does not inherit that environment.

```bash
aerial setup status [--json]
aerial setup restore <codex|claude|all> --latest
aerial teardown
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
    "github_token": { "file": "/Users/you/Library/Application Support/aerial/github_token", "exists": true, "source": "file" }
  },
  "clients": {
    "codex": {
      "target": "codex",
      "state": "aerial",
      "file": "/Users/you/.codex/config.toml",
      "backups": ["/Users/you/.codex/config.toml.aerial-backup-2026-05-20T10-00-00-000Z"],
      "model": "gpt-5.5",
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

`auth.github_token.source` is one of `"missing"`, `"file"`, or `"env"`. `exists` is derived: `source !== "missing"` ("the current process can read a GitHub token"). `source = "env"` means the token came from `AERIAL_GITHUB_TOKEN`, which the background service generally cannot see — run `aerial login` without that env var to persist a service-readable login. To detect a persisted file login specifically, read `source === "file"`.

Stability rules for `aerial.setup-status.v1`: new fields may be added at any level in future Aerial releases — consumers must ignore unknown keys. Existing fields will not be removed or repurposed without bumping the `schema` value. Field types remain constant within a schema version. Note: in 0.1.6, `auth.github_token.exists` reflects "process-readable" (file or env), not strictly "token file present". Downstream consumers that need the old file-only semantics should read `auth.github_token.source === "file"`.

`aerial setup restore <codex|claude|all> --latest` restores the most recent `*.aerial-backup-<ISO>` snapshot for the named client. Before overwriting, it takes a `*.aerial-pre-restore-<ISO>` snapshot of the current file so the restore itself is reversible. With `all`, both clients are restored best-effort and the command exits non-zero if any individual restore failed. If there is no backup to restore, the command prints a note and exits 0.

`aerial teardown` undoes the Aerial takeover, then uninstalls the service only when both clients no longer depend on it. Setup records the original file (or its absence) in a private `*.aerial-state.json` journal. Repeating setup retains that baseline. Teardown restores managed values that still match Aerial's last write and preserves later user changes; a remaining Aerial dependency or invalid recovery state stops the uninstall and exits non-zero. Fix the reported configuration conflict and rerun `aerial teardown`.

For installations made before takeover journals existed, teardown uses the oldest valid pre-Aerial backup. If none exists, it removes known Aerial settings, preserves unrelated settings, and explicitly reports that client defaults now apply; a lost original provider cannot be reconstructed. A `*.aerial-pre-teardown-<ISO>` snapshot makes the detach reversible. Completed journals are retained with a `.detached-<timestamp>` suffix. Use `setup restore --latest` only to roll back the last setup edit; after repeated setup that snapshot can still point to Aerial.

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

- macOS: a user-level launchd `LaunchAgent` at `~/Library/LaunchAgents/com.jiayunxie.aerial.plist` invokes a generated POSIX shell wrapper at `<config-dir>/bin/aerial-service.sh`. The plist is regenerated on every `aerial service install` with a `<!-- Generated by aerial; do not edit -->` header, `KeepAlive = true` so launchd continuously supervises the loaded agent regardless of its previous exit status, `ThrottleInterval = 10` to cap restart cadence, and no `StandardOutPath`/`StandardErrorPath` keys (the wrapper owns stdio redirection so launchd does not hold a write fd that would race with rotation). The launchctl command path is `gui/<uid>` (per-user agent, no privilege escalation). Start/stop go through `launchctl bootstrap` and `launchctl bootout` against that domain — never `launchctl kill`; bootout unloads the job, so an explicit stop is not respawned by `KeepAlive`.
- Windows: a Task Scheduler task named `AerialLocalProxy`, registered for the current user at logon with limited privileges, uses Windows Script Host (`wscript.exe`) to start a hidden PowerShell wrapper at `<config-dir>\bin\aerial-service.ps1` (default `%APPDATA%\aerial\bin\aerial-service.ps1`). The launcher hides PowerShell when creating it, preventing Windows Terminal from opening a blank window, and waits for the proxy to exit so the task continues to manage the process tree. The wrapper restarts Node after an unsuccessful exit, waiting one minute between attempts and allowing up to 999 retries. A normal exit is not retried. The scheduled task remains running during the wait, so `aerial service stop` also stops pending process recovery. Task Scheduler is additionally configured to retry task startup failures every minute, up to 999 attempts. The task has no execution time limit and can start and continue running on battery power. The wrapper and task settings are regenerated on every `aerial service install`. Run `aerial service install` from your normal PowerShell or Command Prompt. Registration uses your interactive user identity and limited privileges; a local policy may still restrict task creation. If registration is denied, the command reports the error before starting the task. After upgrading an older installation, run `aerial service install` and `aerial service restart` to apply the launcher, recovery settings, and updated code. You can then close the installation terminal. Structured PowerShell task registration avoids the `schtasks /TR` length limit and quotes the launcher and wrapper paths separately, including spaces, apostrophes, and non-ASCII characters.
- Linux: not implemented in this release. `aerial service install|start|stop|restart|uninstall` throws an unsupported-platform error and exits 1; `aerial service status --json` probes the proxy and reports `"supported": false` for background management, with exit 0 when Aerial is healthy and exit 1 otherwise. Run `aerial start` directly or wrap it in your own init system.

Both wrappers do the same three things before launching the proxy (on Windows, these repeat before each recovery attempt): (1) startup-rotate the captured stdio log (`aerial-stdio.log` → `.1` → `.2` → `.3`) if it has grown beyond the configured cap; (2) export `AERIAL_LOG_FILE=<config-dir>/logs/aerial.log`, plus `AERIAL_LOG_MAX_BYTES` and `AERIAL_LOG_BACKUPS` (default `5242880` / `3`, or whatever value was present in the installer's environment — see below), and always export the resolved absolute `AERIAL_CONFIG_DIR` so the service sees the same config root as the installer; (3) launch `node src/cli/index.js start --host <host> --port <port>` with stdout and stderr appended to `aerial-stdio.log`. The macOS wrapper uses `exec`; the Windows wrapper waits for the child and applies the recovery policy described above. By default, the service wrapper uses the same Node.js binary that ran `aerial service install`. Set `AERIAL_SERVICE_NODE` before `aerial service install` to override this explicitly, for example when installing from one Node binary but running the service with another. The structured event log is opt-in via `AERIAL_LOG_FILE`: when this env var is set (always set by the wrapper, never by foreground `aerial start`), structured events go to that file only; when unset, they go to stderr only. There is no double-write.

Wrapper env values are baked in at install time. If you set `AERIAL_LOG_MAX_BYTES` and/or `AERIAL_LOG_BACKUPS` in the shell before running `aerial service install`, the generated wrapper hard-codes those values and the next start of the service inherits them. Changing the env in another shell after install has no effect on the already-installed wrapper. To apply new values to an already-managed service, rerun `aerial service install` (which always regenerates the definition, including the wrapper) and then `aerial service restart` to swap the running process onto the regenerated wrapper.

On Windows, stop and restart obtain the running task's process IDs from Task Scheduler and terminate those complete process trees before ending the task. This prevents PowerShell or Node from remaining alive after the launcher exits. If stopping the tree fails, uninstall preserves the task and wrapper so the operation can be retried.

`aerial service install` follows this state machine, in order, against the configured host/port:

1. Probe `GET /health` with a 1.5s timeout.
2. If the port answers with a non-Aerial response (any 200 with a body that does not declare `service=aerial`, or a 200 with a body that is not parseable JSON) → exit 1 with `reason=port_conflict`. No definition is written.
3. If the port answers as Aerial AND the local service manager reports the unit/task loaded → the definition (plist+wrapper on macOS, wrapper+structured task registration and recovery settings on Windows) is regenerated, but the already-running service is NOT restarted (the install command never starts a second instance, and never recycles the running one). Exit 0 with `ok=true`, `definitionUpdated=true`, and `note="already running (service-managed); definition refreshed; run \`aerial service restart\` to apply wrapper/env changes"`. On Windows, if registration or recovery configuration fails while refreshing the definition, the command exits 1 with `reason=managed_definition_refresh_failed`; it does not restart the running process.
4. If the port answers as Aerial AND the local service manager does NOT report the unit/task loaded → the definition is regenerated, but the service is NOT started. Exit 1 with `reason=foreground_running`, `definitionUpdated=true`, and an actionable next step: stop the foreground process, then run `aerial service start`. This guarantees `install` never causes two Aerial instances to fight for the port.
5. Otherwise (port absent) → write the definition, then start the service (`launchctl bootstrap` on macOS, `schtasks /Run` on Windows). Exit 0.

On Windows, installation applies recovery settings after registering the task and before starting it. If that configuration step fails, installation exits 1 with `reason=recovery_configuration_failed`, includes PowerShell diagnostics, and does not start the task. Refreshing a managed or foreground process instead returns `managed_definition_refresh_failed` or `foreground_definition_refresh_failed` with `definitionUpdated=false`. Resolve the reported error and rerun `aerial service install` before starting the service.

`aerial service start` enforces a similar shape: it refuses with `reason=not_installed` and exit 1 if the unit/task does not exist; it refuses with `reason=port_conflict` and exit 1 if a non-Aerial process owns the port; it refuses with `reason=foreground_running` and exit 1 if Aerial is already running in the foreground (not via the service manager); it returns idempotent success with `note=already running (service-managed)` if the service is already up; otherwise it starts the service. `aerial service stop` is idempotent (exit 0 + `note` when nothing is installed or nothing is running). `aerial service uninstall` is idempotent on the "no service installed" branch, but does NOT swallow real teardown failures: on macOS, if the service is loaded and `launchctl bootout` returns non-zero, the plist and wrapper are preserved and the command exits 1 with `reason=bootout_failed`; on Windows, if `schtasks /Delete` returns non-zero, the wrapper is preserved and the command exits 1 with `reason=delete_failed`. In both cases the message includes a retry pointer. `aerial service restart` blocks the start step when the stop step fails: if `stop` returns `ok=false`, the response includes `reason=stop_failed` and `start` is not attempted. `aerial teardown` follows the same contract: it restores client configs first, then calls `serviceUninstall`. Only an `unsupported platform` exception is treated as a silent skip (Linux); any supported-platform uninstall failure (`ok=false` or non-`unsupported-platform` throw) propagates as exit 1 with a retry pointer at `aerial service uninstall`.

If GitHub login is not yet configured, install and start still succeed (when reachable) and emit a structured warning pointing at `aerial login`; inference proxy requests return 503 until you log in, while `GET /v1/models` returns 401 with `error.aerial.status = "login_required"`. After rotating the local API key or moving the config directory, restart the service with `aerial service restart` so the new credentials are picked up.

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

`service.installed` reports whether the unit or scheduled task exists;
`service.loaded` reports whether launchd has loaded it or Windows Task Scheduler
reports numeric Queued/Running state. `/health` is probed on every platform with
a 1.5-second timeout. `supported` describes background service management only:
Linux can report `supported=false`, `health.aerial=true`, and `ok=true` when
`aerial start` is running in the foreground.

The command exits 0 when `ok=true`, and 1 when the proxy is unavailable or the
service manager query fails. `nextSteps` gives a repair for each failure;
`hints` contains optional actions. When the manager cannot be queried,
`service.reason="status_query_failed"` and `service.error` retain the cause;
`installed` and `loaded` are omitted because their values are unknown.
The health result is still reported, with `health.supervisor="unknown"` if
Aerial responds. Other supervisor values are `service-managed` and `foreground`.
A non-Aerial response sets `health.portConflict=true` and a `conflictReason`.

`summary` describes the observed state, including foreground operation and a
running manager with failed health. `auth.*.state` is `present`, `missing`, or
`invalid` (an unreadable or empty file); authentication inspection is local and
does not contact GitHub. `logs.source="installed-wrapper"` means the log limits
were read from the installed wrapper and apply at its next start;
`next-install-default` means they describe the next service installation.

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
- `401 Invalid or missing Aerial API key`: run `aerial setup codex` or `aerial setup claude` for the client you use, then restart the client terminal or VS Code.
- Claude Code cannot read key: rerun `aerial setup claude` so the settings file gets a fresh absolute API-key helper command.
- Upstream compatibility error: run `aerial doctor`, then retry with a model returned by `/v1/models`.
- `Unsupported parameter: max_tokens`: Aerial normalizes Chat Completions `max_tokens` into `max_completion_tokens` before forwarding to newer OpenAI models.
- Cache hit stays zero: ensure the stable prefix is long enough, unchanged, and placed before variable content. For Responses/Chat, try a stable `prompt_cache_key`; for Messages, keep stable content in `system` or put manual `cache_control` on the stable content block.
- Need to revert client config: run `aerial setup status` to see current state, then `aerial setup restore <codex|claude|all> --latest`. The current file is snapshotted as `*.aerial-pre-restore-<ISO>` before being overwritten.
