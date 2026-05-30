# Aerial: Local Copilot Proxy for Coding CLIs

## Summary

**Aerial** is a proposed lightweight local proxy that lets one user connect their own GitHub Copilot subscription to local coding CLIs.

The MVP is intentionally smaller than Raven. It focuses on a local-only reverse proxy, GitHub login, Copilot token refresh, Codex CLI over OpenAI Responses, Claude Code over Anthropic Messages, and one-command setup/rollback. It does not include a dashboard, analytics database, custom upstream providers, account sharing, public deployment, quota bypass behavior, or image APIs.

Default bind address: `127.0.0.1:18181`.

## Official Documentation Audit

This section records what is confirmed by official documentation and what is only observed from Raven or GitHub Copilot client behavior.

| Area | Official status | Design implication |
|------|-----------------|--------------------|
| GitHub OAuth Device Flow | Official. GitHub documents `POST https://github.com/login/device/code`, polling `POST https://github.com/login/oauth/access_token`, `interval`, and `slow_down`. | `aerial login` should use Device Flow and respect polling intervals exactly. |
| GitHub Copilot REST API | Official REST docs cover Copilot management, content exclusion, custom agents, metrics, usage metrics, and user management. They do not document chat/completions/messages/responses inference routes. | Treat `api.githubcopilot.com` inference routes as an observed compatibility target, not a public stable API. Keep this code isolated and easy to change. |
| GitHub Models inference | Official. GitHub Models exposes `https://models.github.ai/inference/chat/completions` and org-attributed variants with `models: read`. | This is separate from Copilot. It can be a future official-only alternative, but it is not the same upstream as Raven's Copilot proxy path. |
| Codex CLI install | Official OpenAI Codex repo documents `npm install -g @openai/codex` and `brew install --cask codex`. | npm is suitable for early distribution. Homebrew can follow when service management is stable. |
| Codex CLI provider config | The OpenAI Codex repo source confirms `~/.codex/config.toml`, `[model_providers.<id>]`, `base_url`, command-backed `[model_providers.<id>.auth]`, `wire_api = "responses"`, and `[profiles.<id>]`. Source also shows `wire_api = "chat"` is no longer supported. | Aerial should configure Codex through a custom Responses provider, not through Chat Completions. |
| Claude Code gateway config | Official Claude Code docs support `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL`, settings `env`, and `apiKeyHelper`. The LLM gateway docs require Anthropic Messages routes `/v1/messages` and `/v1/messages/count_tokens`, and forwarding `anthropic-beta` and `anthropic-version`. | Aerial should expose an Anthropic-compatible gateway for Claude Code and support both bearer and `x-api-key` local auth. |
| Claude Code model config | Official docs support model aliases, `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_OPUS_MODEL`, and gateway model discovery through `/v1/models` when enabled. | Do not hardcode Copilot model IDs. Query live models and let setup choose from available IDs. |

Official references:

- GitHub OAuth Device Flow: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow
- GitHub Copilot REST API: https://docs.github.com/en/rest/copilot
- GitHub Models inference: https://docs.github.com/en/rest/models/inference
- OpenAI Codex CLI repo: https://github.com/openai/codex
- OpenAI Codex config entrypoint: https://github.com/openai/codex/blob/main/docs/config.md
- Claude Code settings: https://code.claude.com/docs/en/settings.md
- Claude Code environment variables: https://code.claude.com/docs/en/env-vars.md
- Claude Code LLM gateway: https://code.claude.com/docs/en/llm-gateway.md
- Claude Code model config: https://code.claude.com/docs/en/model-config.md

## Naming

Recommended name: **Aerial**.

Why it fits:

- It means an antenna or something over the air.
- It is short enough for a CLI binary: `aerial`.
- It hints at signal relay without using a branded character name.
- It works well in commands: `aerial login`, `aerial start`, `aerial setup codex`.

Other candidates:

| Name | Notes |
|------|-------|
| Beamline | Good for a focused request pipeline; slightly more technical. |
| Signalbox | Friendly and descriptive; a bit longer. |
| LocalPilot | Very clear; less distinctive. |
| RelayKit | Accurate; sounds more like a library than an app. |
| Antenna | Direct and memorable; may be harder to search. |

Teletubbies character names, for reference: **Tinky Winky**, **Dipsy**, **Laa-Laa**, and **Po**. These are strongly associated with the Teletubbies brand, so they should not be used as the project name or product identity.

