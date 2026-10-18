# Tokmizer

Tokmizer shortens the command output that AI coding tools (Claude Code, Codex, Cursor, Gemini CLI, Copilot and others) send to the model, so it takes less room in the context window.

- Install and usage: [packages/plugin/README.md](packages/plugin/README.md)
- Website: [tokmizer.com](https://tokmizer.com)

## Repository layout

| Path | Content |
|---|---|
| `packages/plugin/src/` | CLI, hooks, agent adapters, daemon and shims |
| `packages/plugin/src/engine/` | compression engine (BUSL-1.1) |
| `packages/plugin/filters/` | TOML rule catalogue (BUSL-1.1) |
| `packages/plugin/native/` | optional Rust launcher |
| `packages/plugin/command-templates/`, `codex-plugin/`, `agent-plugins/`, `hooks/` | setup for each supported tool |

## Build from source

Requirements: Node.js 20.11 or later and npm. The native launcher is optional and needs a Rust toolchain.

```
npm install
npm run build
npm test
```

The build writes `packages/plugin/dist/`. Try it with `node packages/plugin/dist/bin/tkr.js help`. Build the native launcher with `npm --workspace packages/plugin run build:native`, then run `npm run build` again.

The tokmizer.com service (account, rule downloads, telemetry) is not part of this repository. The CLI works without it, using the rules embedded at build time.

## Licence

Apache-2.0, except the compression engine (`packages/plugin/src/engine/`) and the rule catalogue (`packages/plugin/filters/`), which are under the Business Source License 1.1 and become Apache-2.0 four years after each release. Production use is allowed; offering them as part of a competing token-optimization product or hosted service is not. See [packages/plugin/LICENSES.md](packages/plugin/LICENSES.md), [LICENSE](LICENSE), [LICENSE-ENGINE](LICENSE-ENGINE) and [NOTICE](NOTICE).

Contributions are welcome under a [Contributor License Agreement](CLA.md) in favour of Impulse Creation: see [CONTRIBUTING.md](CONTRIBUTING.md). Security reports: [SECURITY.md](SECURITY.md).
