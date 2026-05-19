# Aerial Release Runbook

This runbook is the operational reference for releasing `@jiayunxie/aerial` to
npm. It covers stable releases, nightly pre-releases, manual dispatch, and
recovery procedures. It is the authoritative source for who-does-what during
a release.

## §1 Scope & Audience

- Audience: Aerial maintainers — the package owner and the project lead/SDE
  who operate the release pipeline (current mapping in §15).
- Covered: the three release paths — stable (tag-triggered), nightly (cron),
  and manual dispatch (escape hatch).
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
  `Xiejiayun/aerial` and BOTH workflow files
  `.github/workflows/release.yml` and `.github/workflows/nightly.yml`.
  This can be done from the npmjs.com package page → "Trusted
  publishing" UI, or from the CLI:

  ```bash
  npm trust github @jiayunxie/aerial \
    --repo Xiejiayun/aerial --file release.yml
  npm trust github @jiayunxie/aerial \
    --repo Xiejiayun/aerial --file nightly.yml
  ```

  Do **not** configure an `NPM_TOKEN` secret in the repo; OIDC is the
  only standard authenticated publish route for automated releases.
  An automation `NPM_TOKEN` is reserved for emergency human-mediated
  fallback only (§14).
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
  suffix (e.g. `-nightly.YYYYMMDD.<sha7>`, `-rc.1`) and no build metadata
  (e.g. `+build.N`) is permitted on this path. `release.yml` enforces the
  clean-semver shape via its "Validate package version is clean stable
  semver" step before any publish work; if it fails, the publish job hard
  fails. The release tag must equal `v<version>` exactly; `release.yml`
  enforces that equality at the tag-trigger path.
- **Nightly version format.** `<next-patch>-nightly.YYYYMMDD.<sha7>`. The
  `<next-patch>` value is computed by `scripts/publish-nightly.mjs` from
  `npm view @jiayunxie/aerial@latest version` (bump PATCH by one). The local
  `package.json` is **not** permanently bumped — the nightly version is
  written only in-memory inside the publish job and reverted before the job
  exits. Nightlies are published under the `@nightly` dist-tag only and
  never reach the stable `release.yml` path (the clean-semver guard above
  would refuse the prerelease suffix even if a tag were somehow pushed).

## §4 Daily Workflow (PR → main → CI)

- Every pull request triggers `.github/workflows/ci.yml`, which runs two
  jobs **in parallel** (no `needs:` chain between them); both must be
  green before merge:
  - `test` matrix (Node 22 × Ubuntu / Windows / macOS): `npm ci` → syntax
    check (`node scripts/check-syntax.js`) → `npm test` → CLI smoke
    (`node src/cli.js --help` and `node src/cli.js --version`).
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
        build-metadata suffixes are not allowed on the stable path; they
        belong to `@nightly`).
      - **Strict tag/version check** (tag-trigger only): `vX.Y.Z` must
        equal `package.json.version`; mismatch fails before publish.
      - **Idempotency precheck** (§8): tri-state — publish vs. skip-but-
        smoke vs. hard fail.
      - **`npm publish --access public --tag latest --provenance`** via
        OIDC trusted publishing (skipped when the precheck output says
        `should_publish=false`).
      - **Post-publish smoke**: install `@jiayunxie/aerial@<version>`
        exactly (never via the floating `@latest` dist-tag) in a clean
        temp directory, with up to 3 retries at 5/10/20 s backoff to
        absorb registry propagation delay, then assert
        `aerial --version` equals the published version and run
        `aerial --help`.

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
  free of nightly-shaped versions even when the tag-trigger path is
  bypassed.
- The publish job runs the **idempotency precheck** described in §8 on
  every trigger, including manual dispatch. So if you push the matching
  `v<version>` tag immediately after a successful manual dispatch (which
  is recommended — see below), the re-triggered workflow detects the
  already-published version, confirms it was published from the same
  commit, and continues straight to post-publish smoke without
  re-publishing. No E409, no destructive overwrite.
- After a successful manual dispatch, manually create and push the
  matching git tag so the tag/registry pair stays consistent:
  `git tag v<version> && git push origin v<version>`.

## §7 Nightly Release (cron-scheduled)

- `nightly.yml` will run on cron `0 18 * * *` (UTC, i.e. ~02:00 the next day
  in Beijing time) once enabled in commit γ. Until γ, only the
  `workflow_dispatch` trigger is wired; the schedule block is intentionally
  absent.
