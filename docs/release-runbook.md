# Aerial Release Runbook

This runbook is the operational reference for releasing `@jiayunxie/aerial` to
npm. It covers stable releases, manual dispatch, and recovery procedures. It
is the authoritative source for who-does-what during a release.

## §1 Scope & Audience

- Audience: Aerial maintainers — the package owner and the project lead/SDE
  who operate the release pipeline (current mapping in §14).
- Covered: the two release paths — stable (tag-triggered) and manual dispatch
  (escape hatch).
- Not covered: Aerial feature development workflow or internal architecture.
  See `docs/development-design.md` for those.

## §2 Prerequisites (one-time setup)

Bootstrap happens in two phases because npm's trusted publisher (OIDC)
configuration requires that the package already exist on the registry —
you cannot register a trusted publisher for a name that has never been
published. The very first stable release therefore has to be a local,
authenticated publish by the package owner; every later release goes
through CI OIDC.

### Phase 1 — First stable bootstrap (only while `@jiayunxie/aerial` is unpublished)

- **Package owner local publish.** On a developer machine, log in with
  `npm login` against `https://registry.npmjs.org` as the npm account
  `jiayunxie`, then publish `0.1.0` directly:

  ```bash
  npm whoami                    # must print: jiayunxie
  npm test                      # 33/33 must pass
  node scripts/verify-secrets.mjs
  node scripts/verify-package.mjs
  npm publish --access public --tag latest
  ```

  This is the only path that publishes from a developer machine; once
  `@jiayunxie/aerial@0.1.0` is on the registry, subsequent releases use
  CI OIDC and never publish from a local shell. Provenance is not
  available on this bootstrap because trusted publisher is not yet
  configured; that is expected — every later release will carry
  provenance via `--provenance` in `release.yml`.
- **Do not push `v0.1.0` as a git tag during bootstrap.** Tagging would
  re-fire `release.yml`, which would try to publish via OIDC against an
  unconfigured trusted publisher and fail. Tag only after Phase 2 is
  complete (or skip the bootstrap tag entirely and let the next bumped
  version `v0.1.1` be the first tag-driven release).

### Phase 2 — After `@jiayunxie/aerial` exists on the registry

- **npm trusted publisher (OIDC).** Now that the package exists,
  associate `@jiayunxie/aerial` with the GitHub repository
  `Xiejiayun/aerial` and the single workflow file
  `.github/workflows/release.yml`. **npm only allows one trusted
  publisher binding per package**, so the publish path must originate
  from this one workflow file (see §7 for how `release.yml` is
  structured). Do not attempt to register a second binding for any
  other workflow file — npm will return `409 Conflict` and the second
  workflow cannot publish under OIDC. The binding can be configured
  from the npmjs.com package page → "Trusted publishing" UI, or from
  the CLI:

  ```bash
  npm trust github @jiayunxie/aerial \
    --repo Xiejiayun/aerial --file release.yml
  ```

  Do **not** configure an `NPM_TOKEN` secret in the repo; OIDC is the
  only standard authenticated publish route for automated releases.
  An automation `NPM_TOKEN` is reserved for emergency human-mediated
  fallback only (§13).
- **GitHub repository settings.** Default Actions permissions are
  acceptable. Each publish job in this repo explicitly declares
  `permissions: { contents: read, id-token: write }` — never wider.
- **Local toolchain for the SDE running tag pushes / manual dispatch.**
  Node.js ≥ 22, `gh` CLI logged in (used for creating stable release
  tags and pushing them). After Phase 1 the SDE does not need
  `npm login` for the release path; everything authenticated runs in
  CI under OIDC.

After Phase 2 is configured, the **next** stable release (`0.1.1` or
later) follows the standard tag-triggered flow in §5. The first
post-bootstrap release is also a good moment to verify the OIDC path
end-to-end: bump `0.1.0` → `0.1.1`, push the `v0.1.1` tag, watch
`release.yml` publish under OIDC with provenance, and confirm the
post-publish smoke passes.

## §3 Branching & Versioning Policy

- The only release branch is `main`. Feature branches must merge into `main`
  before becoming a release candidate.
- **Stable version source.** `package.json`'s `version` field is the source
  of truth for stable releases. The version MUST be a clean
  `X.Y.Z` (matching the regex `^[0-9]+\.[0-9]+\.[0-9]+$`); no prerelease
  suffix (e.g. `-rc.1`) and no build metadata (e.g. `+build.N`) is
  permitted. `release.yml` enforces the clean-semver shape via its
  "Validate package version is clean stable semver" step before any
  publish work; if it fails, the publish job hard fails. The release tag
  must equal `v<version>` exactly; `release.yml` enforces that equality
  at the tag-trigger path.

