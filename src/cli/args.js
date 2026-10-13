// Validate the complete command before dispatch: a typo must never turn into
// a reset, an uninstall, a credential write, or an unintended server start.
const spec = (usage, { flags = [], values = [], positional = 0 } = {}) => ({ usage, flags, values, positional });
const commands = {
  "--version": spec("--version"),
  update: spec("update [--check]", { flags: ["--check"] }),
  upgrade: spec("update [--check]", { flags: ["--check"] }),
  status: spec("status [--json]", { flags: ["--json"] }),
  login: spec("login [--force]", { flags: ["--force"] }),
  start: spec("start [--host <loopback>] [--port <port>]", { values: ["--host", "--port"] }),
  teardown: spec("teardown"),
  doctor: spec("doctor [--json]", { flags: ["--json"] }),
  probe: spec("probe [--live] [--json]", { flags: ["--live", "--json"] }),
  key: {
    generate: spec("key generate"),
    print: spec("key print")
  },
  setup: {
    codex: spec("setup codex [--model <id>] [--effort <level>]", { values: ["--model", "--effort"] }),
    claude: spec("setup claude [--model <id>] [--effort <level>]", { values: ["--model", "--effort"] }),
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
  if (!args.length || args.includes("--help") || args.includes("-h")) return { help: true };
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
