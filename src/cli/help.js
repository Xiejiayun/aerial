export function printHelp() {
  console.log(`Aerial local Copilot proxy

Usage:
  aerial --version
  aerial login
  aerial setup codex [--model <id>] [--effort <low|medium|high|xhigh|max>]
  aerial setup claude [--model <id>] [--effort <low|medium|high|xhigh|max>]
  aerial service install
  aerial status [--json]
  aerial proxy status|enable|disable [--json]

Diagnostics and rollback:
  aerial setup status [--json]
  aerial setup restore <codex|claude|all> --latest
  aerial service status [--json]
  aerial disable
  aerial doctor
  aerial probe [--live] [--json]

Debug:
  aerial start [--host 127.0.0.1] [--port 18181]`);
}