## §4 Daily Workflow (PR → main → CI)

- Every pull request triggers `.github/workflows/ci.yml`, which runs two
  jobs **in parallel** (no `needs:` chain between them); both must be
  green before merge:
  - `test` matrix (Node 22 × Ubuntu / Windows / macOS): `npm ci` → syntax
    check (`node scripts/check-syntax.js`) → `npm test` → CLI smoke
    (`node src/cli/index.js --help` and `node src/cli/index.js --version`).
  - `package & secret scan` (Ubuntu only): `npm ci` →
    `node scripts/verify-secrets.mjs` → `node scripts/verify-package.mjs`.
- After merge to `main`, CI runs again on the post-merge state. No publish
  happens on PR or merge.
- CI never invokes `aerial doctor`, `aerial login`, or any command that
  requires real GitHub or Copilot credentials. Smoke steps that need a
  shipped CLI install the exact published version in a clean temp directory
  and call `aerial --version` and `aerial --help` only.

## §5 Stable Release Flow (tag-triggered, recommended path)

1. On `main`: bump `package.json.version` to a clean `X.Y.Z` (e.g. `0.1.0`
   → `0.1.1`; no prerelease or build suffix — see §3), commit, and push.
2. Tag the commit: `git tag v<version> && git push origin v<version>`.
3. The pushed `v*` tag triggers `release.yml`. Three jobs run in this order:

   a. **`test` matrix** (Node 22 × Ubuntu / Windows / macOS), `package &
      secret scan` (Ubuntu) — run in **parallel** as prerequisites
      (`publish` declares `needs: [test, package-checks]`). Both must
      succeed before publish starts. Per-job steps are the same as in §4
      (test matrix runs `npm ci` → syntax check → `npm test` → CLI smoke;
      package-checks runs `npm ci` → `verify-secrets.mjs` →
      `verify-package.mjs`).

   b. **`publish` job** (Ubuntu only, after both prerequisites are green):
      - `actions/checkout@v4` + `setup-node@v4` (Node 22,
        `registry-url: https://registry.npmjs.org`) + `npm ci`.
      - **Read package version** into a step output.
      - **Validate package version is clean stable semver**: refuse any
        version not matching `^[0-9]+\.[0-9]+\.[0-9]+$` (prerelease /
        build-metadata suffixes are not allowed).
      - **Strict tag/version check** (tag-trigger only): `vX.Y.Z` must
        equal `package.json.version`; mismatch fails before publish.
      - **Idempotency precheck** (§7): tri-state — publish vs. skip-but-
        smoke vs. hard fail.
      - **`npm publish --access public --tag latest --provenance`** via
        OIDC trusted publishing (skipped when the precheck output says
        `should_publish=false`).
      - **Post-publish smoke**: install `@jiayunxie/aerial@<version>`
        exactly (never via the floating `@latest` dist-tag) in a clean
        temp directory, with an initial install attempt plus 4 retries
        at 10/20/30/30 s waits between them (~90 s of waiting before
        the final attempt) to absorb registry propagation delay, then
        assert `aerial --version` equals the published version and
        run `aerial --help`.

## §6 Manual Dispatch Release (escape hatch)

- Used only when the tag path fails partway or when a hotfix needs to
  ship without going through tag → push. The tag path is always the
  recommended one.
- **Manual dispatch is not the bootstrap path.** The very first
  `0.1.0` publish — when `@jiayunxie/aerial` is not yet on the registry
  — cannot use this workflow either, because OIDC trusted publishing
  requires the package to already exist. See §2 Phase 1 for the
  owner-local bootstrap publish; `release.yml` (both the tag-trigger
  and manual-dispatch paths) is the standard path only after §2 Phase
  2 is in place.
