# Changelog

All notable changes to `@jiayunxie/aerial` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.8] - 2026-05-22

### Fixed

- Claude Opus 4.7 effort routing now resolves compatible models from the live `/v1/models` catalog instead of hardcoding `claude-opus-4.7-1m-internal`. Aerial only rewrites the model when a same-family `/v1/messages` model advertises adaptive thinking and the requested reasoning effort; otherwise it leaves the model ID unchanged and lets Copilot return the authoritative upstream error.
- Legacy Claude Opus 4.7 aliases such as `claude-opus-4.7-high` and hyphenated `claude-opus-4-7` are now mapped through the same catalog-based resolver, so future Copilot model changes do not require another hardcoded suffix table.

## [0.1.7] - 2026-05-22

### Fixed

- Claude Code requests that still send Anthropic's legacy `thinking: { type: "enabled" }` schema are now translated to `thinking: { type: "adaptive" }` with `output_config.effort`, preventing the Claude Opus 4.7 `"thinking.type.enabled" is not supported` error.
- Claude Opus 4.7 effort routing now uses the currently available `claude-opus-4.7-1m-internal` model for non-medium effort requests, and normalizes older `claude-opus-4.7-high` / `claude-opus-4.7-xhigh` IDs to that model while preserving `output_config.effort`.
- `aerial service install` and `aerial service start` now poll `/health` after the platform service manager reports success. If the background process does not become a healthy Aerial proxy, the command returns a diagnostic `health_check_failed` result instead of reporting a false success.
- Service install/start failure output now includes log paths, wrapper node path, health probe summary, and a next diagnostic command (`aerial service status --json`) without exposing token or key values.
- The service install GitHub-token warning now distinguishes an env-only `AERIAL_GITHUB_TOKEN`, clarifying that background services do not inherit shell-scoped environment variables and that `aerial login` persists a service-readable token.

## [0.1.6] - 2026-05-22

### Added

- `aerial setup codex` and `aerial setup claude` now discover the live Copilot model list when `--model` is omitted, show client-compatible choices, and select from the appropriate route (`responses` for Codex, `messages` for Claude Code).
- Added top-level `aerial status` / `aerial status --json` as a single daily summary for setup, auth, service, and health.
- `GET /` on the local proxy now returns an unauthenticated friendly status payload pointing at `/health` and `aerial status`, instead of the `authentication_error` users used to see when opening `http://127.0.0.1:18181/` in a browser. POST inference routes still require the Aerial API key.
- `GET /v1/models` is now reachable without the local Aerial API key so users can inspect the model catalog from a browser or unauthenticated `curl`. POST inference routes (`/v1/responses`, `/v1/messages`, `/v1/messages/count_tokens`, `/v1/chat/completions`) still require the key.
- Setup model selection picks a route-aware recommended default by ranking `gpt-N.M` versions descending and preferring stable IDs (no `-preview`, `-codex`, `-mini`, `-nano`, or `-turbo` suffix). When no stable model is available the highest-versioned suffix variant is offered with `source: "recommended_fallback"`. `--model <id>` always overrides the recommendation.
- `aerial login` now reuses an existing GitHub token instead of always launching the device flow. If a non-empty token is already present (file or `AERIAL_GITHUB_TOKEN` env), `aerial login` exits 0 with a hint that the login is not verified and pointing at `--force` to sign in again. `aerial login --force` re-runs the device flow, unless `AERIAL_GITHUB_TOKEN` is set, in which case the env value would shadow any new file token and the command exits 1 asking the user to unset it first.
- `GET /v1/models` without a GitHub token now returns HTTP 401 with `error.aerial.status = "login_required"` from the server route layer, before contacting Copilot. When a GitHub token is present but Copilot upstream rejects it, the route returns the upstream 401/403 with `error.aerial.status = "upstream_auth_failed"` and `upstream_status`, and a message suggesting `aerial login --force`. Neither response carries `WWW-Authenticate` nor open-CORS headers, and no token/key/path is leaked.
- `aerial setup status` / `aerial status` JSON now exposes `auth.github_token.source` (`"missing" | "file" | "env"`) so consumers can distinguish a persisted file login from a process-scoped `AERIAL_GITHUB_TOKEN`. The legacy `auth.github_token.exists` field is now a derived `source !== "missing"`.
- `aerial status --json` adds a top-level `hints: []` array for non-blocking advisories. `nextSteps` remains reserved for actions that must be taken to reach `ok: true`. An env-only GitHub login surfaces a hint that `AERIAL_GITHUB_TOKEN` is process-scoped and the background service may not see it.

### Changed

