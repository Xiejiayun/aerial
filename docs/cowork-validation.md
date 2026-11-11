# Cowork local implementation validation

Date: 2026-11-11 (Asia/Shanghai)
Branch: `user/jiaxie/cowork-claude-local`
Base main: `9c492d1`
Machine: Windows, Node.js 26.13.0, Claude Code 2.1.281 and 2.1.322.

## Current outcome

**Real Claude Code + M365 Cowork / Opus Read/Write and Write-denial E2E passed**
on this machine. The user revised the earlier strict acceptance requirement to
prioritize a usable local Claude trial. The profile now explicitly enables
`localTrial.allowUnverifiedCloudTools`; cloud-tool isolation remains recorded as
`unverified`, and doctor reports `ready_experimental`. Default profiles still
require verified isolation. Authentication, event correlation, completion,
effort, exact model selection and Claude's local permissions remain enforced.

Both live scenarios used the `opus-5.5` route, medium effort, unpredictable
synthetic file contents, and the actual Claude 2.1.281 executable. Read/Write
completed in 29.555 seconds and permission denial in 33.493 seconds. Each had
three accepted upstream turns, two tool proposals and zero gateway errors.
The first produced the exact uppercase output; the second returned the real
Write denial, demonstrated the prior Read and left output.txt absent. Private
reports are retained with the local Cowork profile. These results establish
the tested local tool loop, not verified cloud-tool isolation or every Claude
feature. Usage in Anthropic-compatible responses is estimated.

## Executed validation

The persistent 18181 integration passed the complete suite: 736 passed,
12 platform-dependent skips and zero failures (748 total). Syntax checks passed
for 90 files; package validation accepted 82 files, and the secret scan passed.
It was packed and installed locally without registry publication.

Native Claude 2.1.322 used the saved user settings and Aerial key helper, with
no Cowork launcher, routing environment injection, `--model`, or `--settings`.
Real M365 / Opus 5.5 medium Read/Write passed in about 28 seconds. After a real
Windows service restart released the old profile lock, the denied-Write case
passed in about 31 seconds. Each case used three Cowork requests and two tool
proposals, with zero gateway errors; CLI model usage contained only the selected
Cowork route. The second case preserved the input, returned its unpredictable
first line, reported a real Write denial and left output absent.

An independent GitHub Responses request using the existing Codex model
`gpt-6-astra` returned `CODEX_GITHUB_READY`. Existing Aerial/GitHub keys, Codex
routing and its other settings were retained. A concurrent change confined to
Codex's `tui` section was observed and preserved. The Aerial configuration gained
only its `cowork` section. Both clients report `aerial` configuration status.
These live checks ran in unpackaged Windows processes (package API result
15700), avoiding the earlier AppData visibility problem.

The final Windows default-directory fix passed `npm test`: 681 passed,
12 platform-dependent skips and zero failures (693 total). The four added
tests cover directory override precedence and a default independent of AppData.

Windows redirected the original AppData path inside Codex's MSIX package, so
successful checks from Codex did not establish visibility in ordinary
PowerShell. The default is now `~/.aerial/cowork`. All 12 local state/evidence
files were moved from their resolved package-private location, with hashes
verified before any runtime check; no second operation store was created.
Historical AppData locations below describe the earlier investigation.

An independent PowerShell process confirmed `GetCurrentPackageFullName` returned
15700 (`APPMODEL_ERROR_NO_PACKAGE`). With no configuration overrides, the
installed package passed doctor and a real Claude 2.1.322 / `opus-5.5` request
returned `COWORK_EXTERNAL_READY`. Authentication and all four existing live
evidence reports were retained. Isolation remains `unverified`.