- **Skip watermark.** `scripts/publish-nightly.mjs` calls
  `npm view @jiayunxie/aerial@nightly --json` and tolerates only two
  known watermark states; anything else is "unknown registry state" and
  the script hard-fails before computing a version, mirroring
  `release.yml`'s idempotency-precheck policy:
    - `npm view` returns an explicit E404 / `No match` / `not found`
      → no `@nightly` tarball published yet; proceed with the first
      nightly publish.
    - `npm view` succeeds AND its `gitHead` field is a non-empty string
      → compare to `git rev-parse HEAD`. If they match, no new commits
      have landed since the last nightly: emit `did_publish=false` and
      exit 0. Otherwise proceed to publish.
    - `npm view` exits 0 with **empty stdout** (not an explicit 404)
      → throw and refuse to publish. Some registry edges return
      status 0 with no manifest body for ambiguous reasons that are
      not real 404s; we deliberately do not collapse this into the
      first-nightly branch.
    - `npm view` succeeds but `gitHead` is missing or not a string →
      throw and refuse to publish. The `@nightly` manifest must be
      fixed manually before re-running.
    - `npm view` fails for any reason other than E404 (network, 5xx,
      auth/config error, JSON parse error) → throw and refuse to
      publish. Re-run after the registry is healthy.
  `@latest` is **not** consulted for the skip decision.
- **Base version.** Separately, `npm view @jiayunxie/aerial@latest version`
  is the source of the next-patch base used to build the nightly version
  string. `@latest` is only ever a base provider, never the skip watermark.
  If `@latest` is not yet on the registry, the script fails fast and
  instructs the operator to publish the first stable manually (see §5/§6)
  before nightly runs are useful.
- **Publish path.** When skip does not apply: temporarily rewrite
  `package.json`'s `version` field in place to the computed nightly
  version, then `npm publish --access public --tag nightly --provenance`.
  The script never invokes `npm version` and therefore never touches
  `package-lock.json`. Emit `did_publish=true` and
  `published_version=<ver>` to `$GITHUB_OUTPUT`. Restore `package.json`
  from the on-disk copy captured at job start, in a `finally` block, so
  the working tree is always clean afterwards.
- **Smoke.** The downstream `smoke` job runs **only** when
  `needs.publish.outputs.did_publish == 'true'`. It installs the exact
  computed version (not `@nightly`) and asserts `aerial --version` matches.

## §8 CI / Workflow File Structure

- `.github/workflows/ci.yml`: triggered by `pull_request` and `push` to
  `main`. Two jobs (`test`, `package & secret scan`) run in parallel with no
  `needs:` chain. No publish step.
- `.github/workflows/release.yml`: triggered by `push tags: ['v*']` or
  `workflow_dispatch`. Same `test` matrix and `package & secret scan`
  gates as CI run as parallel prerequisites, then a single Ubuntu
  `publish` job with `id-token: write` whose steps are, in order:
  checkout + setup-node + `npm ci`, read package version, validate the
  version is clean stable semver `^[0-9]+\.[0-9]+\.[0-9]+$` (rejects
  prerelease / build-metadata suffixes — they belong to `@nightly`),
  validate dispatch context (`refs/heads/main` only) or strict
  tag/version match, idempotency precheck, conditional
  `npm publish --tag latest --provenance`, post-publish smoke with
  retry. Release concurrency is a single global queue (`group: release`,
  no `${{ github.ref }}` suffix) so manual-dispatch + later tag-push
  runs serialize instead of racing on the same version slot.
  - **Idempotency precheck** (runs on every trigger before publish):
    `npm view @jiayunxie/aerial@<package.version> --json`. `npm view` is
    classified into three outcomes: success with JSON → compare `gitHead`;
    failure whose stderr/stdout matches `E404` / `not found` / `No match`
    → treat as not published and proceed to publish; any other failure
    (network, registry 5xx, auth/config error) → hard fail and refuse
    to publish against an unknown registry state. When the version is
    already published, its `gitHead` is compared against the publish
    job's locally-checked-out HEAD (`git rev-parse HEAD`, not
    `$GITHUB_SHA`). If `gitHead` equals checked-out HEAD, skip the
    publish step and still run post-publish smoke against the
    already-published artifact. If `gitHead` differs or is missing,
    fail loudly — a different commit already owns the version slot.
    This lets manual dispatch + later `git push v<version>` and
    rerun-after-smoke-failure both recover without E409.
- `.github/workflows/nightly.yml`: triggered by `workflow_dispatch` only (γ
  will add cron). Same gates, then a publish job invokes
  `scripts/publish-nightly.mjs` and emits `did_publish` /
  `published_version` outputs. A conditional `smoke` job consumes those
  outputs.