## Product Boundaries

Aerial is for **personal local use**:

- Bind to `127.0.0.1` by default.
- Use port `18181` by default.
- Require a local API key for all model routes.
- Store credentials only on the user's machine.
- Use the user's own GitHub Copilot subscription.
- Avoid public deployment guidance, account pooling, resale, shared hosted API modes, quota bypass, or anti-abuse evasion.
- Do not implement image generation, image edit, or vision-specialized API routes in the MVP.

This boundary should stay explicit in the README and setup flow.

## Goals

1. Provide a local Copilot-compatible API endpoint for coding CLIs.
2. Support Codex CLI through OpenAI Responses API.
3. Support Claude Code through Anthropic Messages API.
4. Provide one-command setup, diagnostics, service install, and rollback for supported CLIs.
5. Keep Gemini CLI as an investigation item until its official custom endpoint surface is verified.
6. Keep the implementation small, inspectable, and easy to test.

## Non-Goals

- No dashboard.
- No SQLite analytics or request history UI.
- No custom third-party provider routing in the MVP.
- No SOCKS5 relay in the first release.
- No web search tool replacement.
- No image generation or image editing API.
- No public server mode.
- No multi-account pool.
- No model marketplace or quota management layer.

## Architecture

```text
Claude Code              Codex CLI                Gemini CLI later
   |                         |                         |
   | Anthropic Messages      | OpenAI Responses        | wrapper or shim, if verified
   v                         v                         v
                    +------------------------------------------+
                    | Aerial local server 127.0.0.1:18181       |
                    |                                          |
                    | auth   GitHub Device Flow + JWT refresh  |
                    | proxy  /v1/messages, /v1/responses      |
                    | setup  config writers + service + doctor |
                    | logs   local structured logs             |
                    +---------------------+--------------------+
                                          |
                                          v
                       Observed Copilot client upstream
                          https://api.githubcopilot.com
```

## Main Components

### `auth`

Responsibilities:

- Run GitHub OAuth Device Flow on first login.
- Respect GitHub's `interval` and `slow_down` polling rules.
- Persist the GitHub access token in a local secure location.
- Exchange the GitHub token for a short-lived Copilot JWT using the observed Copilot client endpoint.
- Refresh the Copilot JWT before expiry.
- On upstream `401`, perform a singleflight refresh and retry once.

Suggested local paths:

| Platform | Token path |
|----------|------------|
| macOS | `~/Library/Application Support/aerial/github_token` |
| Linux | `~/.config/aerial/github_token` |

Token files must be created with `0600` permissions where the platform supports it.

### `proxy`

Responsibilities:

- Listen on `127.0.0.1:18181` by default.
- Validate `Authorization: Bearer <key>` and `x-api-key: <key>`.
- Forward requests to Copilot with Copilot Chat compatible headers.
- Support JSON and SSE streaming.
- Normalize only the fields needed by target CLIs.
- Do not forward inbound client headers wholesale.

Suggested route surface:

| Local route | Client | Upstream target | Behavior |
|-------------|--------|-----------------|----------|
| `GET /health` | setup/doctor | local | No auth needed. |
| `GET /v1/models` | Claude Code, setup, Codex selection | observed `/models` | Minimal normalization and cache. |
| `POST /v1/responses` | Codex CLI | observed `/responses` | Passthrough JSON/SSE. |
| `POST /v1/messages` | Claude Code | observed `/v1/messages` when supported | Prefer native Anthropic passthrough. |
| `POST /v1/messages/count_tokens` | Claude Code | local estimate first | Required for Claude Code gateway compatibility. |
| `POST /v1/chat/completions` | OpenAI-compatible fallback | observed `/chat/completions` | Optional passthrough after MVP. |

### `setup`

Responsibilities:

- Generate a local API key.
- Start or install the local service.
- Configure each supported CLI.
- Backup touched config files before editing.
- Merge config files through structured parsers, not string replacement.
- Provide rollback with `aerial teardown`.
- Provide diagnostics with `aerial doctor`.

Suggested commands:

```bash
aerial login
aerial start
aerial service install
aerial service uninstall
aerial setup claude
aerial setup codex
aerial setup gemini
aerial doctor
aerial teardown
```

## Distribution and Startup

