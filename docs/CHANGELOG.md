# Changelog

All notable changes to `@jiayunxie/aerial` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.5]: https://github.com/Xiejiayun/aerial/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/Xiejiayun/aerial/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/Xiejiayun/aerial/compare/v0.1.2...v0.1.3