- `release.yml`'s `workflow_dispatch` trigger requires `github.ref ==
  refs/heads/main` (the job fails fast otherwise).
- The clean-stable-semver guard (§3, §5) also applies to manual dispatch:
  the same "Validate package version is clean stable semver" step rejects
  any `package.json.version` that carries a prerelease or build-metadata
  suffix, before any publish work runs. This keeps the `@latest` channel
  free of malformed versions even when the tag-trigger path is bypassed.
- The publish job runs the **idempotency precheck** described in §7 on
  every trigger, including manual dispatch. So if you push the matching
  `v<version>` tag immediately after a successful manual dispatch (which
  is recommended — see below), the re-triggered workflow detects the
  already-published version, confirms it was published from the same
  commit, and continues straight to post-publish smoke without
  re-publishing. No E409, no destructive overwrite.
- After a successful manual dispatch, manually create and push
  the matching git tag so the tag/registry pair stays consistent:
  `git tag v<version> && git push origin v<version>`.

## §7 CI / Workflow File Structure

- `.github/workflows/ci.yml`: triggered by `pull_request` and `push` to
  `main`. Two jobs (`test`, `package & secret scan`) run in parallel with no
  `needs:` chain. No publish step.
- `.github/workflows/release.yml`: the **sole** publish workflow for
  `@jiayunxie/aerial` because npm only allows one trusted publisher
  binding per package (§2 Phase 2, §13). Triggered by:
    - `push tags: ['v*']` → tag-driven stable release;
    - `workflow_dispatch` → manual stable escape hatch (requires
      `refs/heads/main`).

  The same `test` matrix and `package & secret scan` gates as CI run as
  parallel prerequisites, then a single Ubuntu `publish` job with
  `id-token: write` whose steps are, in order:
    - checkout + setup-node + `npm ci`,
    - **Validate dispatch context** (`refs/heads/main` only; gated on
      `workflow_dispatch`),
    - read package version, validate clean stable semver
      `^[0-9]+\.[0-9]+\.[0-9]+$` (rejects prerelease / build-metadata
      suffixes), strict tag/version match on push, idempotency
      precheck, conditional `npm publish --access public --tag latest
      --provenance`,
    - **Emit publish outcome**: a final bash-only step that normalizes
      the idempotency result into job outputs (`did_publish`,
      `published_version`). Bash conditionals are used here instead of
      GHA `&& ||` expressions because the latter have ambiguous behavior
      around empty strings and skipped-step outputs.
    - **post-publish smoke** (idempotent re-runs still smoke): install
      the exact published version with retry.

  Release concurrency is a single global queue (`group: release`, no
  `${{ github.ref }}` suffix) so manual-dispatch + later tag-push runs
  serialize instead of racing on the same registry slot.
  - **Idempotency precheck** (runs before publish):
    `npm view @jiayunxie/aerial@<package.version> --json`.
    `npm view` is classified into three outcomes: success with JSON →
    compare `gitHead`; failure whose stderr/stdout matches `E404` /
    `not found` / `No match` → treat as not published and proceed to
    publish; any other failure (network, registry 5xx, auth/config
    error) → hard fail and refuse to publish against an unknown
    registry state. When the version is already published, its
    `gitHead` is compared against the publish job's locally-checked-out
    HEAD (`git rev-parse HEAD`, not `$GITHUB_SHA`). If `gitHead` equals
    checked-out HEAD, skip the publish step and still run post-publish
    smoke against the already-published artifact. If `gitHead` differs
    or is missing, fail loudly — a different commit already owns the
    version slot. This lets manual dispatch + later `git push v<version>`
    and rerun-after-smoke-failure both recover without E409.

## §8 Scripts (`scripts/*`)

- **`verify-package.mjs`**: runs `npm pack --dry-run --json`. Checks three
  layers: REQUIRED canary files present, FORBIDDEN categories absent (with
  descriptive errors), and a strict ALLOWLIST catch-all that rejects any
  path not on `{LICENSE, README.md, package.json, docs/usage.md,
  src/**/*.js}` as `UNEXPECTED file in pack`.
- **`verify-secrets.mjs`**: scans every git-tracked file **and** every file
  in `npm pack --dry-run` for 13 secret-shaped patterns (GitHub PATs/OAuth
  tokens, npm tokens, OpenAI/Anthropic keys, long `aerial_*` keys, AWS
  access keys, private-key blocks). Allowlists the public Copilot Device
  Flow client ID `Iv1.b507a08c87ecfe98`. README and docs are intentionally
  in scope: example tokens in documentation must use placeholders like
  `<github-token>`.
- **`check-syntax.js`**: recursively walks `src/` and `scripts/` and runs
  `node --check` on every `.js` / `.mjs` / `.cjs` file. Fast-fail step that
  runs before `npm test` in every CI lane.

## §9 Troubleshooting

- **`npm ERR! 409 Conflict` during publish.** This means the version
  is already on the registry. The idempotency precheck (§7) should
  normally catch this before `npm publish` runs: compare
  `npm view @jiayunxie/aerial@<version> --json` `gitHead` against
  `git rev-parse HEAD`. Equal → already published from this commit;
  rerun and the precheck takes its skip-but-smoke path. Different → a
  different commit owns the version slot; bump `package.json.version`
  before republishing.
- **`ENEEDAUTH` or OIDC failures.** Verify the npm trusted publisher
  configuration: the registered repository (`Xiejiayun/aerial`) and the
  single workflow file name (`release.yml`) must match exactly. npm
  only allows one trusted publisher binding per package, so
  `release.yml` is the only workflow that can publish under OIDC.
  OIDC tokens are short-lived and never logged; nothing needs to be masked.
- **`npm publish` 404 immediately after sigstore provenance signing.**
  One known cause is the publish job running on an npm CLI / Node
  version below the trusted-publishing minimum: provenance signing
  completes (sigstore is independent of the registry auth), then the
  registry PUT is rejected because an older CLI can fail to perform
  the new trusted-publishing exchange and instead fall back to a
  token-style auth attempt with no real token. npm trusted publishing
  requires **npm CLI >= 11.5.1 and Node >= 22.14**. `release.yml`'s
  publish job pins `actions/setup-node@v6` + `node-version: 24` +
  `package-manager-cache: false` and runs an explicit Node-side
  Node/npm version guard before `npm ci` (both floors are checked).
  If this 404 ever resurfaces, the first thing to check is the
  publish job's `node --version` / `npm --version` log lines; if
  either is below its floor, the runner image regressed and the
  version guard must be tightened. If both versions clear the guard,
  the cause is elsewhere (trusted publisher binding, OIDC claim
  match, registry side); diagnose without assuming the runtime is at
  fault.
- **Smoke install `ETARGET` after publish succeeds.** When
  `Post-publish smoke` reports `ETARGET No matching version found for
  @jiayunxie/aerial@<version>` despite the preceding publish step
  finishing green, the cause is npm registry / CDN propagation lag: the
  version is committed but the install-side view has not caught up yet.
  The retry budget is an initial install attempt plus 4 retries at
  10/20/30/30 s waits (~90 s of waiting before the final attempt); if
  the entire window still misses propagation, the publish is not lost:
  the package, gitHead, shasum/integrity, and provenance are all on the
  registry already. Rerun the failed jobs and the publish job will take
  its idempotency skip path (`should_publish=false`) and the smoke will
  re-run against the now-visible artifact. See §10 for the half-success
  recovery walk-through.
- **`setup-node` cache miss / lockfile drift.** `npm ci` is authoritative in
  CI; if it fails, the cause is almost always that a local dependency change
  was committed without committing the updated `package-lock.json`. Fix
  locally with `npm install`, then commit the lockfile.
- **`npm publish --dry-run` warns about login.** Expected when the local
  shell is not logged in; this is fine for dry-run. Actual publishes only
  happen in CI under OIDC.

## §10 Half-Success Recovery (post-publish failures only)

A "half-success" is `npm publish` returning success but a *later* step
(post-publish smoke, output write, etc.) failing and turning the workflow
red. The package is already on the registry; only the verification or
metadata bookkeeping failed.

- **Rerun `release.yml`.** The publish job's idempotency precheck (§7)
  sees the version is already published from this same commit (the
  published `gitHead` matches the publish job's checked-out HEAD, i.e.
  `git rev-parse HEAD`, not `$GITHUB_SHA`), skips `npm publish`, and
  proceeds straight to post-publish smoke. Fix whatever caused smoke to
  fail (registry propagation, environmental flake) and rerun until smoke
  is green. The smoke step itself runs an initial install attempt plus 4
  retries with 10/20/30/30 s waits between them (~90 s of waiting before
  the final attempt) to absorb short propagation delays; if the entire
  window still misses propagation, rerun the failed jobs and the
  idempotency path skips republish and re-runs the smoke against the
  now-visible artifact.
- **Do not** call `npm unpublish` for retry. Unpublish is reserved for the
  three categories in §11.

Failures that happen *before* `npm publish` (test failures, secret-scan
hits, allowlist violations, tag/version mismatch) are ordinary
release-gate failures: fix the cause in code and rerun. They do not need
a recovery procedure beyond §9.

## §11 Unpublish / Deprecate Policy

`npm unpublish` is strictly limited to these scenarios, and only within the
72-hour unpublish window:

1. Secret or credential material leaked into the published tarball.
2. Legal or license violation in the published content.
3. Wrong-content publish — fundamentally the wrong artifact, not a minor bug.

For any other "I want to take back this version" situation:

- Use `npm deprecate @jiayunxie/aerial@<version> "<reason>"` to mark it
  deprecated, and publish a corrective version immediately after.

All unpublish and deprecate operations require explicit approval from the
package owner (see §14). This runbook does not automate them.

## §12 Pre-release Channels

Aerial does not maintain a pre-release channel. Every release is a clean
stable `X.Y.Z` published to `latest` via the §5 flow. The clean-stable-semver
guard (§3) rejects any prerelease-shaped version, so a `-rc.1` or similar
suffix can never reach the `latest` dist-tag.

If a pre-release track is ever needed, prefer publishing under a dedicated
dist-tag (e.g. `next`) rather than dist-tag-promoting a prerelease-shaped
version onto `latest`: surfacing a version string with a prerelease suffix on
`latest` breaks semver expectations for consumers of the stable channel and
confuses tooling that distinguishes prerelease from stable identifiers.

## §13 Security

- No tokens are ever committed to the repo. `.live-aerial/`, `*.tgz`, and
  `node_modules/` stay in `.gitignore`, and `verify-package.mjs`'s pack
  allowlist independently rejects them if anything slips.
- The only standard authenticated npm publish path for automated
  releases is OIDC trusted publishing, and **npm only allows one
  trusted publisher binding per package**. The binding for
  `@jiayunxie/aerial` is `repo: Xiejiayun/aerial` +
  `file: .github/workflows/release.yml`. That is why the publish path
  lives inside `release.yml`; no other workflow file in this repo can publish to npm under OIDC, and
  attempting to register a second binding returns `409 Conflict` on
  the npm side. OIDC's `job_workflow_ref` claim binds to that exact
  workflow file path, so moving any publish step into a reusable
  workflow or a different file would break OIDC. The single documented
  exception to "OIDC only" is the **first stable bootstrap** described
  in §2 Phase 1: because npm requires the package to exist on the
  registry before a trusted publisher can be associated with it, the
  very first `0.1.0` publish is performed locally by the package
  owner after `npm login`. Once the package exists and trusted
  publisher is configured (§2 Phase 2), every later release runs in
  CI under OIDC, and local `npm publish` is not part of the release
  workflow.
- **Trusted publishing runtime requirement.** npm trusted publishing
  requires **npm CLI >= 11.5.1 and Node >= 22.14**
  (<https://docs.npmjs.com/trusted-publishers/>). `release.yml`'s
  publish job intentionally uses `actions/setup-node@v6` with
  `node-version: 24` (and `package-manager-cache: false`) to keep
  comfortable headroom above both floors, and runs an explicit
  Node-side Node/npm version guard before `npm ci` that hard-fails
  when either the observed `node --version` is below `22.14.0` or
  the observed `npm --version` is below `11.5.1`. The `test` and
  `package-checks` jobs intentionally stay on `actions/setup-node@v4`
  + `node-version: "22"` to validate the Node 22 floor declared in
  `package.json` `engines.node` — that is what we ship to users, and
  the publish-job runtime split exists solely so npm's trusted
  publishing exchange has a satisfying CLI. See §9 for the failure
  mode that can arise when the publish-job CLI is too old (a
  confusing `404` from `npm publish` even though sigstore provenance
  signing succeeded); §9 is a documented troubleshooting case, not
  a claim that every publish 404 traces back to runtime.
- No long-lived `NPM_TOKEN` secret is stored in the repo. An
  automation `NPM_TOKEN` may be issued temporarily by the package
  owner as an emergency human-mediated fallback if OIDC breaks after
  Phase 2 is in place, but it must be revoked after use; the runbook
  does not document it as a standard path.
- `verify-secrets.mjs` scans README, `docs/`, and every other tracked file
  in addition to the npm pack manifest. Example tokens in documentation
  must use placeholders like `<github-token>` or `<aerial-api-key>` — never
  real-looking byte sequences. The Copilot Device Flow public client ID
  `Iv1.b507a08c87ecfe98` is allowlisted because it is documented as public.

## §14 Roles & Responsibilities

Role names are generic so the runbook does not need editing when people
rotate. Current mapping is shown in parentheses.

- **Package owner** (currently @jeremy-xie): owns version-number decisions,
  approves stable releases, approves unpublish/deprecate, and owns the npm
  and GitHub account configuration including the trusted publisher binding.
- **Project lead** (currently @DevboxManager): owns architecture review,
  code review on release-pipeline changes, maintenance of this runbook, and
  leads diagnosis when CI/release fails.
- **SDE** (currently @DevboxSDE): implements workflows and scripts, runs
  daily commits and validation, performs first-pass diagnosis on CI/release
  failures, and operates manual dispatch by the procedures in §6.

## §15 Appendix

### A. One-time setup checklist

Two phases, in order. Phase 1 is only required while
`@jiayunxie/aerial` does not yet exist on the registry; once Phase 1
is done, never repeat it.

**Phase 1 — First stable bootstrap** (only when registry slot is empty,
see §2 Phase 1)

- [ ] Package owner `npm login` on a developer machine (`npm whoami`
  returns `jiayunxie`).
- [ ] Local validation: `npm test` 33/33, `node scripts/verify-secrets.mjs`,
  `node scripts/verify-package.mjs`.
- [ ] Owner runs `npm publish --access public --tag latest` against
  `@jiayunxie/aerial@0.1.0` from the developer machine. (No
  `--provenance` here — trusted publisher is not yet configured.)
- [ ] **Do NOT** push `v0.1.0` as a git tag yet. Tagging would re-fire
  `release.yml` under an unconfigured trusted publisher and fail.

**Phase 2 — Trusted publisher + workflow plumbing** (after Phase 1 lands
on the registry)

- [ ] npm trusted publisher configured for `@jiayunxie/aerial` against
  `Xiejiayun/aerial` + the single `release.yml` workflow file (npmjs.com
  UI or `npm trust github @jiayunxie/aerial --repo Xiejiayun/aerial
  --file release.yml`). npm only allows one trusted publisher binding
  per package, which is why the publish path must originate from
  `release.yml`; do not attempt to register a second workflow file.
- [x] README badges added (CI, npm version).

**Phase 3 — End-to-end verification** (recommended)

- [ ] Bump `package.json.version` to `0.1.1` on `main` (clean
  `X.Y.Z`); commit + push.
- [ ] Tag and push: `git tag v0.1.1 && git push origin v0.1.1` →
  watch `release.yml` publish under OIDC with `--provenance`; smoke
  must be green.

### B. Implementation commit sequence (recap)

| Commit | Subject | Status |
|--------|---------|--------|
| 0a | `test: isolate config dirs in server tests` | done |
| 0b | `feat: add aerial --version command` | done |
| α  | `ci: add multi-os CI and release verification scripts` | done |
| β  | `ci: add npm release and nightly workflows` | superseded by correction commit |
| δ  | `docs: clarify first release trusted publisher bootstrap` | done |
| correction | `ci: consolidate stable and nightly publish into release.yml` (delete `nightly.yml`, update runbook + README for npm's one-trusted-publisher-per-package constraint) | done |
| ε  | `ci: remove nightly releases` (drop cron + `mode` input + nightly steps from `release.yml`, delete `publish-nightly.mjs`, strip nightly from runbook) | this commit |

### C. Key environment variables and file locations

- `AERIAL_CONFIG_DIR`: per-test temp directory used by `test/server.test.js`
  for isolation; not a production environment variable.
- Workflow files: `.github/workflows/ci.yml`,
  `.github/workflows/release.yml` (the single publish workflow; see
  §7, §13).
- Release verification scripts: `scripts/check-syntax.js`,
  `scripts/verify-package.mjs`, `scripts/verify-secrets.mjs`.

### D. Future enhancements (not in scope yet)

- Auto-create a GitHub Release with `gh release create v<X> --generate-notes`
  from `release.yml`. Requires widening `contents: write` and defining
  recovery if `gh release create` fails after `npm publish` already
  succeeded. Deferred until the stable cadence is well established.
- Auto-maintain `docs/CHANGELOG.md` from commit history.
- Add a separate dist-tag per release channel (e.g. `next` for
  release-candidate quality) if Aerial grows enough simultaneous tracks
  to need it.

## §16 Service Manual Lifecycle Checklist (manual validation, not CI-gated)

`src/service/index.js` wraps platform service primitives (macOS launchd,
Windows Task Scheduler). Automated tests deliberately stub the
subprocess runner via dependency injection so CI never calls
`launchctl`, `schtasks`, or PowerShell against the runner's real
system — that means the end-to-end behavior must be validated by hand
before any release that touches `src/service/index.js`, `src/shared/log.js`, or the
service docs.

Record the result of this checklist in the release PR description (or
attached note) for the commit that touches service code. A run that
finds an issue blocks release; a run that finds an issue but is
recorded with an explicit, signed-off risk acceptance does not block.

### macOS lifecycle (run on a developer Mac)

- [ ] `aerial service install` (on an idle host with the port absent)
  writes the generated wrapper at
  `<config-dir>/bin/aerial-service.sh` (mode 0755) AND the plist at
  `~/Library/LaunchAgents/com.jiayunxie.aerial.plist` (mode 0644) with
  the generated header (`<!-- Generated by aerial; do not edit -->`).
  The plist does NOT contain `StandardOutPath`/`StandardErrorPath`
  (the wrapper owns stdio redirection).
- [ ] `plutil -lint ~/Library/LaunchAgents/com.jiayunxie.aerial.plist`
  prints `OK`. `sh -n <config-dir>/bin/aerial-service.sh` parses the
  wrapper without executing it.
- [ ] `aerial service install` on an idle host ALSO starts the
  service: `launchctl print gui/$(id -u)/com.jiayunxie.aerial`
  shows the service registered, and `curl -s
  http://127.0.0.1:18181/health` returns
  `{"ok":true,"service":"aerial"}` within a few seconds.