| Check | Result |
| --- | --- |
| `node --test --test-concurrency=4` | 677 passed, 12 platform-dependent skips, 0 failures (689 total); final launcher authentication cleanup also passed its focused tests and real-client checks |
| New Cowork unit/HTTP/lifecycle tests | Included in the passing full suite |
| Focused correlation/transport/CLI/auth-probe tests | 55 passed, 0 failures; included in the final full-suite result |
| `node scripts/check-syntax.js` | Passed |
| `node scripts/verify-package.mjs` | Passed; 78 package files, runtime JS included, tests and investigation files excluded |
| `node scripts/verify-secrets.mjs` | Passed |
| npm dependency audit during installation | 0 vulnerabilities |
| Real installed Azure SDK import and broker availability | Passed; no token request or sign-in performed |
| Real Claude, default tools, real local gateway/transport, synthetic Cowork HTTP/SSE | Passed again after strict terminal-correlation enforcement |
| Same chain with Write denied by Claude permissions | Passed; error result returned, output file absent |
| First two real M365 WAM attempts | Timed out without a user-visible login window; no token, model GET or inference completed |
| Native WAM owner-window checks after fixes | Actual HWND visibility and explicit/EOF cleanup verified on Windows; no authentication in these checks |
| Third real M365 WAM attempt after visibility fix | Passed after user sign-in; token client/resource/scope/identity checks and real catalog GET succeeded at `2026-11-11T07:44:37Z`; `opus-5.5` present |
| Independent CLI doctor | Silent WAM and catalog access passed; readiness remains `protocol_unverified` because cloud-tool isolation is not verified |
| Microsoft standard device-code flow | Challenge issued; account authorization denied by conditional access error `530033` because sufficient device proof was absent |
| Read-only Windows device registration diagnostic | `AzureAdJoined: YES`, `DeviceAuthStatus: SUCCESS`, `WamDefaultSet: YES`, `AzureAdPrt: YES` |
| Real M365 model directory from user's signed-in browser | User supplied the runtime origin and catalog, including `opus-5.5` |
| Fixed-text live protocol probe | Passed with silent WAM in a new process; HTTP 202 accepted, `expectedTextMatched: true`, final `fr` and lifecycle `rl:ok`, selected upstream route `opus-5.5` |
| Fixed-text live probe with `--effort medium` | Passed; terminal `rl.mid` matched the submitted ID and reported zero tool calls; acceptance does not measure internal reasoning behavior |
| Real Claude Code tools through M365 Cowork | Read/Write and Write-denial passed in explicitly selected experimental mode; three upstream turns and zero gateway errors each |
| Real Claude default tool catalog, Opus 5.5 identity, synthetic upstream | Both Read/Write and Write-denial passed with 21 declared tools and zero gateway errors |
| macOS/Linux and other Node CI jobs | Not run on this Windows machine |

The first default-concurrency full-suite run encountered key-helper startup
timeouts under process contention. The affected readiness tests passed in
isolation; the entire unchanged suite then passed with four workers. No timeout
assertions were removed and no tests were disabled to obtain the passing run.

## Reproducible local E2E

From the repository root:

```powershell
node scripts/smoke-cowork-claude.mjs "$env:USERPROFILE\.local\bin\claude.exe" --default-tools
node scripts/smoke-cowork-claude.mjs "$env:USERPROFILE\.local\bin\claude.exe" --default-tools --deny-write
```

This is the actual tested chain:

```text
Installed Claude Code
  -> session launcher and ACL-protected temporary settings
  -> Aerial Cowork HTTP gateway and strict tool envelope parser
  -> actual Cowork transport and SSE parser
  -> explicitly synthetic local HTTP/SSE server
```

The synthetic server uses no account tokens and no Microsoft network endpoints.
It returns deterministic tool proposals, so these checks prove integration and
permission handling, not model reasoning or tool-generation quality.

Each run asserted one model-directory request, three independent subscriptions,
three unique POST submissions receiving 202, and three final/lifecycle pairs.
It checked the selected upstream route, effort, identity/conversation headers
and connector configuration. Claude actually read a temporary input file and
returned tool results. The allowed case wrote and verified the output file;
the denied case returned an error tool result without creating the file.
Both recorded three gateway turns, two tool proposals and zero gateway errors.

The default permitted tool catalog was validated, including WebFetch's URI
format. Synthetic user and project settings contained competing provider URLs,
keys and model aliases. The invocation overlay selected the intended route and
left both original settings files byte-for-byte unchanged. No general claim is
made about all organization-managed policy sources or background agents.

## Experimental trial compatibility fix