## §9 Scripts (`scripts/*`)

- **`publish-nightly.mjs`**: compute base from `@latest` (fail fast if
  `@latest` is unpublished), compute version string, compare
  `@nightly.gitHead` for skip with strict watermark classification (only
  E404 or a successful view with a non-empty string `gitHead` are
  accepted — everything else throws and refuses to publish, see §7),
  rewrite `package.json`'s `version` field in place (does **not** invoke
  `npm version`, so `package-lock.json` is
  never touched), publish with `--tag nightly --provenance`, E409
  idempotency reconciliation (retry `npm view @<wanted>` with 2/5/10 s
  backoff and accept if the published `gitHead` equals local HEAD),
  restore `package.json` from the captured original bytes in a `finally`
  block, emit GitHub outputs, log `git status --short` for trace.
  **Never** runs destructive git operations (e.g. `git checkout --`).
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

## §10 Troubleshooting

- **`npm ERR! 409 Conflict` during nightly publish.** Compare
  `npm view @jiayunxie/aerial@<wanted-version> --json` `gitHead` against
  `git rev-parse HEAD`. Equal → previous attempt half-succeeded, treat the
  current run as idempotent success (the script already does this with 3
  retries at 2/5/10 s backoff). Different → a different commit owns the
  version slot, which should not happen with our SHA-embedded version
  scheme; investigate before rerunning.
- **`ENEEDAUTH` or OIDC failures.** Verify the npm trusted publisher
  configuration: the registered repository (`Xiejiayun/aerial`) and the
  workflow file names (`release.yml`, `nightly.yml`) must match exactly.
  OIDC tokens are short-lived and never logged; nothing needs to be masked.
- **`setup-node` cache miss / lockfile drift.** `npm ci` is authoritative in
  CI; if it fails, the cause is almost always that a local dependency change
  was committed without committing the updated `package-lock.json`. Fix
  locally with `npm install`, then commit the lockfile.
- **`npm publish --dry-run` warns about login.** Expected when the local
  shell is not logged in; this is fine for dry-run. Actual publishes only
  happen in CI under OIDC.

## §11 Half-Success Recovery (post-publish failures only)

A "half-success" is `npm publish` returning success but a *later* step
(post-publish smoke, output write, etc.) failing and turning the workflow
red. The package is already on the registry; only the verification or
metadata bookkeeping failed.

- **Nightly half-success.** Rerun the workflow. `publish-nightly.mjs`'s
  E409 idempotency path compares the published `gitHead` to local HEAD and
  treats a re-attempted publish of the same content from the same commit as
  success. The smoke job then runs against the same exact version. Note
  that the nightly skip-watermark step itself refuses to run against an
  unknown registry state (non-E404 `npm view` failure, JSON parse error,
  a successful view with a missing/non-string `gitHead`, or `npm view`
  exit 0 with empty stdout) — those outcomes throw before any publish
  work and `did_publish=false` is written to `$GITHUB_OUTPUT`; the next
  scheduled or dispatched nightly retries against a presumably healthy
  registry. They are not "half-successes" because no publish happened.
- **Stable half-success.** Rerun `release.yml`. The publish job's
  idempotency precheck (§8) sees the version is already published from
  this same commit (the published `gitHead` matches the publish job's
  checked-out HEAD, i.e. `git rev-parse HEAD`, not `$GITHUB_SHA`), skips
  `npm publish`, and proceeds straight to post-publish smoke. Fix
  whatever caused smoke to fail (registry propagation, environmental
  flake) and rerun until smoke is green. The smoke step itself retries
  the install up to 3 times with 5/10/20 s backoff to absorb short
  propagation delays.
- **Do not** call `npm unpublish` for retry. Unpublish is reserved for the
  three categories in §12.

Failures that happen *before* `npm publish` (test failures, secret-scan
hits, allowlist violations, tag/version mismatch, missing `@latest` when
running nightly, nightly skip-watermark in unknown state) are ordinary
release-gate failures: fix the cause in code or in the registry (e.g.
publish the first stable manually, or wait for the registry to be healthy
and re-run nightly) and rerun. They do not need a recovery procedure
beyond §10.

## §12 Unpublish / Deprecate Policy

`npm unpublish` is strictly limited to these scenarios, and only within the
72-hour unpublish window:

1. Secret or credential material leaked into the published tarball.
2. Legal or license violation in the published content.
3. Wrong-content publish — fundamentally the wrong artifact, not a minor bug.

For any other "I want to take back this version" situation:

- Use `npm deprecate @jiayunxie/aerial@<version> "<reason>"` to mark it
  deprecated, and publish a corrective version immediately after.

