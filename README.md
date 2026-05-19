# Aerial

Aerial is a lightweight local-only proxy that lets one user connect their own GitHub Copilot subscription to local coding CLIs.

The MVP runs on `127.0.0.1:18181`, requires a local Aerial API key for model routes, stores credentials on the user's machine, and avoids public deployment, account sharing, quota bypass, dashboards, analytics, and image APIs.

## MVP Support

Implemented routes:

- `GET /health` without auth
- `GET /v1/models` for model discovery, with an `aerial` support annotation per model
- `POST /v1/responses` for Codex CLI
- `POST /v1/messages` for Claude Code's Anthropic gateway path
- `POST /v1/messages/count_tokens` with a local estimate
- `POST /v1/chat/completions` as a simple passthrough fallback

Implemented CLI commands:

```bash
aerial login
aerial key generate
aerial key print
aerial start
aerial setup codex
aerial setup claude --model <available-copilot-model-id>
aerial setup all
aerial doctor
aerial probe
```

Service installation, rollback automation, Gemini CLI support, dashboards, and analytics are intentionally out of this MVP. For Codex, local clients keep using HTTP POST /v1/responses. Aerial can optionally use Copilot's upstream `ws:/responses` transport for streaming Responses and translate events back to SSE — this transport is opt-in (`AERIAL_RESPONSES_WEBSOCKET=on`) and HTTP is the default.

## Requirements

- Node.js 22+
- A GitHub account with an active Copilot subscription
- Codex CLI and/or Claude Code installed locally

## Install From This Repository

```bash
npm install -g .
```

For local development without global install:

```bash
node src/cli.js --help
```

## First Run

Configure your local clients. This also creates Aerial's local API key and wires it into supported clients:

```bash
aerial setup all --model <available-copilot-model-id>
```

On Windows, newly persisted user environment variables are visible to new terminals and newly launched apps. Restart your terminal or VS Code after the first setup if Codex was already open.

Log in to GitHub with device flow:

```bash
aerial login
```

Start the local server:

```bash
aerial start
```

Check health:

```bash
curl http://127.0.0.1:18181/health
```

## Codex CLI Setup

Aerial configures Codex through the Responses wire API provider path:

```bash
aerial setup codex --model <available-copilot-model-id>
```

This updates `~/.codex/config.toml` and creates a timestamped backup first. If you only want to inspect the exact change, set `HOME`/`USERPROFILE` to a temporary directory before running setup. The inserted provider uses:

```toml
[model_providers.aerial]
base_url = "http://127.0.0.1:18181/v1"
wire_api = "responses"
env_key = "AERIAL_API_KEY"
```

Aerial creates the key automatically and persists `AERIAL_API_KEY` for new user sessions when the platform supports it.

## Claude Code Setup

Aerial configures Claude Code through its Anthropic-compatible gateway settings:

```bash
aerial setup claude
```

This updates `~/.claude/settings.json` and creates a timestamped backup first. If you only want to inspect the exact change, set `HOME`/`USERPROFILE` to a temporary directory before running setup. It sets:

```json
{
  "model": "<available-copilot-model-id>",
  "apiKeyHelper": "aerial key print",
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:18181",
    "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY": "1"
  }
}
```

The `model` field is written when you pass `--model` or set Aerial's `defaultModel`; otherwise Aerial leaves any existing Claude Code model choice alone while still switching the gateway to the local Aerial endpoint.

`aerial key print` prints the locally stored Aerial API key for Claude Code's helper flow. Users normally do not need to call it directly.

When switching from another Anthropic-compatible gateway, setup removes stale `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL`, and `ANTHROPIC_DEFAULT_*_MODEL` entries from Claude Code's managed `env` block so `apiKeyHelper` and the Aerial gateway are the active route.

## Diagnostics

```bash
aerial doctor
aerial probe
```

The doctor checks config, local API key presence, GitHub login state, Node version, and local bind address.

## Security Boundary

Aerial is for personal local use only.

- It binds to `127.0.0.1` by default.
- Model routes require `Authorization: Bearer <AERIAL_API_KEY>` or `x-api-key: <AERIAL_API_KEY>`.
- GitHub tokens are stored under the user config directory with private file permissions where supported.
- Aerial does not log raw GitHub tokens, Copilot JWTs, API keys, or request bodies by default.
- Do not expose this service publicly or use it for account sharing.

## Current Limitations

- Copilot inference routes are an observed compatibility target, not a public stable GitHub REST API.
- `/v1/messages/count_tokens` is a local estimate, not upstream tokenization.
- Service install/uninstall and disable/rollback are not implemented yet.
- Model choice is not automated; query `/v1/models` and select an available model explicitly.
- Chat Completions requests normalize `max_tokens` to `max_completion_tokens` for newer OpenAI models that reject the older field.
- Prompt caching is upstream-managed: Aerial does not store prompt bodies locally, and it preserves or injects cache protocol fields before forwarding.