- [ ] `aerial service status --json` shows
  `supported = true`, `service.loaded = true`,
  `service.pid` is a live PID, `health.aerial = true`,
  `health.supervisor = "service-managed"`,
  `summary = "running (service-managed)"`.
- [ ] Kill the live `aerial` process; launchd respawns it within
  `ThrottleInterval` (10s) per the `KeepAlive = { Crashed = true }`
  rule. Confirm the new `pid` differs.
- [ ] `aerial service stop` invokes `launchctl bootout gui/<uid>
  <plist>` (NOT `launchctl kill`). `aerial service status` then
  shows `service.loaded = false`; the process is NOT respawned by
  launchd because `SuccessfulExit = false` only respawns on crash.
- [ ] `aerial service stop` again is idempotent: exit 0 with `note =
  "not running"`.
- [ ] `aerial service restart` while running rotates pids; if a
  rigged stop step fails, `restart` exits 1 with `reason =
  stop_failed` and does NOT attempt the start step.
- [ ] State-machine validation on macOS:
  - With `aerial start` already running in the foreground on the
    configured port, `aerial service install` exits 1 with
    `reason = foreground_running`, `definitionUpdated = true`, and
    the plist + wrapper are still rewritten. `launchctl print` shows
    NO additional bootstrap was performed.
  - With a non-Aerial process bound to the port (e.g. `python3 -m
    http.server 18181`), `aerial service install` exits 1 with
    `reason = port_conflict` and NO file is written.
  - After a successful install, re-running `aerial service install`
    against the running managed service returns `ok = true` with
    `definitionUpdated = true` and `note = "already running
    (service-managed); definition refreshed; run \`aerial service
    restart\` to apply wrapper/env changes"`. Inspect the plist and
    wrapper to confirm they were rewritten; the running pid does NOT
    change (the install command never recycles the running service).
    Run `aerial service restart` next to swap the live process onto
    the regenerated wrapper, then confirm the new pid.