Recommended distribution path:

| Stage | Channel | Why |
|-------|---------|-----|
| Early | npm package | Fastest path for Node-based CLI distribution and updates. |
| Later | Homebrew formula or cask | Better macOS install experience and easier `brew services` integration. |

Startup behavior:

- `aerial start` runs the local server in the foreground for debugging.
- `aerial service install` installs a user-level startup service.
- On macOS, use `launchd` with a user LaunchAgent.
- On Linux, use a user-level `systemd` service.
- The service must bind only to `127.0.0.1:18181` unless the user explicitly changes the host.

Homebrew can later map service commands onto `brew services start aerial`, but the internal service installer should still exist so npm users are not second-class.

## Client Setup Behavior

### Claude Code

Official configuration surfaces confirmed by Claude Code docs:

- `ANTHROPIC_BASE_URL` routes model requests through a proxy or gateway.
- `ANTHROPIC_API_KEY` is sent as `X-Api-Key`.
- `ANTHROPIC_AUTH_TOKEN` is sent as `Authorization: Bearer <value>`.
- `apiKeyHelper` can generate an auth value that Claude Code sends as both `X-Api-Key` and `Authorization: Bearer`.
- `ANTHROPIC_MODEL` and `ANTHROPIC_DEFAULT_*_MODEL` control model selection.
- A gateway should support `/v1/messages` and `/v1/messages/count_tokens`.
- A gateway should forward `anthropic-beta` and `anthropic-version` headers.

Recommended simple shell setup:

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:18181"
export ANTHROPIC_AUTH_TOKEN="$AERIAL_API_KEY"
```

Recommended persistent setup for `aerial setup claude`:

```json
{
  "apiKeyHelper": "aerial key print",
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:18181",
    "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY": "1"
  }
}
```

`aerial key print` should print only the local Aerial API key. This avoids writing the raw key into Claude Code settings while staying inside Claude Code's official `apiKeyHelper` mechanism.

Model setup should not hardcode model IDs. `aerial setup claude` should query `GET /v1/models`, show available Claude-capable Copilot model IDs, and optionally write one of these values:

```bash
export ANTHROPIC_MODEL="<available-claude-model-id>"
export ANTHROPIC_DEFAULT_SONNET_MODEL="<available-claude-sonnet-model-id>"
export ANTHROPIC_DEFAULT_OPUS_MODEL="<available-claude-opus-model-id>"
```

Claude Code may prompt the user to approve a custom API key on first interactive run when `ANTHROPIC_API_KEY` is used. `aerial doctor claude` should detect common rejection-state problems and print the exact config file to inspect.

### Codex CLI

Codex should use the Responses API provider path. Do not configure it through Chat Completions.

Confirmed by the OpenAI Codex repo source:

- Custom providers live under `[model_providers.<id>]` in `~/.codex/config.toml`.
- `base_url` points at the provider base URL.
- `[model_providers.<id>.auth]` can run a command that prints the bearer token. Aerial uses this path so users do not need to manually export `AERIAL_API_KEY`.
- `wire_api = "responses"` is the supported wire API.
- `wire_api = "chat"` is explicitly rejected in current source.
- Profiles live under `[profiles.<id>]` and can select `model_provider` and `model`.

Suggested `~/.codex/config.toml` patch:

```toml
model_provider = "aerial"
model = "<available-copilot-model-id>"

[model_providers.aerial]
name = "Aerial"
base_url = "http://127.0.0.1:18181/v1"
wire_api = "responses"

[model_providers.aerial.auth]
command = "<node>"
args = ["<aerial-cli.js>", "key", "print"]
timeout_ms = 5000
refresh_interval_ms = 0