## Capability Probe

Use `aerial probe` to inspect the live Copilot model matrix through the same local credentials Aerial uses for proxying:

```bash
aerial probe
```

This prints model IDs, Aerial routes, and unsupported notes such as `embeddings_not_implemented` or `no_supported_endpoint_advertised`. Models with upstream `ws:/responses` support are shown with the `responses_websocket` route.

Run low-cost live route checks when you want to verify end-to-end behavior:

```bash
aerial probe --live
# machine-readable output
aerial probe --live --json
```

`--live` sends one small request through the first available `responses`, `messages`, and `chat` model. It does not test every model by default, which keeps the command lightweight.
## Prompt Cache

Aerial uses the upstream Copilot/OpenAI/Anthropic cache protocols instead of keeping a local prompt-content cache. That keeps the MVP lightweight and avoids storing prompts on disk.

Supported behavior:

- Responses and Chat Completions preserve `prompt_cache_retention` and `prompt_cache_key` when the client sends them.
- Responses and Chat Completions automatically add `prompt_cache_retention: "in_memory"` and a stable hashed `prompt_cache_key` when the client omits them.
- Anthropic Messages preserves client `cache_control` blocks. When none are present and caching is enabled, Aerial automatically adds `cache_control: { "type": "ephemeral" }` to stable `system` content, or to the final tool definition when there is no system content.
- Usage fields from upstream are returned unchanged, including `cached_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, and Copilot `cache_read` / `cache_write` token details when present.
- Aerial logs cache metadata to stderr as `cache_request` and `cache_observe` events. These logs do not include prompt text or request bodies.

OpenAI's prompt caching documentation says cache hits require an exact prompt prefix match and are only possible once the prompt is at least 1024 tokens. Confirm cache behavior from returned usage fields such as `usage.prompt_tokens_details.cached_tokens` or `usage.input_tokens_details.cached_tokens`; for shorter prompts this value is expected to be zero.

Aerial enables ephemeral prompt caching by default for OpenAI-style routes and Anthropic Messages. Override it only when needed:

```bash
aerial config set promptCacheRetention in_memory
# or
aerial config set promptCacheRetention 24h
# disable automatic cache hints
aerial config set promptCacheRetention off
aerial config set promptCacheKey off
# pin all requests to an explicit cache partition
aerial config set promptCacheKey my-project
```

You can also set it per process:

```bash
export AERIAL_PROMPT_CACHE_RETENTION=in_memory
export AERIAL_PROMPT_CACHE_KEY=my-project
```

Per-request fields win over the configured default. Use `24h` only with models whose upstream route accepts extended retention; Anthropic Messages still uses Anthropic-style `cache_control: { "type": "ephemeral" }`. Set `promptCacheKey` to `auto` to use Aerial's hashed stable key, `off` to omit it, or a string to force a specific cache partition.
## Model Support

`GET /v1/models` returns Copilot's raw model metadata and adds an Aerial-specific field:

```json
{
  "id": "gpt-5.4-mini",
  "supported_endpoints": ["/responses", "ws:/responses"],
  "aerial": {
    "supported": true,
    "routes": ["responses", "responses_websocket"],
    "notes": []
  }
}
```

Route meanings:

- `responses`: usable by Codex through HTTP `POST /v1/responses`.
- `responses_websocket`: Aerial can use Copilot's upstream `ws:/responses` transport for streaming `/v1/responses` requests when `AERIAL_RESPONSES_WEBSOCKET=on` is set, then return SSE to the local client. When the opt-in is off (default), Aerial always uses HTTP upstream Responses even if a model advertises `ws:/responses`.
- `messages`: usable by Claude Code through `POST /v1/messages`.
- `chat`: usable by generic OpenAI Chat clients through `POST /v1/chat/completions`.

Local clients should not open WebSocket connections to Aerial directly. Direct WebSocket upgrades still return `501 Not Implemented`; use HTTP `POST /v1/responses` and let Aerial choose the upstream transport. HTTP upstream Responses is the default; set `AERIAL_RESPONSES_WEBSOCKET=on` to opt into Copilot's upstream WebSocket transport for streaming Responses calls (still experimental, only effective for streaming requests on models that advertise `ws:/responses`).

Known unsupported notes:

- `embeddings_not_implemented`: Aerial does not expose `/v1/embeddings` yet.
- `no_supported_endpoint_advertised`: the model did not declare a route Aerial can safely select.
