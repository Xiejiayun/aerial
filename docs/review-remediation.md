# Review remediation design — 2026-10-13

Baseline: `5a3c643` / 0.3.4. The locked install passes 373 tests (8 platform
skips), syntax, package contents, secret scanning, and CLI smoke. Dependency
audit reports three vulnerable packages. Existing update/upgrade work in the
original checkout is outside this change and will be integrated from main.

## Configuration and recovery

Help and argument validation run before any command can load credentials,
change files, or manage a service. Setup resolves client directory overrides
once and binds generated key helpers to the same Aerial directory as the
server. Sensitive writes preserve restrictive permissions and reject unsafe
replacement of symlinks. TOML changes recognize quoted/dotted keys and
multiline values, preserve unrelated text, and validate the complete document
before replacing the live file. The obsolete Aerial profile selector is
removed with its profile.

Each client takeover records the original state (including an absent file)
and the values last written by Aerial. Repeated setup retains that baseline.
`setup restore --latest` remains a one-step rollback. `teardown` instead
reconciles managed values against the baseline, preserves unrelated user edits,
and refuses to uninstall while a client still depends on Aerial. Missing or
invalid historical state must produce a recovery instruction, never a false
success.

For legacy installations without a journal, use the oldest valid pre-Aerial
backup. If that is unavailable, detach known managed fields to client defaults
and state that the original provider could not be recovered. Retain a private
pre-teardown snapshot and preserve unrelated settings.

## Client compatibility and onboarding

Claude setup uses client-recognized native model identities mapped to live
Copilot IDs, and chooses effort from the intersection of client and upstream
capabilities. Report requested/effective effort when it changes. Remove
conflicting managed provider/model settings and diagnose parent-environment
overrides. Status reflects actual settings, not fallback defaults.

Before switching client configuration, verify the local proxy and the selected
upstream route. A clearly labeled configure-only option supports deliberate
offline setup. Normal output prioritizes readiness and the next command;
details and structured events remain available explicitly. Model suggestions,
errors, and doctor actions are specific to the selected client.

## Proxy and service behavior

Propagate cancellation through token/catalog waits, request rewriting, upstream
HTTP, retries, and response streaming. Token estimates include the complete
input, with conservative treatment of non-ASCII and multimodal content. Retain
retry, rate-limit, and request-ID response headers without forwarding framing
or compression headers that no longer match the body.

Use one loopback URL builder for IPv4, localhost, and IPv6. Determine Windows
task state from numeric Task Scheduler state. Separate background-manager
support from proxy health so Linux foreground mode can be healthy. Probe and
overall status aggregate failures and always offer a concrete next step.

## Verification ledger

Each item receives a focused regression and commit before the next change.
The PR records completion and any environment limits against R01–R16 and the
CLI guidance findings. High-value integration checks are real Claude requests
through a local mock upstream, setup/repeated setup/teardown, help with no
side effects, pre-header disconnect, locale-independent service control, and
POSIX permissions on the CI operating-system matrix.

Release follows the protected-main PR, complete gates, clean-main preflight,
immutable tag, successful OIDC publication, provenance and exact-install
verification, and matching GitHub Release in `docs/release-runbook.md`.

The final release can use one manual dispatch from checked `main` when local
official-registry TLS is unavailable. It requires an explicit expected version,
performs the authoritative preflight on the runner, and only then creates the
annotated tag with `GITHUB_TOKEN` and publishes. This token's tag push does not
schedule a second Release run. Unknown/malformed history, reused versions,
conflicting tags, and failed pushes must stop before publish. Real temporary
Git repositories test the tag creation, refusal, and recovery sequence.

## Completion ledger

The review covered the CLI (this repository has no graphical app), setup and
recovery, service lifecycle, request transport, and release gates. These are
the reproduced findings, their fixes, and the checks used to close them:

| Finding | Resolution and evidence |
| --- | --- |
| R01 Claude model/effort mismatch | Native `modelOverrides`, per-model persistent effort, client/catalog intersection. Real Claude Code 2.1.281 against a local mock verifies medium, xhigh, max-to-xhigh, Opus 4.6 fallback, and explicit session max pass-through. |
| R02 recovery loses the original provider | First-takeover journal, repeated setup, three-way teardown, interrupted writes, legacy fallback and empty-container regressions. |
| R03 help/invalid arguments cause side effects | Complete argument validation before dispatch; subprocess tests inspect unchanged files. |
| R04 localized Windows task status | Numeric Task Scheduler COM state; unknown/query-failed state never means stopped. Real lifecycle verified on Windows. |
| R05 TOML editing corrupts valid layouts | AST edits preserve unrelated source; quoted/dotted/inline/multiline and old profile migration tests. |
| R06 disconnected requests continue work | Cancellation through token, catalog, retry, HTTP and WebSocket; real pre-header disconnect and stream cancellation tests. |
| R07 directory overrides and helper mismatch | Client overrides respected; helpers and wrappers bind the resolved Aerial directory. Isolated helper subprocess tests. |
| R08 Claude migration retains provider overrides | Clear conflicting user settings, preserve the baseline, diagnose inherited variables without their values, and reject setup before writes. |
| R09 failed inference reports successful probe | Aggregate checked routes into the overall result and process exit code. |
| R10 incomplete token estimate | Count the whole request, including tools/system and conservative media allowances. This remains an estimate, explicitly labeled. |
| R11 status/doctor misreport Linux and service failures | Separate manager support from health; platform-specific next steps and client-specific repairs. |
| R12 invalid IPv6 loopback URLs | One URL builder, with an actual IPv6 HTTP health test. |
| R13 response retry/diagnostic headers dropped | Preserve retry, rate-limit and request IDs while excluding transport/framing headers. |
| R14 proxy credentials in config output | Shared redaction, with synthetic credential regressions. |
| R15 vulnerable locked dependencies | Patched lockfile and authoritative npm audit in CI/Release. |
| R16 permissions widened by setup writes | Private writes preserve restrictive modes and reject unsafe replacements; POSIX checks run on Linux/macOS CI. |
| CLI guidance and initial setup | Client-specific model lists, requested/effective effort, classified failures, concise output, and verified setup before switching client configuration. Explicit offline setup is labeled unverified. |
| Additional native-service finding | Structured Windows registration removes the `/TR` length limit and works as a normal interactive user. Existing Windows/macOS Node 22 CI jobs perform real isolated install/refresh/stop/start/restart/uninstall and confirm cleanup. |
| Additional release-preflight findings | Reject malformed version history and a target that appears in history even if its individual lookup returns E404. Dispatch creates the immutable tag after preflight without triggering a duplicate Release run. |

Milestone 1 was merged in PR #13; milestone 2 in PR #14. Milestone 3 closes
client compatibility and onboarding. Its final local full suite has 499 tests:
487 passed, 12 platform skips, zero failures. Platform checks in the required
CI matrix cover those Windows-host skips. Package, secret, syntax, CLI and
dependency gates also pass. No version is published between milestones.

Tests use synthetic credentials and mock inference; they do not prove that
every Copilot account has access to every route. Normal setup now verifies the
selected route against the user's own running proxy. Project/managed client
policies and existing client sessions remain outside the user-settings check;
the completion message explicitly asks the user to restart and send a prompt.