- Rewrote the npm README around the shortest working path: `aerial login`, client-specific setup, `aerial service install`, and `aerial status`.
- Hid local key management commands from the normal help/readme path; they remain available for internal helpers and advanced troubleshooting.
- Claude Code setup now writes an absolute API-key helper command, avoiding reliance on `aerial` being visible on `PATH` when Claude Code starts.
- `aerial status` `ok` now also requires at least one client (Codex or Claude) to route through Aerial. A healthy local service with no client configured no longer reports `ok: true`; the next step is `aerial setup codex` or `aerial setup claude`. When the local Aerial API key is missing, the next step points at `aerial setup ...` (which re-creates the key), not the hidden `key generate` command.
- `aerial status` text output now shows `github login: present (file)`, `present (env)`, or `missing` instead of a boolean, and adds a `hints:` section below `next:` when there are non-blocking advisories.
- `readGitHubToken()` now trims `AERIAL_GITHUB_TOKEN` (matching the existing file-token trim). A whitespace-only env value no longer shadows a persisted file token, fixing a class of "I ran aerial login but the server still says missing GitHub token" loops.

## [0.1.5] - 2026-05-22

### Changed

- Removed `aerial setup all` as a client setup shortcut. Users now configure Codex and Claude Code explicitly with `aerial setup codex` and `aerial setup claude`, which avoids implying that one model ID is valid for both clients.
- Updated README and usage docs so the happy path no longer asks users to provide `--model` during first run. Explicit model pinning remains available through each client-specific setup command.

## [0.1.4] - 2026-05-22

### Fixed

- Codex setup no longer depends on users exporting `AERIAL_API_KEY`. `aerial setup codex` now writes Codex's command-backed provider auth block, which calls the installed Aerial CLI to print the local key on demand. This keeps the key in Aerial's private storage and avoids the macOS `Missing environment variable: AERIAL_API_KEY` failure mode after setup.
- Setup output and docs now describe automatic local-key wiring instead of asking users to generate, copy, or persist an environment variable.

## [0.1.3] - 2026-05-21

### Added

- Service MVP for managing Aerial as a background service.
  - macOS: launchd LaunchAgent at `~/Library/LaunchAgents/com.jiayunxie.aerial.plist` driven by `aerial service install/start/stop/restart/uninstall/status`.
  - Windows: Task Scheduler integration with the `AerialLocalProxy` task and the `aerial service` subcommand mirror.
  - 5-branch install state machine: `port_conflict`, `foreground_aerial`, `managed_already`, `managed_running`, `absent`.
  - `managed_running` re-install regenerates the plist / wrapper / schtasks definition without recycling the running service and reports `definitionUpdated: true`.
- `aerial setup status` JSON report covering Codex / Claude config state and Aerial API key presence.
- `aerial setup restore <codex|claude|all> --latest` to restore the most recent backup with parse validation and atomic writes; a `.aerial-pre-restore-<timestamp>` snapshot is preserved alongside.
- `aerial disable` end-to-end rollback: restores client configs from their latest aerial backups and uninstalls the bundled service in one step, surfacing `FAILED(reason)` from either side.
- Opt-in size-bounded file logger via `AERIAL_LOG_FILE`, with automatic rotation gated by `AERIAL_LOG_MAX_BYTES` and `AERIAL_LOG_BACKUPS`. Service wrappers bake these rotation env vars at install time.
- `aerial.service-status.v1` status schema: `service`, `health`, `logs`, and `auth` blocks. The `logs.source` field is `installed-wrapper` when a parseable wrapper is on disk, otherwise `next-install-default`.

### Fixed

- Windows `service install` under the `foreground_aerial` branch now gates `definitionUpdated: true` on a successful `schtasks /Create`. When the create call fails (for example, corporate UAC-filtered medium-IL accounts denying `/SC ONLOGON /RL LIMITED`), the install returns `ok: false, reason: "foreground_definition_refresh_failed", definitionUpdated: false` and surfaces the underlying `schtasks` stderr instead of misleadingly reporting that the definition was updated. This mirrors the existing `managed_running` failure gate.
- `restoreAllClients` regression test was non-deterministic on macOS because the EXDEV-rename mock only matched the logical destination path while `restoreClient` writes via `fs.realpathSync(destination)` (which expands `/var/folders/...` to `/private/var/folders/...` on darwin). The test now matches both the logical and realpath-resolved destinations so macOS CI is deterministic.

### Notes

- Linux service management remains intentionally unsupported (`reason: "unsupported_platform"`). Run `aerial start` directly or wrap it in your own init system.
- The Windows real-OS service install end-to-end lifecycle requires non-medium-IL or otherwise unfiltered UAC on corporate machines; CI and the in-tree test runner exercise the same code paths against dry-run fakes via `AERIAL_SERVICE_DRYRUN`, `AERIAL_SERVICE_DRYRUN_INSTALLED`, and `AERIAL_SERVICE_DRYRUN_FAIL`.
- macOS `launchctl bootstrap` / `bootout` is exercised in tests and dry-run runners but a manual real-OS lifecycle on a developer Mac is still recommended; see `docs/release-runbook.md` §17.

[0.1.8]: https://github.com/Xiejiayun/aerial/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/Xiejiayun/aerial/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/Xiejiayun/aerial/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/Xiejiayun/aerial/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/Xiejiayun/aerial/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/Xiejiayun/aerial/compare/v0.1.2...v0.1.3
