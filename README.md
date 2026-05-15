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
aerial setup claude
aerial setup all
aerial doctor
```

Service installation, rollback automation, Gemini CLI support, dashboards, and analytics are intentionally out of this MVP.

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

Generate a local Aerial API key:

```bash
aerial key generate
```

Save the printed value in your shell as `AERIAL_API_KEY`:

```bash
export AERIAL_API_KEY="aerial_..."
```

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

Then run Codex with `AERIAL_API_KEY` exported in the environment.

## Claude Code Setup

Aerial configures Claude Code through its Anthropic-compatible gateway settings:

```bash
aerial setup claude
```

This updates `~/.claude/settings.json` and creates a timestamped backup first. If you only want to inspect the exact change, set `HOME`/`USERPROFILE` to a temporary directory before running setup. It sets:

```json
{
  "apiKeyHelper": "aerial key print",
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:18181",
    "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY": "1"
  }
}
```

`aerial key print` prints `AERIAL_API_KEY` from the environment. If the raw key is not in the environment, generate and export a key first.

## Diagnostics

```bash
aerial doctor
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
- Prompt caching is upstream-managed: Aerial does not store prompt bodies locally, and it preserves cache fields clients send.


## Prompt Cache

Aerial uses the upstream Copilot/OpenAI/Anthropic cache protocols instead of keeping a local prompt-content cache. That keeps the MVP lightweight and avoids storing prompts on disk.

Supported behavior:

- Responses and Chat Completions preserve `prompt_cache_retention` and `prompt_cache_key` when the client sends them.
- Responses and Chat Completions can apply a default `prompt_cache_retention` for requests that omit it.
- Anthropic Messages preserves `cache_control` blocks, including `cache_control: { "type": "ephemeral" }` on `system`, message content blocks, and tool definitions.
- Usage fields from upstream are returned unchanged, including `cached_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, and Copilot `cache_read` / `cache_write` token details when present.

Set a default retention policy for OpenAI-style routes:

```bash
aerial config set promptCacheRetention in_memory
# or
aerial config set promptCacheRetention 24h
# disable the default injection again
aerial config set promptCacheRetention off
```

You can also set it per process:

```bash
export AERIAL_PROMPT_CACHE_RETENTION=in_memory
```

Per-request fields win over the configured default. Use `24h` only with models whose upstream route accepts extended retention; otherwise leave the client request explicit or use `in_memory`.
## Model Support

`GET /v1/models` returns Copilot's raw model metadata and adds an Aerial-specific field:

```json
{
  "id": "gpt-5.4-mini",
  "supported_endpoints": ["/responses", "ws:/responses"],
  "aerial": {
    "supported": true,
    "routes": ["responses"],
    "notes": ["websocket_responses_not_implemented"]
  }
}
```

Route meanings:

- `responses`: usable by Codex through `POST /v1/responses`.
- `messages`: usable by Claude Code through `POST /v1/messages`.
- `chat`: usable by generic OpenAI Chat clients through `POST /v1/chat/completions`.

Known unsupported notes:

- `embeddings_not_implemented`: Aerial does not expose `/v1/embeddings` yet.
- `websocket_responses_not_implemented`: HTTP Responses is supported; WebSocket Responses is not.
- `no_supported_endpoint_advertised`: the model did not declare a route Aerial can safely select.