All unpublish and deprecate operations require explicit approval from the
package owner (see §15). This runbook does not automate them.

## §13 Pre-release → Stable Promotion

When a nightly looks good and we want to ship it as the next stable, always
use **Method Y**:

- **Method Y (the only approved path).** Check out the same commit, set
  `package.json.version` to a clean stable value (e.g. `0.1.1`), and follow
  the §5 stable release flow. This produces a clean
  `@jiayunxie/aerial@0.1.1` on `latest`.

- **Method X = dist-tag promote prerelease — not used.** It would be
  technically possible to run
  `npm dist-tag add @jiayunxie/aerial@<X>.<Y>.<Z>-nightly.YYYYMMDD.<sha7> latest`,
  but we reject this. Users on `latest` would then see a version string with
  a `-nightly.YYYYMMDD.<sha7>` suffix, which breaks semver expectations for
  consumers of the stable channel and confuses any tooling that distinguishes
  prerelease from stable identifiers. Method X is documented here only so
  future readers understand why we explicitly do not take that path.

## §14 Security

- No tokens are ever committed to the repo. `.live-aerial/`, `*.tgz`, and
  `node_modules/` stay in `.gitignore`, and `verify-package.mjs`'s pack
  allowlist independently rejects them if anything slips.
- The only standard authenticated npm publish path for automated
  releases is OIDC trusted publishing. The single documented exception
  is the **first stable bootstrap** described in §2 Phase 1: because
  npm requires the package to exist on the registry before a trusted
  publisher can be associated with it, the very first `0.1.0` publish
  is performed locally by the package owner after `npm login`. Once
  the package exists and trusted publisher is configured (§2 Phase 2),
  every later release runs in CI under OIDC, and local `npm publish`
  is not part of the release workflow.
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

## §15 Roles & Responsibilities

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

## §16 Appendix

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
  `Xiejiayun/aerial` + `release.yml` + `nightly.yml` (npmjs.com UI or
  `npm trust github @jiayunxie/aerial --repo Xiejiayun/aerial
  --file release.yml` / `--file nightly.yml`).
- [ ] README badges added (CI, nightly, npm version).
- [ ] Cron time in `nightly.yml` confirmed (UTC 18:00 = Beijing 02:00
  next day). Enabled only in commit γ.

**Phase 3 — End-to-end verification** (recommended)

- [ ] Bump `package.json.version` to `0.1.1` on `main` (clean
  `X.Y.Z`); commit + push.
- [ ] Tag and push: `git tag v0.1.1 && git push origin v0.1.1` →
  watch `release.yml` publish under OIDC with `--provenance`; smoke
  must be green.
- [ ] Manually dispatch `nightly.yml` once (still no cron) to verify
  the end-to-end nightly publish + smoke against the freshly
  bootstrapped `@latest`.
- [ ] Only after that manual nightly is green, ship commit γ to
  enable the cron schedule (`0 18 * * *`).

### B. Implementation commit sequence (recap)

| Commit | Subject | Status |
|--------|---------|--------|
| 0a | `test: isolate config dirs in server tests` | done |
| 0b | `feat: add aerial --version command` | done |
| α  | `ci: add multi-os CI and release verification scripts` | done |
| β  | `ci: add npm release and nightly workflows` | this commit |
| γ  | `ci: enable scheduled nightly releases` | optional, only after a manual nightly succeeds |

### C. Key environment variables and file locations

- `AERIAL_CONFIG_DIR`: per-test temp directory used by `test/server.test.js`
  for isolation; not a production environment variable.
- `scripts/publish-nightly.mjs` GitHub outputs: `did_publish` (`"true"` or
  `"false"`), `published_version` (semver string or empty).
- Workflow files: `.github/workflows/ci.yml`,
  `.github/workflows/release.yml`, `.github/workflows/nightly.yml`.
- Release verification scripts: `scripts/check-syntax.js`,
  `scripts/verify-package.mjs`, `scripts/verify-secrets.mjs`,
  `scripts/publish-nightly.mjs`.

### D. Future enhancements (not in scope yet)

- Auto-create a GitHub Release with `gh release create v<X> --generate-notes`
  from `release.yml`. Requires widening `contents: write` and defining
  recovery if `gh release create` fails after `npm publish` already
  succeeded. Deferred until the stable cadence is well established.
- Auto-maintain `docs/CHANGELOG.md` from commit history.
- Move from `npm publish --tag nightly` to a separate dist-tag per release
  channel (e.g. `next` for release-candidate quality) if Aerial grows
  enough simultaneous tracks to need it.
