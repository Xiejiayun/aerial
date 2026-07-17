---
name: aerial-release
description: Audit, upgrade, publish, recover, and verify stable Aerial releases. Use when Codex needs to review Aerial compatibility with GitHub Copilot, OpenAI Codex, or Claude Code; update client/API behavior; prepare an npm version under Aerial's 0.A.B policy; run the protected-main PR and tag workflow; recover an interrupted npm publish safely; create the matching GitHub Release; or validate npm, provenance, tag, and main state after release.
---

# Aerial Release

Release Aerial through evidence-based compatibility changes, atomic commits, protected-branch checks, an immutable tag, and verified npm/GitHub artifacts.

## Preserve the release invariants

- Treat existing tracked and untracked work as user-owned. Never stage, delete, or rewrite unrelated files.
- Inspect the active GitHub CLI account, SSH identity, remotes, branch protection, and available authenticated browser session separately. Do not assume they represent the same account.
- Make each upgrade point a focused tested commit and push it before starting the next point.
- Merge through a protected `main` PR and required checks. Never publish an unmerged branch commit or bypass failed checks.
- Never reuse an npm version, move a published tag, or use `npm unpublish` as retry machinery.
- Query the authoritative registry explicitly with `--registry=https://registry.npmjs.org`; local or enterprise npm mirrors may lag.
- Keep secrets out of commands, logs, commits, release notes, and browser forms.

## 1. Establish repository and release state

1. Read repository instructions and `docs/release-runbook.md`.
2. Inspect `git status --short --branch`, remotes, recent commits, tags, package manifests, workflows, and existing release scripts.
3. Fetch `origin/main` without discarding local work. Start a `codex/` branch from the current protected-main commit.
4. Inspect npm versions, dist-tags, target metadata, GitHub tags/releases, and recent CI/release runs.
5. Record unrelated worktree files and exclude them explicitly from every commit.

For registry reads, use the official registry:

```bash
npm view @jiayunxie/aerial versions --json --registry=https://registry.npmjs.org
npm view @jiayunxie/aerial@<version> --json --registry=https://registry.npmjs.org
```

## 2. Audit client and API compatibility

Use current official documentation and installed client behavior, then corroborate undocumented Copilot behavior with safe live probes when credentials and user scope permit.

- For Codex/OpenAI, use the official OpenAI documentation workflow. Verify the installed Codex version, custom-provider config, wire API, auth mechanism, and supported reasoning values.
- For Claude Code, use Anthropic's official settings and CLI references plus the installed package version. Verify native settings and request schemas rather than relying on old aliases.
- For Copilot, prefer GitHub documentation and the live model catalog. Treat subscription inference endpoints as undocumented and catalog fields as optional.
- Verify routes, supported efforts, headers, cache fields, and fallback behavior. Never hard-code a model ID merely because it appeared in one probe.
- Keep Aerial's Codex provider on HTTP Responses unless Aerial itself exposes a client WebSocket endpoint. Upstream WebSocket support alone does not justify `supports_websockets = true` in Codex.
- Preserve client-supplied Anthropic headers and use conservative behavior when catalog refresh fails.

Change code only when current evidence shows a compatibility or reliability gap. Document why stable behavior is intentionally unchanged.

## 3. Design, implement, and verify each upgrade

1. Write or update a short design when behavior, release policy, or recovery semantics change.
2. Run the baseline test, syntax, package, secret, and dependency gates before editing.
3. Add focused regression tests before or with each behavioral fix.
4. Keep catalog-based decisions model-aware and deterministic. Prefer the nearest supported lower capability; use a documented conservative fallback when metadata is absent.
5. Run focused tests, then the full relevant gate.
6. Review `git diff --check` and the staged file list.
7. Commit and push only that upgrade point.

Run the complete gate before the release PR and tag:

```bash
npm test
node scripts/check-syntax.js
node scripts/verify-package.mjs
node scripts/verify-secrets.mjs
npm audit --audit-level=low
npm pack --dry-run --json
node src/cli/index.js --help
node src/cli/index.js --version
```

## 4. Prepare the stable version

Aerial uses `0.A.B`, where `B` is 1 through 9. After `0.A.9`, increment `A` and reset `B` to 1. Require the user-specified target when one exists.

- Update `package.json`, the top-level `package-lock.json.version`, and `package-lock.json.packages[""].version` together.
- Add dated changelog/release notes that describe user-visible compatibility and reliability changes.
- Do not reuse a removed npm version. An existing release tag is sufficient evidence that the version is spent even when the registry returns E404.
- Commit and push the version/release-notes change separately.

## 5. Merge and run the local preflight

1. Open a PR to `main` using an authenticated repository-owner surface.
2. Wait for every required platform, Node, package, and secret check. Fix failures on the branch and repeat.
3. Merge only after all checks pass.
4. Synchronize local `main` to `origin/main` with a fast-forward.
5. Run the repository's read-only preflight from clean `main` before creating a tag:

```bash
npm run release:preflight -- --expected-version <version>
```

The preflight must confirm manifest agreement, `0.A.B`, monotonic registry history, target E404, clean tracked files, `HEAD == main == origin/main`, and an absent release tag.

## 6. Tag, publish, and recover safely

Create and push one annotated tag only after preflight succeeds:

```bash
git tag -a v<version> -m "Aerial v<version>"
git push origin v<version>
```

Monitor the Release workflow through tests, package checks, deterministic workflow preflight, OIDC publish with provenance, and exact-version install smoke.

Apply these recovery rules:

| State | Action |
|---|---|
| Target lookup returns explicit E404 before tagging | Continue only if every other new-release check passes. |
| Registry returns empty/invalid JSON, auth/network/5xx, or any non-E404 failure | Stop; registry state is unknown. |
| Target already exists in `new-release` mode | Stop and choose a new version. |
| Workflow target exists with matching `gitHead` | Skip publish and rerun verification; this is the idempotent recovery path. |
| Workflow target has missing or different `gitHead` | Stop; never overwrite or republish the slot. |
| `npm publish` succeeds but install smoke reports ETARGET | Verify official-registry metadata and provenance, then rerun failed jobs against the same commit/tag. |
| Tag exists or points elsewhere | Stop; never move it. |

## 7. Verify the public release

Require all of the following before declaring the release complete:

- `main`, `origin/main`, and the peeled `v<version>` tag resolve to the intended release commit.
- The Release workflow is green, including its idempotent recovery attempt if needed.
- Official npm metadata reports the exact version, `latest`, matching `gitHead`, integrity/shasum, and SLSA provenance.
- A clean temporary install from `https://registry.npmjs.org` reports the exact CLI version and renders help.
- A non-draft, non-prerelease GitHub Release exists for the immutable tag and is marked Latest.
- The local worktree contains no unexpected tracked changes.

Create the GitHub Release from the changelog only after npm publication is verified. If the release exposed new repeatable safeguards, update this Skill and the runbook in focused post-release commits, then merge them through a separate protected-main PR.