- [ ] `aerial service uninstall` invokes `launchctl bootout` (when
  loaded) and removes both the plist and the wrapper on success.
  Repeated invocation when nothing is installed is idempotent:
  exit 0 with `note = "no service installed"`.
- [ ] If `launchctl bootout` fails while the service is loaded,
  `aerial service uninstall` exits 1 with
  `reason = "bootout_failed"`, the plist and wrapper are PRESERVED
  (not removed), and the message tells the user to retry. Rerunning
  succeeds once the user resolves the underlying launchd error.
- [ ] `aerial teardown` on macOS: when client restore succeeds but a
  rigged `launchctl bootout` makes uninstall return `ok = false`,
  the command exits 1 and prints a retry pointer at
  `aerial service uninstall`. It does NOT silently exit 0.

### Windows lifecycle (run on a developer Windows box)

- [ ] `aerial service install` (on an idle host) writes the wrapper
  at `%APPDATA%\aerial\bin\aerial-service.ps1` AND registers a Task
  Scheduler task named `AerialLocalProxy`.
- [ ] `powershell -NoProfile -Command "Get-Content
  '$env:APPDATA\aerial\bin\aerial-service.ps1' -Raw |
  Out-Null"` exits 0 (PowerShell parses the wrapper without running
  it; no execution involved).
