// Validate the complete command before dispatch: a typo must never turn into
// a reset, an uninstall, a credential write, or an unintended server start.
const spec = (usage, { flags = [], values = [], positional = 0, passthrough = false } = {}) => ({ usage, flags, values, positional, passthrough });
const commands = {
  "--version": spec("--version"),
  update: spec("update [--check]", { flags: ["--check"] }),
  upgrade: spec("update [--check]", { flags: ["--check"] }),
  status: spec("status [--json]", { flags: ["--json"] }),
  login: spec("login [--provider <github|cowork>] [--force]", { flags: ["--force"], values: ["--provider"] }),
  start: spec("start [--host <loopback>] [--port <port>]", { values: ["--host", "--port"] }),
  teardown: spec("teardown"),
  doctor: spec("doctor [--json]", { flags: ["--json"] }),
  probe: spec("probe [--live] [--json]", { flags: ["--live", "--json"] }),
  cowork: {
    configure: spec("cowork configure --profile <json>", { values: ["--profile"] }),
    auth: spec("cowork auth [--interactive] [--origin <https-url>]", { flags: ["--interactive"], values: ["--origin"] }),
    doctor: spec("cowork doctor [--json]", { flags: ["--json"] }),
    models: spec("cowork models [--json]", { flags: ["--json"] }),
    probe: spec("cowork probe --model <id> [--effort <low|medium|high|xhigh|max>]", { values: ["--model", "--effort"] }),
    operations: spec("cowork operations [--json]", { flags: ["--json"] }),
    release: spec("cowork release <operation-id>", { positional: 1 }),
    run: spec("cowork run --model <id> [--claude <path>] -- [Claude arguments]", { values: ["--model", "--claude"], passthrough: true })
  },
  key: {
    generate: spec("key generate"),
    print: spec("key print")
  },
  setup: {
    codex: spec("setup codex [--model <id>] [--effort <level>] [--configure-only] [--verbose]", { values: ["--model", "--effort"], flags: ["--configure-only", "--verbose"] }),
    claude: spec("setup claude [--model <id>] [--effort <level>] [--configure-only] [--verbose]", { values: ["--model", "--effort"], flags: ["--configure-only", "--verbose"] }),
    all: spec("setup all"), // Keep the actionable migration error in the handler.
    status: spec("setup status [--json]", { flags: ["--json"] }),
    restore: spec("setup restore <codex|claude|all> --latest", { flags: ["--latest"], positional: 1 })
  },
  service: Object.fromEntries(["install", "start", "stop", "restart", "uninstall", "status"].map(action => [
    action, spec(`service ${action}${action === "status" ? " [--json]" : ""}`, { flags: action === "status" ? ["--json"] : [] })
  ])),
  proxy: Object.fromEntries(["", "status", "enable", "disable"].map(action => [
    action, spec(`proxy ${action || "status"} [--json]`, { flags: ["--json"] })
  ])),
  config: {
    "": spec("config"),
    reset: spec("config reset"),
    set: spec("config set <key> <value>", { positional: 2 })
  }
};

export function parseGlobalArgs(args) {
  if (args[0] !== "--config-dir") return { args };
  const configDir = args[1];
  if (!configDir || configDir.startsWith("-")) throw new Error("--config-dir requires a directory.");
  if (args.length < 3) throw new Error("Usage: aerial --config-dir <directory> <command>");
  return { args: args.slice(2), configDir };
}

export function validateCliArgs(args) {
  if (!args.length || hasCliHelp(args)) return { help: true };
  const [command, ...tail] = args;
  let rule = commands[command];
  if (!rule) throw new Error(`Unknown command: ${command}. Run: aerial --help`);
  let rest = tail;
  if (!rule.usage) {
    const subcommand = tail[0] && !tail[0].startsWith("-") ? tail[0] : "";
    rule = rule[subcommand];
    if (!rule) throw new Error(`Unknown ${command} subcommand: ${subcommand || "(missing)"}. Run: aerial ${command} --help`);
    rest = subcommand ? tail.slice(1) : tail;
  }
  const seen = new Set();
  const positional = [];
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--" && rule.passthrough) break;
    if (!arg.startsWith("-")) {
      positional.push(arg);
      continue;
    }
    if (!rule.flags.includes(arg) && !rule.values.includes(arg)) {
      throw new Error(`Unknown option: ${arg}. Usage: aerial ${rule.usage}`);
    }
    if (seen.has(arg)) throw new Error(`Duplicate option: ${arg}. Usage: aerial ${rule.usage}`);
    seen.add(arg);
    if (rule.values.includes(arg)) {
      const value = rest[++i];
      if (!value || value.startsWith("-")) throw new Error(`${arg} requires a value. Usage: aerial ${rule.usage}`);
    }
  }
  if (positional.length !== rule.positional) throw new Error(`Usage: aerial ${rule.usage}`);
  return { help: false };
}

export function hasCliHelp(args) {
  // Claude's arguments after the explicit separator belong to Claude, including
  // --help; they must never be treated as Aerial help or Aerial options.
  const commandOffset = args[0] === "--config-dir" ? 2 : 0;
  const passthrough = args[commandOffset] === "cowork" && args[commandOffset + 1] === "run";
  const separator = passthrough ? args.indexOf("--", commandOffset + 2) : -1;
  const ownArgs = separator < 0 ? args : args.slice(0, separator);
  return ownArgs.includes("--help") || ownArgs.includes("-h");
}
