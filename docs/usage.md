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

## 2. Generate Local API Key

```bash
aerial key generate
export AERIAL_API_KEY="<printed-key>"
```

Aerial stores only a hash of this key in its config file. Keep the raw value in your shell, password manager, or local secret manager.

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

Then run Codex with `AERIAL_API_KEY` exported. The setup command backs up and merges `~/.codex/config.toml`.

For a dry inspection without touching your real config, set `HOME`/`USERPROFILE` to a temporary directory before running this command.

## 6. Configure Claude Code

```bash
aerial setup claude
```

The setup command backs up and merges `~/.claude/settings.json`, using `apiKeyHelper = "aerial key print"` and `ANTHROPIC_BASE_URL=http://127.0.0.1:18181`.

For a dry inspection without touching your real config, set `HOME`/`USERPROFILE` to a temporary directory before running this command.

## 7. Verify

```bash
aerial doctor
curl -H "Authorization: Bearer $AERIAL_API_KEY" http://127.0.0.1:18181/v1/models
```

Each model returned by `/v1/models` includes an `aerial` field that tells you whether the MVP can route it:

```json
"aerial": {
  "supported": true,
  "routes": ["responses", "chat"],
  "notes": ["websocket_responses_not_implemented"]
}
```

Use `responses` models for Codex, `messages` models for Claude Code, and `chat` models only for generic Chat Completions clients. Models marked with `embeddings_not_implemented`, `websocket_responses_not_implemented`, or `no_supported_endpoint_advertised` need additional Aerial work before they are first-class choices.


## 8. Use Prompt Cache

Aerial does not implement a local prompt-content cache. It forwards cache protocol fields to Copilot and returns upstream usage fields unchanged. This is the intended design: prompts are not written to a local cache, and cache hits are controlled by the upstream service.

For Codex/OpenAI Responses clients, send cache fields directly:

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

For Claude Code or Anthropic Messages clients, use Anthropic `cache_control` where the client supports it:

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

To apply a default retention policy for OpenAI-style `/v1/responses` and `/v1/chat/completions` requests that do not set one:

```bash
aerial config set promptCacheRetention in_memory
# or: aerial config set promptCacheRetention 24h
# or per process: export AERIAL_PROMPT_CACHE_RETENTION=in_memory
```

Look for these usage fields to confirm cache behavior:

- Responses/Chat: `usage.input_tokens_details.cached_tokens` or `usage.prompt_tokens_details.cached_tokens`.
- Messages: `usage.cache_creation_input_tokens` and `usage.cache_read_input_tokens`.
- Copilot details when present: `copilot_usage.token_details` entries with `cache_read` or `cache_write`.

Best practice: put stable system/project/tool context first, put changing user input last, and keep the prefix identical between requests. OpenAI-style prompt caching generally needs at least 1024 tokens before hits appear.
## Troubleshooting

- `503 Missing GitHub token`: run `aerial login`.
- `401 Invalid or missing Aerial API key`: export `AERIAL_API_KEY` and use it in the client.
- Claude Code cannot read key: ensure `aerial` is on `PATH` and `AERIAL_API_KEY` is available to Claude Code's environment.
- Upstream compatibility error: run `aerial doctor`, then retry with a model returned by `/v1/models`.
- `Unsupported parameter: max_tokens`: Aerial normalizes Chat Completions `max_tokens` into `max_completion_tokens` before forwarding to newer OpenAI models.
- Cache hit stays zero: ensure the stable prefix is long enough, unchanged, and placed before variable content. For Responses/Chat, try a stable `prompt_cache_key`; for Messages, put `cache_control` on the stable `system` or content block.