- [ ] `aerial service install` on an idle host ALSO starts the task
  via `schtasks /Run`; `schtasks /Query /TN AerialLocalProxy /FO
  LIST` shows the task as `Running`; `curl
  http://127.0.0.1:18181/health` succeeds within a few seconds.
- [ ] `aerial service status --json` shows
  `supported = true`, `service.loaded = true`,
  `service.status = "Running"`, `health.aerial = true`,
  `health.supervisor = "service-managed"`,
  `summary = "running (service-managed)"`.
- [ ] `aerial service stop` calls `schtasks /End`; `aerial service
  status` reports `service.loaded = false`. Repeating `aerial
  service stop` is idempotent: exit 0 with `note = "not running"`.
- [ ] `aerial service restart` rotates pids when running; with a
  rigged stop failure, restart exits 1 with `reason = stop_failed`
  and does NOT attempt the start step.
- [ ] State-machine validation on Windows:
  - With `aerial start` already running in the foreground, `aerial
    service install` exits 1 with `reason = foreground_running`,
    `definitionUpdated = true`, and the wrapper + task are still
    rewritten. The schtasks call log shows `/Create` was invoked
    but NOT `/Run`.
  - With a non-Aerial process bound to the port, `aerial service
    install` exits 1 with `reason = port_conflict` and NO file is
    written.
  - Re-running install against the running managed service returns
    `ok = true` with `definitionUpdated = true` and `note = "already
    running (service-managed); definition refreshed; run \`aerial
    service restart\` to apply wrapper/env changes"`. The wrapper
    `.ps1` is rewritten and `schtasks /Create /F` is invoked, but
    `/Run` is NOT called and the live task is not recycled. Use
    `aerial service restart` to swap the live process onto the
    regenerated wrapper.
  - If the `schtasks /Create` refresh itself fails, `aerial service
    install` exits 1 with `reason = managed_definition_refresh_failed`,
    a `message` pointing at the schtasks error, and the running task
    is left untouched.
