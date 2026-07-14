# Codex Model-Aware Effort Routing Design

Date: 2026-07-14

## Context

Codex and GitHub Copilot now advertise reasoning levels beyond Aerial's original
`low`, `medium`, `high`, and `xhigh` set. Codex can request `max` and `ultra`,
while the Copilot model catalog currently advertises `max` for GPT-5.6 models
and uses `none` where Codex configuration uses `minimal`.

Aerial currently aliases `max` to `xhigh` before setup and proxy forwarding.
That silently loses a model capability that is available upstream. A single
global effort vocabulary also conflates Codex Responses semantics with Claude
Code's effort settings.

## Goals

- Preserve an effort exactly when the selected Copilot model supports it.
- For an unsupported Codex effort, prefer the highest supported effort that
  does not exceed the request and otherwise use the model's lowest effort.
- Treat Codex `minimal` and Copilot `none` as the same semantic tier while using
  the spelling required at each boundary.
- Keep Claude Code's existing `max` to `xhigh` compatibility behavior separate.
- Continue serving requests when model catalog refresh fails.
- Keep Fast mode out of effort routing because it is a separate service tier.

## Non-Goals

- Adding or changing Codex Fast mode or `service_tier` configuration.
- Advertising `ultra` when Copilot does not advertise it.
- Retrying a failed inference request at a lower effort.
- Changing model selection or recommendation policy.
- Recovering whether a historical stored `xhigh` originally came from the old
  `max` alias.

## Chosen Design

### Client-Specific Semantics

The shared effort module will expose separate Codex and Claude parsing rules.
Codex uses the ordered semantic tiers:

`minimal < low < medium < high < xhigh < max < ultra`

`none` is accepted as an input alias for Codex `minimal`. Catalog values retain
their original wire spelling, so resolving `minimal` against a catalog that
advertises `none` produces `none` for the upstream request.

Claude keeps its current tiers:

`low < medium < high < xhigh`

For Claude only, `max` remains an alias for `xhigh`. Claude does not inherit the
Codex `minimal`, `max`, or `ultra` wire semantics.

### Resolver Contract

One resolver accepts a requested Codex effort and a model's advertised efforts.
It returns the requested semantic tier, the selected wire value, and whether a
fallback occurred.

Resolution rules are:

1. If the catalog contains the requested semantic tier, use its exact catalog
   spelling.
2. Otherwise choose the highest advertised semantic tier below the request. If
   no lower tier exists, choose the lowest advertised tier so the request stays
   usable.
3. If the catalog has no recognized efforts, apply only deterministic boundary
   aliases (`minimal` to `none`, `ultra` to `max`) and preserve other values.

The resolver selects a higher tier only when the model advertises no tier at or
below the request. Unknown catalog values are ignored for ranking rather than
rejected or guessed.

### Setup Flow

Setup continues to select a model before selecting effort. The selected model's
catalog metadata limits the interactive choices. Codex-facing display and TOML
use `minimal`; the proxy later converts it to an upstream-advertised `none`.

Explicit Codex input accepts `minimal`, `none`, `low`, `medium`, `high`, `xhigh`,
`max`, and `ultra`. It is resolved against the selected model before writing
`model_reasoning_effort`, so `--effort ultra` currently writes `max` for a
GPT-5.6 Copilot model.

Claude setup retains its existing accepted values and normalization.
`defaultEffort` remains the Claude proxy fallback. Codex setup stops updating
that value so Codex and Claude choices cannot overwrite each other's semantics.

### Proxy Flow

OpenAI-compatible request transformation becomes asynchronous so it can consult
the cached Copilot model catalog. It handles both `reasoning.effort` and the
flat `reasoning_effort` field.

For a known model, each requested effort is resolved against that model's
advertised capabilities before forwarding. Existing model-specific compatibility
rules remain as fallback behavior when a catalog entry is unavailable.

The route logs the model, requested effort, routed effort, and routing reason
only when it changes the request. It does not retry an inference response because
automatic replay could duplicate streaming output or tool execution.

### Catalog Availability

The existing per-token 30-second fresh cache remains. After a successful fetch,
the last catalog is retained as a stale fallback. When refresh fails, Aerial uses
that stale catalog and continues the request. If no successful catalog has ever
been fetched, the resolver applies deterministic aliases and existing known-model
compatibility rules without blocking inference.

## Compatibility

- Existing `low`, `medium`, `high`, and `xhigh` configurations remain valid.
- A Codex TOML value of `max` is preserved and reported as `max` after upgrade.
- A Codex TOML value of `none` is reported as canonical `minimal`.
- Historical `max` selections already persisted as `xhigh` remain `xhigh`;
  rerunning Codex setup is the explicit way to select true `max`.
- Claude `max` inputs continue to become `xhigh`.
- Invalid CLI values still fail before any file or key is created.

## Error Handling

- Catalog refresh failures are logged and use stale or deterministic fallback.
- Missing model metadata does not fail an otherwise valid inference request.
- Invalid setup input fails before configuration writes.
- Upstream inference errors are returned unchanged; no request replay occurs.

## Testing

Unit and integration coverage will verify:

- Codex parsing and ordering for `minimal`/`none`, `max`, and `ultra`.
- Exact preservation of supported `max`.
- `ultra` falling back to `max` and `max` falling back to `xhigh` when required.
- `minimal` using catalog wire value `none`.
- Unknown catalog values being ignored safely.
- Claude retaining `max` to `xhigh` behavior.
- Setup help, selection, TOML writes, status reads, and no-side-effect validation.
- Responses nested and flat effort routing plus Chat Completions flat routing.
- Fresh cache, stale-on-refresh-failure behavior, and per-token isolation.
- Full existing test suite remains green.

## Success Criteria

- A live GPT-5.6 Copilot request made through Aerial can reach upstream with
  `max` unchanged.
- A Codex `ultra` request reaches the same model as `max` when `max` is the
  highest advertised tier.
- A Codex `minimal` request reaches Copilot as `none` when advertised.
- Claude behavior and all unrelated proxy functionality remain unchanged.
