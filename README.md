# Tokmizer

Tokmizer reduces token consumption for AI coding tools: Claude Code, OpenAI Codex, Cursor, Aider, Gemini CLI, Cline, Windsurf, and GitHub Copilot. Works on macOS, Linux, and Windows.

It shortens command output before it reaches the model, reducing the space it takes in the context window. The reduction depends on the output and the chosen mode. This is not a guarantee of a lower bill or faster coding, rendering, or builds.

## Install

In Claude Code:

```
/plugin marketplace add norwelltw/Tokmizer
/plugin install tokmizer@tokmizer
```

Then restart Claude Code once, hooks only load at startup. Verify with `/tkr-status`, you should see your plan and Active.

Any other tool (universal shell-shim):

```bash
curl -fsSL https://tokmizer.com/install.sh | bash
```

Windows (PowerShell):

```powershell
npm.cmd install -g @tokmizer/plugin
tkr.cmd shim install
```

See the [installation guide](https://tokmizer.com/en/docs#installation) for per-tool notes.

Codex, after installing with npm or Homebrew:

```bash
tkr setup-codex
```

Restart Codex, then approve the hook in `/hooks`.

Homebrew:

```bash
brew install norwelltw/tokmizer/tokmizer
tkr shim install
```

Node.js 20.11 or newer is required for npm installation. Open a new terminal after setting up shims, then run `tkr status`. An offline installation reports that free activation is pending; run `tkr status` again when online.

## Free access

Tokmizer is free and works without an account. An optional account lets you synchronize settings and view your dashboard. To connect an existing account key:

```bash
tkr link <your-key>
```

## Commands

In Claude Code:

- `/tkr` shows or changes settings
- `/tkr-link tokmizer_yourkey` connects an optional account
- `/tkr-unlink` unlinks this machine from your account
- `/tkr-gain` shows the estimated reduction in command-output tokens
- `/tkr-status` shows your current plan and usage
- `/tkr-compression` picks the compression level (light, balanced, max)
- `/tkr-yolo on` explicitly enables YOLO on this machine; `/tkr-yolo off` disables it
- `/tkr-reducer` makes the assistant's replies shorter (off, light, balanced, max)
- `/tkr-telemetry` views or changes anonymous telemetry
- `/tkr-update` updates the plugin when a new version is out

From any terminal (after the shell-shim install, or `npm install -g @tokmizer/plugin`):

- `tkr status` shows your current plan and status
- `tkr gain` shows the estimated reduction in command-output tokens
- `tkr link <key>` connects an optional account
- `tkr unlink` unlinks this machine
- `tkr compression light|balanced|max` picks how hard output gets compressed (default balanced)
- `tkr yolo on|off|status` enables, disables, or checks the local YOLO mode
- `tkr reducer off|light|balanced|max` makes the assistant's replies shorter (default off)
- `tkr settings show|set|configure` manages settings and syncs them across your machines

## Choosing a compression mode

Choose `light` for gentle reduction, `balanced` (the default) for more compact output, or `max` for the strongest standard reduction. The aliases `normal`, `compact`, and `minimal` map to these levels respectively. Short or exact output can be identical across levels. Recognized failures retain their content apart from terminal colors.

Without a linked account, standard settings stay on this machine and work offline after initial activation. With a linked account, changes require a connection and sync across machines. Linking an account restores its server settings.

The separate `reducer` setting provides response-style instructions for Claude Code, starting with the next session. Automatic injection is not implemented for Codex or other agents. The instructions ask the model to preserve code, errors, and security information; compliance and actual savings depend on the model. If the ruleset is unavailable, the CLI reports it instead of claiming activation. Reconnect and run `tkr heartbeat` before starting a new session.

YOLO is off by default and requires an explicit `on`. It applies only to this machine, is not synchronized, and cannot be enabled from the dashboard.

| Command | Effect |
| --- | --- |
| `tkr yolo on` | Enable more aggressive compression on this machine |
| `tkr yolo off` | Return to the usual compression mode |
| `tkr yolo status` | Show whether YOLO is enabled |
| `tkr compression light`, `tkr compression balanced`, or `tkr compression max` | Disable YOLO locally. Linked accounts need a connection to sync the standard level |

**YOLO can remove errors, list entries, and useful details.** It creates no new restoration copies of compressed output. Existing cached output is not deleted, but turning YOLO off cannot recover details discarded while it was on. Command exit codes remain unchanged.

Use YOLO for repeated commands only when you accept incomplete output and can check the result independently. Turn it off for debugging, diagnosis, exhaustive code review, audits, or any task that needs the complete output. A preserved exit code alone does not verify the result. YOLO is not a promise of faster coding, rendering, or builds.

Terminal commands managed by Tokmizer use the mode selected when execution starts. Native agent tools use the mode active when their output is received. Output processing that has already started in YOLO remains without a restoration copy after YOLO is turned off. Turning YOLO on blocks new restoration copies. Change modes between commands. This concerns Tokmizer's copies, not any history kept by your agent or terminal.

`tkr gain` measures output size before and after compression and estimates tokens as UTF-8 bytes divided by four. Token and cost figures are estimates about command output, not your actual bill or a measure of task quality or completion speed.

## Measured comparison

On October 9, 2026, a fixed set of 30 real and synthetic command outputs contained 774,863 tokens before compression. The table counts tokens with the cl100k tokenizer, excluding restoration notices. It is a test corpus, not a sample of customer usage.

| Mode | Output tokens | Preservation checks passed |
| --- | ---: | ---: |
| `light` | 112,816 | 85 / 85 |
| `balanced` | 102,052 | 85 / 85 |
| `max` | 93,131 | 85 / 85 |
| YOLO | 1,925 | 44 / 85 |

The 85 checks cover 13 of the 30 cases. The other 17 have no complete preservation checks, so these results do not prove universal fidelity. YOLO's smaller output comes with observed information loss.

The result also depends on the output. In a separate set of five JSON examples, `light` produced 285 tokens, `balanced` 253, and both `max` and YOLO 197. YOLO does not always save more than `max`.

In one real failed test, `max` kept 302 tokens and YOLO kept 77. Both retained the actual and expected values. YOLO removed the explanation about invoice 42 and the location `payment.test.mjs:4:10`, which were retained by `max`. That missing context can matter when fixing the failure.

These tokenizer counts are separate from the byte-based estimates in `tkr gain`. They measure output volume, not your bill, an agent's task success, or execution speed. See the [mode guide](https://tokmizer.com/en/docs#configuration) for usage and limits.

## Distribution

This README is shared by the npm package and the public GitHub repository.

- The npm package includes the CLI, Claude Code hooks and command templates, and the Codex manifest.
- The public repository contains installation scripts, distribution manifests, the `/tkr` entry command, and selected UI, usage, and redaction helpers.

The optimization engine and API client ship compiled with [`@tokmizer/plugin`](https://www.npmjs.com/package/@tokmizer/plugin). Their source code is not in the public repository.

## Privacy

- When telemetry is enabled, Tokmizer reports command names, usage counters, and session metadata, without your source code, arguments, or command output. Turn it off with `tkr telemetry off`.
- The public [redaction helpers](https://github.com/norwelltw/Tokmizer/blob/main/src/learn/redact.ts) are available for inspection.
- Local state lives in `~/.tokmizer/`.

## License

Proprietary. See [LICENSE](LICENSE) and the EULA at [tokmizer.com/eula](https://tokmizer.com/eula).
