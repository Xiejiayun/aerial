# Aerial

[![CI](https://github.com/Xiejiayun/aerial/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Xiejiayun/aerial/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@jiayunxie/aerial.svg)](https://www.npmjs.com/package/@jiayunxie/aerial)

Aerial lets Codex CLI, Claude Code, and image API clients use your own GitHub Copilot subscription through a local proxy on your machine.

It runs locally on `127.0.0.1:18181`. Your GitHub token and Aerial key stay on your machine. It is built for personal local use, not for public hosting or account sharing.

## Install

Requirements:

- Node.js 20.18.1+
- A GitHub account with an active Copilot subscription
- Codex CLI and/or Claude Code installed

```bash
npm install -g @jiayunxie/aerial
```

## Update

```bash
aerial update --check   # check for a newer release
aerial update           # install the latest stable release
```

`aerial upgrade` is an alias for `aerial update`. For older versions without this command, run `npm install -g @jiayunxie/aerial@latest` once to upgrade.

Updates use your configured npm registry and proxy settings. A registry mirror may serve an older version than the official npm site.

After updating, run `aerial service install` and `aerial service restart` to refresh an existing background service and load the new code. Restart foreground processes or services you manage yourself as well.

## Quick Start

1. Sign in to GitHub:

```bash
aerial login
```

2. Start Aerial in the background on macOS or Windows:

```bash
aerial service install
```

Windows registration uses your current user with limited privileges. On Linux, run `aerial start` in a separate terminal and keep it open.

3. Configure the client you use:

```bash
# Codex CLI
aerial setup codex

# Claude Code 2.1.251+
aerial setup claude
```

Setup shows compatible models and effort choices, checks the local proxy and key helper, then sends one brief inference request to the selected upstream model. This request uses your Copilot allowance. Only after verification succeeds does it back up and replace the client configuration. A failure leaves that configuration unchanged.

For deliberate offline configuration, use `aerial setup codex --model <id> --configure-only` (or `claude`). It saves settings without checking availability and clearly reports that they are unverified. Add `--verbose` for configuration paths, backup and helper details.

4. Check everything from one place:

```bash
aerial status
```

If Aerial prints a hint, follow it before expecting the background service to work after reboot.

Restart Codex CLI or Claude Code if either one was already open while you ran setup.

## What Setup Changes

`aerial setup codex` updates `~/.codex/config.toml`.

- It points Codex at `http://127.0.0.1:18181/v1`.
- It uses Codex's command-backed auth helper so Codex can read the local Aerial key automatically.
- It creates a timestamped backup before writing.

`aerial setup claude` updates `~/.claude/settings.json`.

- It points Claude Code at `http://127.0.0.1:18181`.
- It configures an API key helper so Claude Code can read the local Aerial key automatically.
- It creates a timestamped backup before writing.

You normally do not need to create, copy, or export an API key yourself.

## Choosing A Model

The easiest path is to let setup show the compatible models and ask for reasoning effort:

```bash
aerial setup codex
aerial setup claude
```

To skip the prompts:

```bash
aerial setup codex --model <responses-model-id> --effort <minimal|low|medium|high|xhigh|max|ultra>
aerial setup claude --model <messages-model-id> --effort <low|medium|high|xhigh|max|ultracode>
```

Codex and Claude effort choices follow the selected model's capabilities, preferring the nearest supported lower level. Codex `minimal` maps to Copilot `none`; `none` is also accepted as an input alias. Claude setup uses a native model identity mapped to the Copilot ID and saves per-model effort (`low`, `medium`, `high`, or `xhigh`; Claude Code 2.1.251+). `max` is session-only: setup reports the requested-to-saved change, while `claude --effort max` still works when the upstream model supports it. The legacy `ultracode` setup input resolves to an effort up to `xhigh`; it does not enable Claude's workflow mode.

To inspect the full model matrix:

```bash
aerial probe
```

## Generate And Edit Images

Aerial exposes authenticated `POST /v1/images/generations` and `POST /v1/images/edits` on the same local service. Use `aerial probe` to find models advertising `image_generation` or `image_edit`, then send the selected model ID and image options through an Images API client with base URL `http://127.0.0.1:18181/v1` and the key returned by `aerial key print`.

Generation JSON, edit uploads (including multipart files and masks), and upstream JSON/SSE responses pass through unchanged. Sizes such as `3840x2160` work when the selected upstream model supports them. Each request uses your Copilot allowance; `aerial probe --live` checks conversation routes only and never generates images.

Image model access depends on your account and the live Copilot catalog. No separate OpenAI key is required. Image-only models cannot be selected as the Codex or Claude Code conversation model; automatic image tools need a separate client integration.

See [image API examples](docs/usage.md#81-generate-and-edit-images) for generation, editing, downloads, limits, and error handling. Restart an existing Aerial service after upgrading to load the new routes.

## Upgrading from outbound proxy mode

Aerial no longer discovers or manages outbound proxies. If you enabled one in an earlier version, GitHub/Copilot requests are blocked rather than silently switching routes. To accept direct access, unset `AERIAL_UPSTREAM_PROXY` and remove `upstreamProxyMode`, `upstreamProxyEndpoint`, and `upstreamProxySource` from the Aerial `config.json` named in the error. Keep your other settings. Restart the service after upgrading. If direct access is not suitable, stay on the previous release.

## Daily Commands

```bash
aerial status           # setup, login, service, and health summary
aerial update           # check for and install the latest stable release
aerial service install  # install and start the background service
aerial doctor           # local diagnostics
aerial teardown          # restore client configs and uninstall the service
```

`aerial start` is for foreground debugging in the current terminal. Most users should use `aerial service install`.

Advanced service lifecycle commands are documented in `docs/usage.md`.

## Troubleshooting

- `Missing GitHub token`: run `aerial login`.
- `Invalid or missing Aerial API key`: rerun `aerial setup codex` or `aerial setup claude`, then restart the client.
- No models listed during setup: run `aerial login` first, then retry setup.
- Claude models or the `messages` route are missing: check your subscription, network access, and `aerial probe`.
- Port conflict on `18181`: run `aerial status` to see whether another process is using the port.
- Need to undo setup: run `aerial teardown`, or restore one client with `aerial setup restore <codex|claude> --latest`.

## Notes

- macOS background service support uses a user LaunchAgent.
- Windows background service support uses a user Task Scheduler task and runs without a terminal window. Failed runs restart automatically; the task has no time limit or battery restriction. Run `aerial service install` from your normal terminal to register it. After upgrading an older installation, run `aerial service install` and `aerial service restart` to apply the launcher and recovery settings.
- Linux service management is not built in yet; run `aerial start` or use your own init system.
- Copilot inference routes are an observed compatibility target and may change upstream.

More details: `docs/usage.md`.
