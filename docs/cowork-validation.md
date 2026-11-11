# Cowork local implementation validation

Date: 2026-11-11 (Asia/Shanghai)
Branch: `user/jiaxie/cowork-claude-local`
Base main: `9c492d1`
Machine: Windows, Node.js 26.13.0, Claude Code 2.1.281.

## Current outcome

The local adapter, launcher and protocol chain are implemented and tested.
**Real M365 Cowork / Opus E2E has not been run or passed.** The feature remains
gated until the account-specific protocol prerequisites are established. There
is no verified Opus route configured for this machine by this implementation.
No live inference or billing claim is made from the synthetic tests.

## Executed validation

| Check | Result |
| --- | --- |
| `npm test -- --test-concurrency=4` | 619 passed, 12 platform-dependent skips, 0 failures (631 total) |
| New Cowork unit/HTTP/lifecycle tests | Included in the passing full suite |
| `node scripts/check-syntax.js` | Passed |
| `node scripts/verify-package.mjs` | Passed; runtime JS included, tests and investigation files excluded |
| `node scripts/verify-secrets.mjs` | Passed |
| npm dependency audit during installation | 0 vulnerabilities |
| Real installed Azure SDK import and broker availability | Passed; no token request or sign-in performed |
| Real Claude, default tools, real local gateway/transport, synthetic Cowork HTTP/SSE | Passed |
| Same chain with Write denied by Claude permissions | Passed; error result returned, output file absent |
| Real M365 authentication/model directory/inference | Not performed; protocol evidence incomplete |
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

## P0 evidence and blocker

Normal Edge navigation reached the signed-in Cowork page after the user
completed Windows Hello. The browser-control tool subsequently stopped because
it could not verify whether the current browser URL was allowed. No alternative
browser-control mechanism was used to bypass that restriction.

Public static resources already observed on the normal page were inspected
without credentials. They confirm that the production Cowork realm obtains
its base URL dynamically; they do not establish this account's runtime region.
A shared public client-ID constant is only a candidate, not proof of the actual
Cowork authorization request. No browser token, cookie or credential store was
read or copied.

Still required before a live trial:

1. Observe the actual Cowork API origin and client/resource authorization
   parameters in normal authorized access.
2. Verify WAM resource acceptance and the account's exact available Opus route.
3. Use the fixed synthetic probe to confirm acceptance, association and terminal
   event semantics; do not mark a whole profile verified from a text response.
4. Establish evidence that the submitted connector/default-tool configuration
   is effective, and verify an effort value.
5. Run the real Claude Read/result/Write/result sequence against that route,
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
