# Claude and Codex through the same local Aerial proxy

The requested setup is Claude Code through M365 Cowork and Codex through
GitHub Copilot, both using `http://127.0.0.1:18181`. Configure Claude with
`aerial setup claude --provider cowork --model opus-5.5 --effort medium`, then
start the native `claude` command. Codex retains its existing configuration.

## Routing and lifecycle

The main proxy recognizes the exact configured `cowork/` model namespace on
Messages requests. GitHub Messages models and the Responses endpoint preserve
their existing transport. A Cowork model on any other inference endpoint fails
explicitly. There is no cross-provider fallback.

`config.cowork` stores the selected public model ID, absolute profile directory,
effort, and optional display name. No Microsoft token or gateway key is stored
there. The main proxy lazily opens one Cowork gateway, preserving its profile
lock, operation history, identity checks, concurrency limits and silent WAM
renewal. Each client request retains its session/idempotency selectors and
cancellation. The internal gateway has its own in-memory authentication key;
the outer Aerial key and unrelated client headers never reach it.

Authenticated provider status checks verify the selected session. The public
model catalog describes configured Cowork routes without claiming fresh
authentication. The authenticated `/_aerial/cowork/catalog` endpoint returns
the active owner's catalog, so `aerial cowork models` does not compete for the
profile lock held by the service.

Model and effort changes use `POST /_aerial/cowork/reload`. Reload closes the
previous Cowork session and verifies the replacement without stopping the
port 18181 listener or GitHub routes. It rejects changes while startup, another
reload, inference, or response delivery is active. Setup saves the selected
configuration, reloads it, validates one text request, and only then writes
Claude settings. A failed switch restores and verifies the previous route;
if cleanup or restoration cannot be confirmed, it reports the recovery needed.
A partial client-settings write retains the verified route for takeover-journal
recovery. Complete the current Claude request before changing model or effort;
requests arriving during the switch can receive a configuration/reload error.

Windows service stop/restart/uninstall first closes Cowork through an authenticated
local endpoint and waits for lock release before terminating the service tree.
Unexpected process crashes still require review of a stale profile lock and
unknown operations; they never authorize automatic resubmission.

## Client configuration and limits

Setup verifies the installed Claude version, profile policy, route, selected
effort, local key helper and one real text request before saving Claude's
settings. It uses the existing backup/takeover mechanism. The permanent client
settings use the Aerial key helper and port 18181, with the compatibility
settings previously applied only by `aerial cowork run`. Thinking and unsupported
client features remain disabled; the tested Claude updater is disabled for this
configured client. Local tool permissions remain under Claude's control.

The supported catalog families are Anthropic Opus, Sonnet and Fable. Selection
always uses an exact upstream or public model ID; unavailable models do not
fall back to another provider. Effort names are `low`, `medium`, `high`, `xhigh`
and `max`, subject to that model's advertised and verified capabilities.
The catalog's supported/default effort values are discovery data, not evidence
that a route has been tested. Effective support is the intersection of the
catalog and the exact model's recorded verification. Legacy unscoped effort
evidence applies only to the exact Anthropic `opus-5.5` route; it does not
enable another Opus version, Sonnet or Fable.

```powershell
aerial cowork models
aerial cowork verify --model sonnet-5.5 --effort max
aerial setup claude --provider cowork --model sonnet-5.5 --effort max
claude
```

`verify` sends one fixed text probe and consumes Cowork allowance. It records
model/effort evidence only after matching text, HTTP acceptance and correlated
completion. Stop the owning Aerial service before verification, then start it
before setup. The temporary launcher also accepts explicit effort selection:
`aerial cowork run --model opus-5.5 --effort medium`. Both commands retain the
existing profile policy. Neither route verification nor selecting an effort
proves that the model applied a particular reasoning budget or that cloud tools
are isolated.

For Claude 2.1.322, `max` is configured through `CLAUDE_CODE_EFFORT_LEVEL=max`;
the writer removes conflicting persistent effort fields instead of saving a
value rejected by that client's settings schema. Setup preserves unrelated
settings, records a backup and uses the existing takeover recovery mechanism.

An experimental profile can explicitly allow use while cloud-tool isolation
remains `unverified`; ordinary profiles continue to require verified isolation.
Tool proposals are simulated, output is buffered, and usage is estimated.
Text/code tool results are supported. Images, PDF/document blocks, native
signed thinking and tool-search references remain unsupported. A `Read` that
returns media produces a specific error before upstream submission. The
gateway neither discards the block nor sends base64 as ordinary text. Because
Claude resends conversation history, a media-bearing conversation must be
replaced with a new text/code conversation or used with a media-capable provider.
The existing session launcher remains available when the persistent service is
not holding the same profile. Authentication/profile changes require stopping
the owning service first.

## Verified conversation reuse

Conversation reuse is separately gated by
`capabilities.verifiedModelConversationReuse[upstreamModel]`. The explicit live
helper `scripts/verify-cowork-conversation.mjs` submits two fixed synthetic turns:
the first supplies a marker and the second must recall it. Both operations are
journaled separately. Version 2 evidence is committed only after both turns
have matching completion and request nonces, one conversation ID and distinct
request IDs. The helper does not
retry an uncertain submission and does not change cloud-tool isolation flags.

With that gate enabled, an authenticated Claude session selector maps to an
opaque conversation UUID under the fixed account/profile and exact model route.
Only its hash and operation metadata are persisted; prompts, media, tool
arguments, result text and raw session selectors are excluded. The mapping
survives service restart. Missing selectors or unverified models continue to
use an independent conversation for each request.

Every turn sends the complete current client conversation and tool schema; the
latest request is authoritative. Reuse does not remove history from the payload
or claim a smaller token budget. The local token estimate covers the current
adapter prompt, excluding the short transport response frame and any history
retained by Cowork; it is not the upstream context size or billed usage.
Each upstream submission gets a fresh message
ID and must pass current-request lifecycle and terminal-event correlation.
For reused conversations, the transport also requires a response prefix tied
to that fresh message ID and removes it before decoding the client response.
This rejects a delayed previous final result even if it arrives after the new
request's start event. Missing or incorrect prefixes fail explicitly without a
repair request or retry. Same-conversation turns are serialized, while separate Claude
sessions can use the existing bounded global concurrency and queue. Total
deadlines include queue time.

An uncertain submitted operation quarantines its whole conversation, including
already queued later turns and requests after restart. Explicitly releasing the
reviewed operation rotates to a new conversation UUID; it never makes the old
possibly running task safe to reuse and does not cancel it remotely. Released
operation mappings can be reclaimed at the metadata bound. Identical request
deduplication and cached tool IDs retain their existing rules independently of
conversation reuse.

## Acceptance

Regression coverage includes provider separation, authentication before body
processing, browser Origin rejection, credential replacement at the internal
hop, shared startup, independent cancellation, model/effort reload, shutdown
ordering, setup rollback, and unchanged Codex settings. Reuse coverage includes
route/profile separation, restart persistence, session serialization, independent
session progress, unknown-operation quarantine, explicit-release rotation and
bounded metadata. Offline assertions do not constitute real M365 verification.

Real acceptance runs the native Claude executable with the saved user settings, without the
Cowork launcher or a settings overlay, against synthetic Read/Write and denied
Write scenarios. Validation must run outside Codex's Windows package context.
Record each tested model/effort and the two-turn reuse outcome in the validation
report. This design document does not assert that those live checks passed.