[profiles.aerial]
model_provider = "aerial"
model = "<available-copilot-model-id>"
```

`aerial setup codex` must preserve existing config, merge rather than overwrite, and create a timestamped backup first.

### Gemini CLI

Gemini CLI support needs a separate official-docs discovery step before implementation because its custom endpoint and auth configuration may differ by version.

Preferred path:

1. If Gemini CLI officially supports custom base URL and API key environment variables, write those settings and expose a Gemini-compatible local shim.
2. If it does not support a base URL override, provide an `aerial gemini` wrapper command that launches Gemini CLI with the required environment or local adapter.
3. If neither is reliable, mark Gemini as experimental and keep `aerial doctor gemini` explicit about the limitation.

Gemini should not block the Claude Code and Codex MVP.

## Observed Copilot Compatibility Target

GitHub does not document Copilot inference routes as public REST APIs. Aerial should therefore isolate this code behind one client module and treat it as compatibility-sensitive.

Observed operations from Raven and current Copilot client behavior:

| Operation | URL |
|-----------|-----|
| Exchange Copilot JWT | `https://api.github.com/copilot_internal/v2/token` |
| Models | `https://api.githubcopilot.com/models` |
| Anthropic Messages | `https://api.githubcopilot.com/v1/messages` |
| Chat Completions | `https://api.githubcopilot.com/chat/completions` |
| Responses | `https://api.githubcopilot.com/responses` |

Headers should be built fresh for each upstream request. Do not forward inbound client headers wholesale.

Observed minimum header set:

```text
Authorization: Bearer <copilot-jwt>
content-type: application/json
accept: application/json
copilot-integration-id: vscode-chat
editor-version: vscode/<detected-or-pinned-version>
editor-plugin-version: copilot-chat/<detected-or-pinned-version>
user-agent: GitHubCopilotChat/<detected-or-pinned-version>
x-github-api-version: 2025-10-01
x-request-id: <uuid>
```

For Claude Code `/v1/messages`, Aerial should preserve relevant Anthropic headers when the upstream path supports them:

```text
anthropic-version: <from-client-or-default>
anthropic-beta: <from-client-if-present>
```

## Protocol Strategy

### Codex CLI Path

Default behavior:

1. Accept OpenAI Responses payload at `POST /v1/responses`.
2. Forward to the observed Copilot `/responses` route.
3. Return JSON or SSE as-is.

No request translation should happen in the MVP.

### Claude Code Path

Default behavior:

1. Accept Anthropic Messages payload at `POST /v1/messages`.
2. Normalize Copilot Claude model names only for Copilot routing.
3. Drop fields Copilot rejects when necessary.
4. Prefer native observed Copilot `/v1/messages`.
5. Stream Anthropic SSE events back unchanged when upstream is native.
6. Implement `POST /v1/messages/count_tokens` locally if no reliable upstream count route exists.

Fallback behavior:

- If a model does not support native `/v1/messages`, translate Anthropic Messages to OpenAI Chat Completions.
- Translate OpenAI SSE chunks back to Anthropic SSE events.

The first implementation should support the native path first and add translated fallback only when a real CLI scenario requires it.

### OpenAI Chat Fallback

Default behavior:

1. Accept OpenAI Chat Completions payload.
2. Forward to observed Copilot `/chat/completions`.
3. Return JSON or SSE as-is.

This is useful for generic clients but should not be required for Codex CLI.

## Data Model

Use file-backed config first. Avoid SQLite until there is a real product need.

Suggested config file: `~/.config/aerial/config.json` or platform equivalent.

```json
{
  "port": 18181,
  "host": "127.0.0.1",
  "apiKeyHash": "...",
  "defaultModel": "<available-copilot-model-id>",
  "logLevel": "info",
  "versions": {
    "vscode": "1.105.0",
    "copilotChat": "0.45.1"
  }
}
```

Store the raw local API key only in the user's shell/profile if the user chooses that mode. Internally, store a hash.

## Error Handling

- Invalid local API key: return `401` with protocol-shaped error.
- Missing Copilot token: return `503` with `aerial login` remediation text in logs.
- Upstream `401`: refresh Copilot JWT once and retry once.
- Upstream `429`: pass through status and message; do not retry aggressively.
- Streaming upstream error: emit a protocol-shaped terminal error event where possible.
- Config write failure: leave original config untouched and print backup path.
- Observed Copilot route failure: surface a clear compatibility error and suggest `aerial doctor copilot`.

## Logging

MVP logging can be simple structured JSON lines.

Log events:

- `server_start`
- `login_start`
- `login_success`
- `token_refresh_success`
- `token_refresh_error`
- `request_start`
- `request_end`
- `setup_write`
- `doctor_check`

Never log raw GitHub tokens, Copilot JWTs, API keys, request bodies, full prompts, or image payloads by default.

## Suggested Implementation Stack

Recommended stack:

