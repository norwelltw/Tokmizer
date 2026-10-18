# Tokmizer

Tokmizer shortens the command output your AI coding agent sends to the model, so it takes less room in the context window. It aims to keep errors and failing tests intact.

## Install

**Claude Code**

```
/plugin marketplace add norwelltw/Tokmizer
/plugin install tokmizer@tokmizer
```

Restart Claude Code once, then run `/tkr-status`.

**Codex, Cursor, Gemini CLI, Copilot and other agents**

```bash
curl -fsSL https://tokmizer.com/install.sh | bash
tkr setup --all
```

The script uses npm when Node.js 20.11 or newer is installed, and otherwise downloads a standalone build for macOS or Linux, checked against its SHA-256. It leaves your shell profile unchanged.

**npm** (on Windows, use `npm.cmd` and `tkr.cmd`)

```bash
npm install -g @tokmizer/plugin
tkr setup --all
```

Per-agent notes: [installation guide](https://tokmizer.com/docs#installation).

## Example

`cargo test` with three failing tests, from the synthetic fixture [`test-failures/cargo.txt`](packages/plugin/src/__tests__/fixtures/test-failures/cargo.txt).

Before: 42 lines (1,102 bytes) with compile lines, every passing test, panic headers, a backtrace hint and the failure list twice.

After: 11 lines (382 bytes).

```
× tests::truthy src/lib.rs:12:27
  assertion failed: add(0, 0) > 0
× tests::big src/lib.rs:10:24
  assertion `left == right` failed: adding 6 and 1
    left: 8
   right: 7
× tests::empty src/lib.rs:2:34
  index out of bounds: the len is 0 but the index is 0
test result: FAILED. 4 passed; 3 failed; 0 ignored; 0 measured; 0 filtered out
error: test failed, to rerun pass `--lib`
```

Results depend on the command and the mode. Measured figures and method: [tokmizer.com/compare](https://tokmizer.com/compare).

## Stay in control

- `tkr restore` gives back the full output of a shortened command.
- `tkr telemetry off` turns off usage statistics.
- `tkr network off` stops every connection to tokmizer.com. The CLI keeps working with its built-in rules.

## Build from source

Node.js 20.11 or newer and npm. The optional native launcher needs Rust.

```
npm install
npm run build
npm test
```

Then try `node packages/plugin/dist/bin/tkr.js help`. The tokmizer.com service (account, rule downloads, telemetry) is not part of this repository.

## Licence

Apache-2.0, except the compression engine (`packages/plugin/src/engine/`) and the rule catalogue (`packages/plugin/filters/`), which are under the Business Source License 1.1. Production use is allowed; offering them in a competing token-optimization product or hosted service is not. Each release becomes Apache-2.0 four years after it ships. Details: [LICENSES.md](packages/plugin/LICENSES.md).

## Bugs and fixes

Found a bug? Open an issue (template provided). You can suggest a fix in it; the maintainer reviews and applies changes himself, see [CONTRIBUTING.md](CONTRIBUTING.md). Security reports: [SECURITY.md](SECURITY.md).
