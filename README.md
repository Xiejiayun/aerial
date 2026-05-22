# Aerial

[![CI](https://github.com/Xiejiayun/aerial/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Xiejiayun/aerial/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@jiayunxie/aerial.svg)](https://www.npmjs.com/package/@jiayunxie/aerial)

Aerial lets Codex CLI and Claude Code use your own GitHub Copilot subscription through a local proxy on your machine.

It runs locally on `127.0.0.1:18181`. Your GitHub token and Aerial key stay on your machine. It is built for personal local use, not for public hosting or account sharing.

## Install

Requirements:

- Node.js 22+
- A GitHub account with an active Copilot subscription
- Codex CLI and/or Claude Code installed

```bash
npm install -g @jiayunxie/aerial
```

## Quick Start

1. Sign in to GitHub:

```bash
aerial login
```

2. Configure the client you use:

```bash
# Codex CLI
aerial setup codex

# Claude Code
aerial setup claude
```

During setup, Aerial reads your Copilot model list, shows the models that work for that client, and asks which one to write into the client config. Codex uses models with the `responses` route. Claude Code uses models with the `messages` route.

3. Start Aerial in the background:

```bash
aerial service install
```

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

The easiest path is to let setup show the compatible models:

```bash
aerial setup codex
aerial setup claude
```

To pin a model without the prompt:

```bash
aerial setup codex --model <responses-model-id>
aerial setup claude --model <messages-model-id>
```

To inspect the full model matrix:

```bash
aerial probe
```

## Daily Commands

```bash
aerial status           # setup, login, service, and health summary
aerial service install  # install and start the background service
aerial doctor           # local diagnostics
aerial disable          # restore client configs and uninstall the service
```

`aerial start` is for foreground debugging in the current terminal. Most users should use `aerial service install`.

Advanced service lifecycle commands are documented in `docs/usage.md`.

## Troubleshooting

- `Missing GitHub token`: run `aerial login`.
- `Invalid or missing Aerial API key`: rerun `aerial setup codex` or `aerial setup claude`, then restart the client.
- No models listed during setup: run `aerial login` first, then retry setup.
- Port conflict on `18181`: run `aerial status` to see whether another process is using the port.
- Need to undo setup: run `aerial disable`, or restore one client with `aerial setup restore <codex|claude> --latest`.

## Notes

- macOS background service support uses a user LaunchAgent.
- Windows background service support uses a user Task Scheduler task.
- Linux service management is not built in yet; run `aerial start` or use your own init system.
- Copilot inference routes are an observed compatibility target and may change upstream.

More details: `docs/usage.md`.