- [ ] `aerial service uninstall` does a best-effort `schtasks /End`
  before `schtasks /Delete /F`, then removes the wrapper `.ps1` from
  `%APPDATA%\aerial\bin\` on success. Repeated invocation when
  nothing is installed is idempotent: exit 0 with `note = "no
  service installed"`.
- [ ] If `schtasks /Delete` fails, `aerial service uninstall` exits
  1 with `reason = "delete_failed"`, the wrapper `.ps1` is
  PRESERVED, and the message tells the user to retry.
- [ ] `aerial teardown` on Windows: when client restore succeeds but
  uninstall returns `ok = false` (e.g. `/Delete` fails), the
  command exits 1 with a retry pointer at
  `aerial service uninstall`.
- [ ] `aerial service install` /TR argument: registered Task action
  embeds the wrapper path inside normal double quotes
  (`powershell.exe ... -File "C:\Users\... Xie\...\\aerial-service.ps1"`) so
  Task Scheduler parses the wrapper path as a single token even
  when it contains spaces or non-ASCII characters. Verify with
  `schtasks /Query /TN AerialLocalProxy /XML` and inspect that
  `Command` is `powershell.exe` and `Arguments` has no literal
  backslash-quote prefix.

### Linux (unsupported-platform friendly fail)

- [ ] `aerial service install|start|stop|restart|uninstall` on Linux
  exits 1 with an `unsupported platform` message that names macOS
  and Windows as the supported platforms and points the user at
  `aerial start` for direct invocation.