- Runtime: Node.js 22+.
- HTTP: Hono or Fastify.
- Config parsing: typed JSON plus schema validation.
- TOML editing for Codex: structured TOML parser, not string replacement.
- JSON editing for Claude Code: parse, merge, write with backup.
- Tests: Vitest.

Hono plus Node.js is the safest default for portability. Bun is attractive if the project wants to stay close to Raven's implementation style, but npm and Homebrew distribution are simpler with Node as the baseline.

## Development Phases

### Phase 1 - Core Local Proxy and Codex

- Scaffold `aerial` CLI and local server.
- Implement `login`, token persistence, Copilot JWT exchange, and refresh loop.
- Implement local API key auth.
- Implement `/health`, `/v1/models`, `/v1/responses`.
- Implement `aerial setup codex` with TOML merge and backup.
- Implement `aerial doctor` basic checks.

Exit criteria:

- Codex CLI can complete one non-streaming and one streaming request through `/v1/responses`.

### Phase 2 - Claude Code

- Implement `/v1/messages` native passthrough.
- Implement `/v1/messages/count_tokens`.
- Forward `anthropic-version` and `anthropic-beta` correctly.
- Add Claude model normalization based on live `/v1/models` data.
- Add minimal payload sanitization for Claude Code compatibility.
- Implement `aerial setup claude` using `apiKeyHelper` or environment export mode.

Exit criteria:

- Claude Code can run a normal prompt and a tool-use prompt locally.

### Phase 3 - Service and Rollback

- Implement `aerial service install` and `aerial service uninstall`.
- Support macOS user LaunchAgent.
- Support Linux user `systemd` unit.
- Keep setup commands client-specific so Codex and Claude Code can use different model IDs.
- Implement `teardown` rollback.
- Add shell profile export mode as an alternative to config edits.

Exit criteria:

- A fresh machine can run `aerial login && aerial setup codex && aerial service install` and use Codex after restart; Claude Code users can add `aerial setup claude`.

### Phase 4 - OpenAI Chat Fallback

- Implement `/v1/chat/completions` passthrough.
- Add streaming passthrough tests.
- Add known token field compatibility fixes only where needed.

Exit criteria:

- OpenAI-compatible clients can call Copilot chat models through Aerial.

### Phase 5 - Gemini Investigation and Shim

- Verify Gemini CLI custom endpoint support against official docs and installed CLI behavior.
- Choose direct config or wrapper approach.
- Implement minimal Gemini route translation only if viable.
- Mark feature stable only after real CLI tests pass.

Exit criteria:

- `aerial setup gemini` either configures a working Gemini CLI path or reports a clear unsupported status.

## Testing Plan

Unit tests:

- GitHub Device Flow polling rules.
- Token refresh scheduling.
- Local API key validation.
- Header construction.
- Model normalization from live model metadata fixtures.
- Codex TOML merge.
- Claude settings merge or shell export generation.
- `apiKeyHelper` command output behavior.

Integration tests:

- Local server auth rejects missing and invalid keys.
- `/v1/responses` JSON and SSE passthrough with mocked upstream.
- `/v1/messages` native JSON and SSE passthrough with mocked upstream.
- `/v1/messages/count_tokens` returns Claude Code-compatible shape.
- Upstream `401` triggers single refresh and one retry.
- Service files render correctly for launchd and systemd.

Manual tests:

- Real GitHub Device Flow login.
- Real Copilot token exchange.
- Real Codex CLI prompt.
- Real Claude Code prompt.
- Gemini CLI discovery and compatibility check.

Manual Copilot tests should be opt-in, low volume, and never run in CI.

## Open Questions

1. Should the runtime stay Node.js for npm/Homebrew simplicity, or move to Go/Rust later for a single static binary?
2. Should setup edit CLI config files directly by default, or generate shell snippets first?
3. Should Claude Code setup prefer `apiKeyHelper` by default, or plain environment variables for maximum transparency?
4. Which Copilot model should be the first-run default after querying `/v1/models`?
5. Does the installed Gemini CLI version support custom base URLs reliably?

## Recommended MVP Decision

Build Aerial as a local-only CLI/server with this first target:

```bash
aerial login
aerial setup codex
aerial service install
codex -p aerial "say hello"
```

Then add Claude Code support through the official Anthropic gateway configuration surface. Gemini should follow after endpoint configuration is verified. This ordering keeps the first release small while proving the Copilot token and Responses streaming path early.