After the initial delivery, Claude automatically updated to 2.1.322. The
previous exact-version check rejected it before creating a Cowork session.
The supported executable list now includes both 2.1.281 and 2.1.322. Live
reports record the actual executable version instead of assuming one version.
The 2.1.322 native client passed the default-tool synthetic Read/Write and
Write-denial checks, and both real Cowork scenarios passed in 31.041 and 29.401
seconds respectively, with zero gateway errors.

The newer client emitted adaptive thinking despite the legacy zero-budget
setting. Its explicit `CLAUDE_CODE_DISABLE_THINKING=1` control now suppresses
that unsupported request feature; the gateway continues rejecting unsupported
thinking semantics. Only the Cowork child has automatic updates disabled.
Interactive checks also exposed redundant credential prompts: the child now
uses the local bearer token and explicitly clears its inherited API-key variable
and helper setting. The existing global Claude configuration is preserved.
The actual 2.1.322 terminal UI was tested with those user settings and returned
a response to `hello` using Opus 5.5 with medium effort.

Initial live Read/Write and Write-denial attempts produced correct file and
permission results, but the zero-error assertion failed. Bounded gateway
diagnostics identified an extra initial Messages request carrying
`fallback-credit-2026-06-01`. The client removed that unsupported beta and retried
before the three successful upstream turns. No failed assertion was removed.

The installed client's logic confirmed that its refusal-fallback feature arms
this credit lane for the recognized Opus 5.5 identity. The session launcher now
sets `CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK=1`, keeping the selected route fixed.
The beta remains unsupported by the gateway. A new synthetic Opus 5.5 scenario
reproduced the failure before this change and passed with the default 21 tools
after it, including Write denial. Both final real scenarios also passed without
the initial error. Diagnostic logs record only allowlisted endpoint, capability,
effort and beta names; an arbitrary beta ending in a date is not logged.

## Earlier P0 evidence and remaining isolation work

The following investigation records the original strict-mode acceptance
decision. The later explicit local-trial policy described above permits local
use without promoting the remaining isolation evidence.

Normal Edge navigation reached the signed-in Cowork page after the user
completed Windows Hello. The browser-control tool subsequently stopped because
it could not verify whether the current browser URL was allowed. No alternative
browser-control mechanism was used to bypass that restriction.

Public static resources already observed on the normal page were inspected
without credentials. They confirm that the production Cowork realm obtains
its base URL dynamically. The user subsequently supplied these observations
from their signed-in browser:

- `GET https://mcsaetherruntime-seas.as-ia101.gateway.prod.island.powerapps.com/v1/models`
- Catalog entries `gpt-5.5`, `opus-5.5`, `sonnet-5.5`, and `fable-5-2`.
  Opus advertises provider `anthropic`, default effort `medium`, and efforts
  `low`, `medium`, `high`, `xhigh`, and `max`.
- Current source resource map: `CoworkerProd` maps to
  `6ab48b67-cd74-4ad4-81af-5932984589be`.

The WAM client `c0ab8ce9-e9a0-42e7-b064-33d422df41f1` and scope
`6ab48b67-cd74-4ad4-81af-5932984589be/access_as_user` have now passed normal
WAM authorization, token checks and acceptance at the observed model directory.
A native client does not need to appear in the web application's OAuth request:
these are different OAuth clients. The device-code sign-in page also identified
this public client as `M365ChatClient`. No browser token, cookie or credential
store was read or copied.

`scripts/probe-cowork-auth.mjs` now provides that separate diagnostic: one WAM
acquisition, token routing/identity validation and one bounded read-only catalog
GET, without redirects or automatic retries. On success it can save only
account selectors and evidence to a new ACL-protected directory. The profile's
inference capability flags remain unverified. It cannot submit a prompt.

Two WAM attempts timed out after five minutes; the user reported no login
window. The helpers exited and no profile/account directory was created. Public
Entra authority metadata was reachable (HTTP 200). The original helper passed
an all-zero parent window handle even though Microsoft's broker documentation
requires a valid parent window handle. An owned WinForms interaction host now
supplies that handle, with non-secret authentication-stage diagnostics.

