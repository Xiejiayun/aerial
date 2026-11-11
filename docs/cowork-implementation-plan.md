# Cowork-backed Claude Code: local trial design and implementation

Date: 2026-11-11
Base: origin/main at 9c492d1
Branch: user/jiaxie/cowork-claude-local
Status: local implementation and synthetic E2E complete; live M365 compatibility
is blocked pending authorized-session protocol evidence. See
[validation results](cowork-validation.md).

## Outcome and scope

Provide `aerial cowork run --model <catalog-id> -- <claude arguments>` for a
single Windows user to try Claude Code against an explicitly selected M365
Copilot Cowork route. The gateway runs in the current session on a random
loopback port, and exits with Claude. Existing GitHub Copilot setup, service,
Responses routing, credentials, and global Claude settings are preserved.

This is the session-based first increment of the supplied Cowork Opus design.
It uses the repository's JavaScript ESM conventions instead of introducing a
TypeScript build. Cowork requires Node 24+ and optional Microsoft WAM packages;
existing Aerial commands keep their current runtime/platform requirements.
No release, production deployment, or merge is part of the local trial.

## Architecture and ownership

```text
aerial cowork run
  -> fixed identity + model catalog + verified protocol profile
  -> profile lock + operation records
  -> session HTTP gateway (random local key)
  -> Claude child (private temporary settings file)

Claude Messages -> request/schema validation -> prompt envelope
  -> Cowork subscribe + one submit -> verified final result
  -> tool envelope validation -> Anthropic JSON/SSE -> Claude local tools
```

- `src/cowork/index.js`: public lifecycle and diagnostics, profile/model selection.
- `auth.js`, `wam-helper.js`: official WAM authentication with private IPC,
  explicit interactive authentication, silent refresh, fixed tenant/object ID.
- `profile.js`, `transport.js`, `events.js`: versioned protocol, models, bounded
  event decoding, subscription/submission and completion evidence.
- `protocol.js`: supported fields, ordered dialogue, JSON Schema and tool choice,
  strict output envelope, token estimates.
- `gateway.js`, `operations.js`: local authentication, HTTP/SSE, bounded work,
  cancellation, persisted submission states and conservative retry protection.
- `launcher.js`, `private-files.js`: Windows ACL before writing sensitive
  session files, child settings, routing isolation and cleanup.
- `src/cli/commands/cowork.js`: auth, doctor, models and run commands.

## P0 evidence gate

The reference implementation is investigation material, not proof for this
account. Do not copy its fixed region or Fable route as an Opus configuration.
Record only non-secret parameters and sanitized event structures.

1. Observe origin, application and resource parameters from normal authorized
   Cowork access. Never extract browser tokens or change clients to evade denial.
2. Obtain a fresh WAM token for those parameters; verify resource acceptance,
   tenant/object identity and the available model catalog.
3. Explicitly select a catalog route; no fallback to another model or account.
4. Verify accepted-task, event association and authoritative completion signals.
5. Confirm the cloud connector/default-tool disabling configuration is effective.
6. Capture synthetic requests from the installed Claude version, including
   thinking/beta fields, Read/Write tools and tool results.

An unverified profile may perform authentication/catalog diagnostics, but cannot
start the general programming gateway. Failed gates remain explicit blockers;
offline tests cannot promote a profile to live-verified.

## Protocol and failure behavior

- Only loopback binding; all useful endpoints require the session key; reject
  browser Origin. The empty HEAD warmup is the sole public endpoint.
- `/v1/messages` supports text and local tools. `/v1/models` lists the selected
  route. Count tokens returns 404. Health and readiness do not trigger inference.
- Preserve system/message ordering, tool IDs and `is_error`. Unsupported semantic
  fields, betas, images and signed thinking fail explicitly before submission.
- Validate tool schemas and the entire result envelope with no coercion, remote
  references, JSON extraction heuristics or text fallback on malformed output.
- Model tools are proposals. Claude Code performs permissions and execution.
- Results are buffered and validated before content SSE. Waiting uses heartbeats;
  errors never become successful message termination. Usage is marked estimated.
- Each operation submits at most one POST; SUBMITTING is persisted before send.
  Unknown remote results are retained across restart, never blindly retried.
  Matching cached results reuse message/tool IDs. State files contain no prompt,
  tool arguments, output text or bearer tokens.
- One writer holds the profile lock. A single absolute deadline covers the
  operation. Client disconnect aborts local work, not a claimed remote cancel.
- Pass retry restrictions and capability/estimate markers to the client.

## Client configuration

Normal launches preserve Claude workspace trust and permission checks. Pin the
session URL, random local key and selected route in an ACL-protected temporary
settings file. Keys never appear in argv. Reject conflicting launch options and
provider variables. Do not modify global settings or admin policy.

Do not present the adapter as full native Opus capability. Thinking must be
explicitly supported by verified Cowork behavior or absent from actual client
requests. A compatibility environment switch alone is not evidence.

## Implementation sequence

1. Write this plan; update main and create the implementation branch.
2. In parallel: authentication/protocol investigation, offline gateway, launcher.
3. Wire lifecycle and CLI; run offline regressions and package checks.
4. Run real installed Claude against a synthetic local upstream, using a fresh
   directory, explicit Read/Write tools, and inspect actual tool-result history.
5. After P0: run minimal live text and Read -> result -> Write -> result with
   synthetic files; measure complete task latency and count actual submissions.
6. Document exact evidence, failures and trial command. Leave work on the branch
   for local trial. Create a main-targeting PR after the user accepts the trial.

## Acceptance and reporting

- Existing default test suite, syntax and package/secret checks pass.
- Offline tests cover schema/choice violations, unsupported fields, malformed
  events, UTF-8/CRLF/compression, disconnect, late stream errors, duplicate
  submission protection, identity changes, ACL and launcher cleanup.
- Real Claude + fake Cowork and real Claude + live Cowork are reported separately.
- Live success requires actual output file content and correlated tool results,
  not just an HTTP 200, model self-identification or a text-only response.
- Report requested/resolved model separately from actual model identity if the
  upstream does not report it. No performance or billing claims from estimates.
- Authentication denial, missing Opus or unverified tool controls leave the
  feature gated and the implementation available for continued investigation.

## Recovery

Exit the trial Claude session to stop its gateway. Start Claude normally to use
the previous configuration. An interrupted remote task may continue; local exit
does not undo usage. Operation records preserve uncertainty. Do not delete locks
or release unknown operations automatically when ownership cannot be proven.

## Validation results

Implemented the session gateway, WAM integration, explicit profile configuration,
fixed-text investigation probe, launcher and recovery commands. Full local
results and remaining P0 gaps are recorded in [cowork-validation.md](cowork-validation.md).
The live profile gate remains enforced. No release or main-targeting PR has been
created before a successful real trial and user acceptance.
