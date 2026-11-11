# Cowork local implementation validation

Date: 2026-11-11 (Asia/Shanghai)
Branch: `user/jiaxie/cowork-claude-local`
Base main: `9c492d1`
Machine: Windows, Node.js 26.13.0, Claude Code 2.1.281.

## Current outcome

The local adapter, launcher and protocol chain are implemented and tested.
**Real Claude Code + M365 Cowork / Opus tool E2E has not been run.** Aerial's own WAM
authentication and read-only model-directory request succeeded at
`2026-11-11T07:44:37Z`, confirming that the catalog exposes `opus-5.5` to the
authenticated account. A separate CLI doctor check also completed silent WAM
authentication and catalog access. Its `protocol_unverified` readiness result
is expected because cloud-tool isolation remains unverified; it is not a
failed authentication test. A fixed-text live protocol probe subsequently
passed through the `opus-5.5` route, using silent WAM in a new process. This
confirms real text round trips; the general programming gateway remains gated
pending cloud-tool isolation and Claude tool-loop verification.
No live inference or billing claim is made from the synthetic tests.

## Executed validation

| Check | Result |
| --- | --- |
| `node --test --test-concurrency=4` | 667 passed, 12 platform-dependent skips, 0 failures (679 total) |
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
| Real Claude Code tools through M365 Cowork | Pending protocol evidence and live tool-loop acceptance |
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

## P0 evidence and remaining work

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

Still required before a general programming trial:

1. Establish the request/configuration and server confirmation that disable all
   cloud tools, including built-ins, and clarify effective-tool-list semantics.
2. Run the real Claude Read/result/Write/result sequence against that route,
   including interruption, unsupported fields and context handling.

Do not substitute the reference implementation's fixed region or Fable route,
and do not change capability flags merely to bypass this gate. Requested Opus
routing and actual model identity remain separate evidence claims.

## Trial and delivery state

The local test above is available now. Normal `aerial cowork run` remains gated
until P0 and real E2E pass. GitHub Copilot services and the user's global Claude
configuration have not been replaced by this work. No main merge, package
publication, deployment or PR was performed. A main-targeting PR should follow
successful real trial and user acceptance.

`aerial login --provider cowork` now reuses the configured WAM sign-in flow;
plain `aerial login` remains GitHub. `scripts/smoke-cowork-live.mjs` is prepared
for eventual normal and permission-denial acceptance against real Cowork. It
uses the production gate, a private synthetic workspace, unpredictable input,
bounded output, a five-minute deadline and a report that cannot pass merely
because a file is absent. It has not been run against live Cowork.
