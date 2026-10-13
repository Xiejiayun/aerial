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