Actual host checks exposed two local defects that mocks did not catch:
Windows PowerShell's `Console.In.ReadLineAsync()` synchronously blocked startup,
and the inherited hidden startup state could fire `Shown` while native
`IsWindowVisible` remained false. A C# background stdin reader now permits the
message loop to start; the host explicitly shows its own HWND and checks native
visibility before returning it. Explicit close and parent-pipe EOF were both
verified to exit the host. After the visibility fix, the third WAM attempt
displayed its sign-in window and the user completed authentication. The earlier
timeouts were local window-lifecycle failures, not evidence of tenant denial.

At `2026-11-11T07:44:37Z`, the probe validated the returned token's client,
resource, scope and resource identity, and a real `GET /v1/models` succeeded.
The accepted catalog includes `opus-5.5`. The new private evidence directory is
`%LOCALAPPDATA%\aerial\cowork-auth-probe-20261111`; it holds allowlisted account
selectors and evidence under a current-user ACL, with no persisted bearer token.
A subsequent independent CLI doctor invocation succeeded using silent WAM and
the catalog. Its readiness result remains `protocol_unverified`, since catalog
access does not verify connector isolation, event correlation, completion or
reasoning effort. No personal account, tenant, device or network identifiers are
included in this report.

In response to the user's request for browser authorization, a separate
official `DeviceCodeCredential` diagnostic tested the same client and resource.
Microsoft issued a standard device authorization challenge, but account
authorization failed with conditional access error `530033`. The sign-in page
identified the device as `Unregistered`: that grant did not provide the device
proof required by this policy. A read-only local device-registration diagnostic
reported `AzureAdJoined: YES`, `DeviceAuthStatus: SUCCESS`, `WamDefaultSet: YES`
and `AzureAdPrt: YES`; the machine itself is registered, and normal WAM device
authentication succeeded. The device-code failure does not invalidate the
successful WAM result. No token/cache file was written by that diagnostic.

The current implementation supports WAM sign-in, not a working external-browser
login under this account's device-code policy. No localhost-callback browser
flow has been verified, and the diagnostic does not establish such support.

The fixed-text live probe subsequently completed using silent authentication
from a new process. Its single submission received HTTP 202, the expected text
matched, and the observed completion sequence contained `fr` plus `rl:ok`.
The selected upstream route was `opus-5.5`; this does not assert the internal
serving model's actual identity. This is a real text-only success, not a verified
Claude Read/Write loop or a promotion of all protocol capabilities.

A second fixed-text probe with requested effort `medium` also returned HTTP
202, the expected text and `fr` followed by `rl:ok`. Its `q.mid`, initial
`rl.mid` and terminal `rl.mid` matched the submitted message ID; `fr.mid` was a
separate assistant message ID. The final stop reason was `end_turn`, and the
reported tool-call count was zero. This demonstrates acceptance of the requested
effort, not a measurement of internal reasoning behavior.

Sanitized `cs` events and a read-only resubscription to the first completed
conversation reported zero servers and zero packages. `tk` reported one item,
whose semantics remain unknown; it must not be labeled a verified tool catalog.
These observations do not prove that every built-in cloud tool is unavailable.
The user explicitly reconfirmed that general Claude use and live Read/Write E2E
must remain gated until isolation is established. No capability flag was changed
merely to enable the trial.

Recorded protocol evidence now marks completion, request association and the
advertised/accepted `medium` effort as verified; `connectorsDisabled` remains
`unverified`. The production parser requires explicit terminal request
correlation and rejects mismatched `q/rl.mid`, missing request context, missing
terminal association and conflicting IDs. `fr.mid` remains an independent
assistant message ID. These contracts have regression coverage, and the general
inference gate was checked to remain closed after recording the partial proof.

A bounded public-source investigation followed the actual Cowork frontend
module chain and its explicitly referenced CDN manifest, build
`20261111.51.0-ae7759d8`. Client classification code recognizes several built-in
tools, including tool search and task management. It does not expose a verified
effective tool manifest or a configuration that proves all built-in tools are
disabled. The empty connector status and zero observed tool calls therefore
remain insufficient. The conventional service OpenAPI path returned 404.

Still required to claim verified isolation and broader compatibility:

1. Establish the request/configuration and server confirmation that disable all
   cloud tools, including built-ins, and clarify effective-tool-list semantics.
