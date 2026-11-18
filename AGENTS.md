# Aerial contributor map

Aerial is a single Node.js ESM package. The CLI starts a private loopback HTTP gateway for a user's own clients; it does not manage outbound proxies. There is no build or transpile step. Use Node 20.18.1 or later and install the locked dependencies with `npm ci`.

## Where changes belong

| Directory | Responsibility |
| --- | --- |
| `src/cli/` | Validate arguments before dispatch, load only the requested command, and format human and JSON output. Keep help and key lookup lightweight. |
| `src/proxy/` | Accept local requests, authenticate protected routes, and translate supported protocols. Images share the transport; preserve stream cancellation and backpressure. |
| `src/upstream/` | Make outbound HTTP requests. Honor cancellation and the migration guard; never silently reroute an installation with active legacy settings. |
| `src/setup/` | Own client configuration, backup discovery, takeover journals, exact restore and edit-preserving teardown. Backup storage is independent of the client registry. |
| `src/service/` | Own lifecycle, health checks and platform adapters. Windows and macOS have native supervisors; Linux supports foreground use. |
| `src/shared/` | Configuration, credential storage, login and token refresh, paths, logging and shared value parsing. Never log tokens or prompts. |

## Follow a change

- **An API request:** start at [the HTTP server](src/proxy/server.js), then the [conversation handlers](src/proxy/index.js) or [Images handlers](src/proxy/images.js), then [HTTP transport](src/proxy/transport.js). Optional Responses WebSocket handling lives in [its own adapter](src/proxy/responses-websocket.js).
- **A client configuration change:** start at [setup dispatch](src/cli/commands/setup.js), then [readiness checks](src/cli/setup-readiness.js) and [client writers](src/setup/clients.js). [Backups](src/setup/backups.js) support explicit [restore](src/setup/restore.js); [takeover state](src/setup/takeover.js) lets teardown preserve subsequent user edits. Test these as different operations.

## Verify and deliver

Use the smallest relevant `node --test test/<name>.test.js` first. Before delivery run:

```sh
node scripts/check-syntax.js
npm test
node scripts/verify-package.mjs
node scripts/verify-secrets.mjs
```

Use isolated home/config directories for CLI tests. Do not run live inference, change a user's service, or publish as a side effect of testing. [CI](.github/workflows/ci.yml) runs the OS/Node matrix, isolated native-service checks, dependency audit and packaging gates.

[Usage](docs/usage.md) describes shipped behavior. [The original design](docs/development-design.md) and dated specs record proposals, not the current file layout. [The release runbook](docs/release-runbook.md) governs version selection, protected-main checks, publishing and recovery. Merging a feature does not publish an npm version.