- [ ] `aerial service status --json` on Linux exits 1 but still
  emits a schema-valid document with `supported = false`,
  `service.reason = "unsupported_platform"`, and `summary =
  "unsupported"`.

### Log rotation spot-check

- [ ] Foreground `aerial start` (no `AERIAL_LOG_FILE` env) does NOT
  create `<config-dir>/logs/aerial.log`; structured events go to
  stderr only.
- [ ] Service-managed runs: the wrapper sets `AERIAL_LOG_FILE` so
  `<config-dir>/logs/aerial.log` is created. After a non-trivial
  run (or by manually appending bytes), the primary log file does
  not exceed 5 MiB and rotated copies `aerial.log.1` through
  `aerial.log.3` exist as expected.
- [ ] `aerial-stdio.log` is a separate file under the same log
  directory; the wrapper rotates it at startup using the same 5 MiB
  / 3-backup policy. After a fresh service start, an oversized
  pre-existing `aerial-stdio.log` is rotated to `aerial-stdio.log.1`
  before the proxy attaches.
- [ ] `AERIAL_LOG_MAX_BYTES` and `AERIAL_LOG_BACKUPS` overrides are
  baked into the generated wrapper at install time: set them in the
  installer's environment BEFORE running `aerial service install`,
  then verify the wrapper file (`aerial-service.sh` on macOS,
  `aerial-service.ps1` on Windows) hard-codes the new values, the
  running service inherits them (`ps eww` / `Get-Process |
  Format-List Env`), and `aerial service status --json` reports
  `logs.maxFileBytes` / `logs.rotateKeep` matching the override and
  `logs.source = "installed-wrapper"` (the values are parsed back
  from the wrapper on disk, not from the current shell env).
  Changing the env in a different shell after install has NO effect
  on the running service; `aerial service status --json` continues
  to report the wrapper-baked values. To roll new values forward,
  rerun `aerial service install` (regenerates the wrapper without
  recycling the running process), then `aerial service restart`
  (swaps the live process onto the regenerated wrapper). When no
  wrapper exists on disk yet, `logs.source = "next-install-default"`
  and the fields describe what the next install would bake from the
  current shell env.
- [ ] No log file contains a raw GitHub token, raw Aerial API key,
  or full request body. Spot-check with `grep -i 'authorization\|
  token\|api_key\|secret' aerial.log` returning no real values.