2. Extend the passing real Read/result/Write/result and permission-denial
   sequences to interruption, unsupported fields and long-context handling.

Do not substitute the reference implementation's fixed region or Fable route,
and do not change capability flags merely to bypass this gate. Requested Opus
routing and actual model identity remain separate evidence claims.

## Model, effort and conversation reuse extension (2026-11-11)

The authenticated catalog advertised `opus-5.5`, `sonnet-5.5` and `fable-5-2`
as Anthropic routes with `low`, `medium`, `high`, `xhigh` and `max`. All fifteen
route/effort combinations passed the fixed text verification using the real
M365 transport: HTTP 202 acceptance, expected text, correlated request lifecycle
and terminal completion. This proves route/effort acceptance, not internal
reasoning effort or serving-model identity. Model-specific evidence was saved;
cloud-tool isolation remains `unverified` under the explicit local trial policy.

All three routes also passed the v2 two-turn conversation test at medium effort.
Each pair reused one conversation with distinct message IDs, recalled a fixed
context marker, and verified a fresh response nonce on both turns. The nonce is
required because `fr.mid` is an assistant ID and cannot by itself associate final
text with the current request. No raw identity, prompt, token or upstream conversation/message ID was
included in the sanitized evidence reports.

Claude 2.1.322 was independently exercised against a local capture server with
the final persistent settings writer: saved `max` produced
`output_config.effort: "max"`, no thinking block, and no CLI model/effort/settings
override. The full regression run with test concurrency four passed 788 tests
with 12 platform skips (800 total). An earlier unrestricted parallel run hit the
existing five-second key-helper timeout in two setup-readiness tests; the bounded
full rerun passed without changing tests or timeouts. All 161 JavaScript files
passed syntax checking, and the 82-file package preview contained no private
state or suspicious secret patterns.

The reported `tool_result.content non-text block` failure was traced using only
local session structure: a `Read` result included a base64 PNG image block, which
Claude retransmitted in subsequent request history. The adapter now explicitly
names unsupported media and explains recovery. It still supports text/code
tool results; images and PDFs are not silently discarded or represented as text.

After local packaging and global installation, native Claude 2.1.322 passed
Read/Write acceptance with saved settings for Opus 5.5 / medium, Sonnet 5.5 / high,
and Fable 5.2 / max. Each run made three upstream requests, proposed two local
tools, produced the exact expected file, and used exactly one Cowork conversation
with zero gateway errors. The Opus / medium Write-denial scenario also passed
with three requests and one conversation. No launcher, settings overlay, model
argument or routing environment was injected into these native runs.

The installed endpoint rejected a synthetic image tool result with a specific
recovery message and zero upstream submissions. Real GitHub Responses inference
with the saved Codex model `gpt-6-astra` returned the requested sentinel. Final
checks confirmed port 18181, the installed source matching the validated source,
unchanged Codex configuration and credentials, and unchanged Aerial configuration
outside `cowork`. The saved default was restored to Opus 5.5 / medium.

The local package has 82 files, 153984 bytes, and SHA-256
`ac313ce2d106d807ffccaca56907a6aa10970f98a1915d7b0128e927e49b0558`.
It was installed locally, not published to the npm registry. Evidence and the
delivery report are in `.tmp-local-npm-cowork-capabilities-20261111/`.

## Earlier trial and delivery state

The explicitly enabled local experimental trial is available. Strict mode
continues to require isolation evidence. The user's global Claude configuration
now selects Cowork on port 18181; Codex and GitHub Copilot routing are retained.
The updated
local npm package is delivered separately from an npm registry release. No main
merge, registry publication, deployment or PR was performed. A main-targeting PR
should follow user acceptance.

`aerial login --provider cowork` now reuses the configured WAM sign-in flow;
plain `aerial login` remains GitHub. `scripts/smoke-cowork-live.mjs` passed
normal and permission-denial acceptance against real Cowork in the explicit trial. It
uses the production gate, a private synthetic workspace, unpredictable input,
bounded output, a five-minute deadline and a report that cannot pass merely
because a file is absent. Its private report records whether experimental
policy was selected and preserves the unverified isolation status.
