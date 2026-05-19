# Aerial MVP Usage

This document describes the current MVP implementation.

## 1. Install

```bash
npm install -g .
```

Or run locally from the repository:

```bash
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
