# Cowork-backed Claude Code: local trial design and implementation

The subsequent persistent-provider increment is implemented and installed for
local acceptance: native Claude uses M365 Cowork and Codex retains GitHub
Copilot, both through port 18181. See [the persistent proxy design](cowork-persistent-proxy.md)
and [validation results](cowork-validation.md). The session architecture below
records the first increment and remains available when its profile is not
owned by the persistent service.

Date: 2026-11-11
Base: origin/main at 9c492d1
Branch: user/jiaxie/cowork-claude-local
Status: local implementation and synthetic E2E complete; WAM authentication and
the real model-catalog request passed, including visibility of `opus-5.5`.
Independent silent authentication/catalog checks also passed. A fixed-text live
probe passed through the `opus-5.5` route. Completion, event correlation and
the medium effort request are verified; cloud-tool isolation remains unverified.
An explicitly selected local experimental policy now permits trials while
preserving that evidence status. See
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
- `auth.js`, `wam-helper.js`, `auth-window.js`: official WAM authentication with
  private IPC, an owned visible interaction window, explicit interactive
  authentication, silent refresh and fixed tenant/object ID.
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

1. Establish the Cowork service origin and resource from the user's normal
   authorized web session. Record the observed parameters without browser tokens.
2. Verify a candidate native client through normal WAM authentication and a
   read-only request to that resource's model catalog. Check the token's client,
   audience, scope and tenant/object identity, then require actual resource
   acceptance. The native client's GUID need not equal the web application's
   GUID: these are different OAuth clients. A reference client ID remains a
   candidate until this check succeeds. Never rotate clients or authentication
   methods to evade an authorization or conditional-access denial.
3. Explicitly select a catalog route; no fallback to another model or account.
4. Verify accepted-task, event association and authoritative completion signals.
5. Confirm the cloud connector/default-tool disabling configuration is effective.
6. Capture synthetic requests from the installed Claude version, including
   thinking/beta fields, Read/Write tools and tool results.

An unverified profile may perform authentication/catalog diagnostics, but cannot
start the general programming gateway by default. The user's updated local-trial
requirement permits `configure --allow-unverified-cloud-tools` to save a separate
`localTrial.allowUnverifiedCloudTools` policy. It waives only the cloud-tool
isolation prerequisite, never authorization, event correlation, completion or
effort requirements. Imported profiles cannot silently enable that option;
the configure flag is required. Doctor and launch disclose the experimental
status. Offline tests and this option do not promote protocol evidence.

The independent source-checkout diagnostic is
`scripts/probe-cowork-auth.mjs`. It tests one explicit candidate through WAM and
`GET /v1/models`, without inference or browser credential extraction. Only after
the resource accepts the token and returns a valid catalog can it save
allowlisted profile/account metadata and authentication evidence in a new
private directory. Bearer tokens stay in memory. A successful authentication
probe does not verify connector isolation, event correlation, completion,
reasoning effort or Claude tool compatibility, and leaves inference gated.

The authentication/catalog gate passed at `2026-11-11T07:44:37Z`. After fixing
the WAM interaction window, the user completed the third sign-in attempt; the
probe validated client/resource/scope/identity and the real catalog included
`opus-5.5`. Sanitized evidence and account selectors were saved to the private
`%LOCALAPPDATA%\aerial\cowork-auth-probe-20261111` directory, without bearer
tokens. A separate CLI doctor invocation then passed silent authentication and
catalog access. Its `protocol_unverified` readiness result reflects the remaining
inference gate, not a failed sign-in or model-directory test. The fixed-text live
probe subsequently passed with silent WAM in a new process: HTTP 202 accepted,
`expectedTextMatched: true`, and observed `fr` plus `rl:ok` completion for the
selected `opus-5.5` upstream route. This does not confirm the internal serving
model's identity or verify a Claude tool loop. Sanitized `cs` server/package and
`tk` tool-directory metadata remain investigation leads. Connector controls
remain unverified. Subsequent probes verified event association, completion and
acceptance of medium effort. Strict mode retains the isolation gate; the explicit
local experimental policy permits a trial.

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

## Login UX and browser-flow limits

The implemented entry point is `aerial login --provider cowork`, with
`aerial cowork auth` retained and plain `aerial login` kept on GitHub.
`--provider github` is also explicit; unknown providers fail before authentication.
Cowork reuses its configured profile and Microsoft Windows sign-in window.
The existing GitHub flow displays a verification URL and user code; it does not
currently open a browser automatically.

The login command explains that a Microsoft sign-in window is opening, lets the
user choose a work account and complete MFA, then checks the model catalog.
Further UX can report identity verification,
available Opus routes and inference readiness separately. Let the user select
an exact Opus version and show the session launch command. No token copying is
part of this flow, and sign-in/catalog checks do not submit an inference task.

An external browser login is a separate authentication option requiring its own
evidence. The installed Azure SDK supports authorization-code plus PKCE with a
local callback, and a device-code flow that displays a URL and user code. The
browser flow requires a compatible Mobile/Desktop application registration and
registered redirect URI; device code requires an allowed public-client flow.
Both also depend on Cowork resource authorization and tenant policy. The
user-requested standard device-code diagnostic received a challenge for the
same public client, identified on the sign-in page as `M365ChatClient`, but the
account grant failed with conditional access error `530033`. The page showed
`Unregistered` because the grant lacked sufficient device proof. Read-only
Windows diagnostics showed `AzureAdJoined: YES`, `DeviceAuthStatus: SUCCESS`,
`WamDefaultSet: YES` and `AzureAdPrt: YES`, and WAM subsequently authenticated
successfully. Thus device-code browser login is not supported under the tested
policy by the current implementation; working WAM sign-in is not evidence of a
working webpage login. No localhost-redirect flow has been verified. Do not
automatically fall back after a denial or substitute another client ID.

Authentication caching also differs. WAM keeps its token cache in the operating
system, so the current short-lived helper can exit after returning a token over
private IPC. A normal browser/device-code helper would otherwise lose its
in-memory MSAL cache on exit; an `AuthenticationRecord` alone cannot restore the
refresh credentials. That option therefore needs a verified encrypted cache
provider or a separately managed authentication process, with cancellation,
identity isolation and cleanup tests. It must not be implemented merely by
disabling the broker flag or extracting tokens from a signed-in browser.

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
The full-suite checkpoint passed 645 tests with 12 platform-dependent skips
(657 total); the latest focused authentication/owner-window/CLI run passed all
44 tests. Native owner-window visibility and explicit/EOF close were verified
on Windows. Syntax checks passed for 84 JavaScript files and package verification
passed with 78 files. These checks and real authentication/catalog acceptance
are complemented by one successful fixed-text live round trip. Real Claude
Read/Write E2E and the remaining protocol capabilities have not been verified.
The live profile gate remains enforced. No release or main-targeting PR has been
created before a successful real trial and user acceptance.
