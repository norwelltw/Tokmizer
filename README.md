<div align="center">

# Tokmizer

**Your AI coding agent reads up to 93% fewer tokens of command output, and keeps every error.**

Free · no account · Claude Code, Codex, Cursor, Gemini CLI, Copilot and 16 more agents · macOS, Linux, Windows

[![npm](https://img.shields.io/npm/v/@tokmizer/plugin?label=npm&color=cb3837)](https://www.npmjs.com/package/@tokmizer/plugin)
[![licence](https://img.shields.io/badge/licence-Apache--2.0%20%2B%20BUSL--1.1-blue)](https://github.com/norwelltw/Tokmizer/blob/main/packages/plugin/LICENSES.md)
[![node](https://img.shields.io/badge/node-%E2%89%A5%2024.22.1-339933)](https://nodejs.org)

[Website](https://tokmizer.com) · [Docs](https://tokmizer.com/en/docs) · [Benchmark vs rtk](https://tokmizer.com/en/compare/rtk) · [CI](https://tokmizer.com/en/ci)

</div>

---

Every `npm test`, `cargo build`, `git log` or `grep -rn` your agent runs pours its full output into the context window: passing tests, progress bars, compile lines, the same warning 400 times. Tokmizer sits between the command and the model and hands over what matters: the failures, the diagnostics, the result. The full output stays one command away.

## Before and after

`cargo test` with three failing tests ([fixture](https://github.com/norwelltw/Tokmizer/blob/main/packages/plugin/src/__tests__/fixtures/test-failures/cargo.txt)).

**Before:** 42 lines, 1,102 bytes. Compile lines, every passing test, panic headers, a backtrace hint, and the failure list printed twice.

**After:** 11 lines, 382 bytes.

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

Every assertion, location and value is still there.

## Numbers

68 real command outputs replayed offline through each tool's Claude Code hooks (Tokmizer 0.9.71 and rtk 1.0.1 with default settings, o200k_base tokenizer, median of 3 runs, 2026-10-19):

| | Tokmizer, Claude Code default mode | Tokmizer, commands rewritten | rtk 1.0.1 |
| --- | ---: | ---: | ---: |
| Tokens removed | **93.0%** | **94.3%** | 55.5% |
| Failure details kept, out of 307 | **307** | **307** | 133 |
| Failing runs that lost a detail, out of 26 | **0** | **0** | 10 |
| Cuts without a marker | none found | none found | found |

- Claude Code's own `Read`, `Grep` and `Glob` tools are shortened too: large file reads −62% to −91%, `grep` −27% to −94%, `glob` −70%. Smaller code files stay whole.
- The hook that runs before each command takes about 3 ms with the native launcher, against 11 to 17 ms for rtk (measured 2026-10-16).

These figures count command output, not your bill, task success or speed. Small outputs gain less: 51% on the outputs under 30,000 characters. Method, every case and the raw JSON: [tokmizer.com/en/compare/rtk](https://tokmizer.com/en/compare/rtk). A public benchmark you can replay yourself: [BENCHMARK.md](https://github.com/norwelltw/Tokmizer/blob/main/BENCHMARK.md).

## Install

### Claude Code

```
/plugin marketplace add norwelltw/Tokmizer
/plugin install tokmizer@tokmizer
```

Restart Claude Code once (hooks load at startup), then run `/tkr-status`. You should see `Status active`.

### Every other agent

Install the CLI, then let `tkr setup --all` hook every agent it finds on this machine:

```bash
curl -fsSL https://tokmizer.com/install.sh | bash
tkr setup --all
```

The script uses npm when a patched Node.js (24.22.1+, or 22.23.4+) is installed, and otherwise downloads a standalone build for macOS or Linux after checking its signature and SHA-256. Your shell profile is not touched.

<table>
<tr><td><b>npm</b></td><td>

```bash
npm install -g @tokmizer/plugin
tkr setup --all
```

</td></tr>
<tr><td><b>Homebrew</b></td><td>

```bash
brew install norwelltw/tokmizer/tokmizer
tkr setup --all
```

</td></tr>
<tr><td><b>Windows</b><br>PowerShell</td><td>

```powershell
npm.cmd install -g @tokmizer/plugin
tkr.cmd setup --all
```

</td></tr>
</table>

`tkr setup` without `--all` lists what it found and asks. Restart each agent after setup, then run `tkr status`. Installed with npm or Homebrew, `tkr` updates itself 24 hours after a version ships; `tkr auto-update off` stops that.

### Supported agents

| Agent | Setup | Through |
| --- | --- | --- |
| Claude Code | plugin above, or `tkr setup-claude` | native hooks |
| Codex | `tkr setup-codex`, then approve the hook in `/hooks` | native hooks |
| Cursor | `tkr setup-cursor` | `preToolUse` hook |
| Gemini CLI | `tkr setup-gemini` | `BeforeTool` hook |
| GitHub Copilot, VS Code and CLI | `tkr setup-copilot` | `PreToolUse` hook |
| Factory Droid | `tkr setup-droid` | `PreToolUse` hook |
| Trae, Trae CN | `tkr setup-trae` | `PreToolUse` hook |
| Qwen Code | `tkr setup-qwen` | `PreToolUse` hook |
| Crush | `tkr setup-crush` | `PreToolUse` hook |
| Junie CLI | `tkr setup-junie` | `PreToolUse` hook |
| ZCode | `tkr setup-zcode` | `PreToolUse` hook |
| Grok Build 1.0.4+ | `tkr setup-grok` | `PreToolUse` hook |
| Antigravity | `tkr setup-antigravity` | `PreToolUse` hook |
| Mistral Vibe | `tkr setup-vibe` | `pre_tool` hook |
| OpenCode | `tkr setup-opencode` | plugin |
| Kilo Code, CLI and VS Code | `tkr setup-kilo` | plugin |
| Amp | `tkr setup-amp` | plugin |
| OpenClaw | `tkr setup-openclaw` | plugin |
| Hermes v2026.8.16+ | `tkr setup-hermes` | plugin |
| Pi | `tkr setup-pi` | extension |
| Oh My Pi | `tkr setup-omp` | extension |
| Aider, Cline, Windsurf | `tkr wrap aider` | command shims, for that session only |

Every setup command keeps your other hooks and settings, saves the file as it was in `~/.tokmizer/backup/config/`, and takes itself out with `--remove`. If `tkr` is missing, slow or fails, the command runs exactly as typed.

<details>
<summary>Files each setup command edits</summary>

| Command | File |
| --- | --- |
| `tkr setup-cursor` | `~/.cursor/hooks.json` |
| `tkr setup-gemini` | `~/.gemini/settings.json` |
| `tkr setup-copilot` | `~/.copilot/hooks/tokmizer.json`, or `$COPILOT_HOME/hooks/` |
| `tkr setup-droid` | `~/.factory/hooks.json`, or `~/.factory/settings.json` when your own `PreToolUse` hooks live there |
| `tkr setup-trae` | `~/.trae/hooks.json`, plus `~/.trae-cn/hooks.json` when Trae CN is installed |
| `tkr setup-qwen` | `~/.qwen/settings.json`, or `$QWEN_HOME` |
| `tkr setup-crush` | `~/.config/crush/crush.json`; a `crush.json` with comments is left untouched and reported |
| `tkr setup-junie` | `~/.junie/config.json` |
| `tkr setup-zcode` | `~/.zcode/cli/config.json` |
| `tkr setup-grok` | `~/.grok/hooks/tokmizer.json` |
| `tkr setup-antigravity` | `~/.gemini/config/hooks.json` |
| `tkr setup-vibe` | `~/.vibe/hooks.toml` |
| `tkr setup-opencode` | `~/.config/opencode/plugins/tokmizer.js` |
| `tkr setup-kilo` | `~/.config/kilo/plugin/tokmizer.js` |
| `tkr setup-amp` | `~/.config/amp/plugins/tokmizer.js` |
| `tkr setup-openclaw` | `~/.openclaw/extensions/tokmizer/`, then `openclaw plugins enable tokmizer` |
| `tkr setup-hermes` | `~/.hermes/plugins/tokmizer/`, then `hermes plugins enable tokmizer` |
| `tkr setup-pi` | `~/.pi/agent/extensions/tokmizer.js` |
| `tkr setup-omp` | `~/.omp/agent/extensions/tokmizer.js` |

`XDG_CONFIG_HOME`, `VIBE_HOME`, `PI_CODING_AGENT_DIR` and `HERMES_HOME` are respected.

</details>

<details>
<summary>Hooks copied between agents, Codex <code>/import</code></summary>

Codex `/import` copies your Claude Code hooks, and config files get copied by hand. Tokmizer hooks are safe to bring along: each one reads which agent is calling it and answers in that agent's format; if the input mixes two agents, it changes nothing. Afterwards run `tkr setup --all` or `tkr doctor --fix`: each agent gets its own hook, the copied ones are removed, your own hooks stay, and every changed file is backed up.

If Codex reports `PreToolUse hook returned updatedInput without permissionDecision:allow`, it is running Claude Code hooks. Run `tkr doctor --fix`, approve the Tokmizer hook in `/hooks` and restart Codex.

</details>

## How it works

1. **Before a command runs**, the agent's hook asks Tokmizer whether to route it. If so, it runs through `tkr-exec`, which picks a built-in rule for it: `cargo`, `pytest`, `vitest`, `jest`, `go test`, `gradle`, `git`, `docker`, `kubectl`, `terraform` and many more.
2. **The rule shortens the output.** Passing tests, progress, repeated lines and boilerplate go; failures, diagnostics, locations and the exit code stay. A shortened output is never longer than the original.
3. **A copy of the full output** stays on your machine. When something was cut, the agent sees a `[tkr restore <hash>]` hint and can fetch it back.

### Your permission rules stay in force

Agents check their allow, ask and deny rules against the command text. Tokmizer reads those rules and leaves a command untouched whenever one of your deny or ask rules matches it, so `git push` or `rm` run as typed and still ask you. For agents whose rules it cannot read, only inspection, build and test commands are routed. Shell functions, aliases and builtins always run as typed, and if a settings file cannot be read, nothing is routed.

<details>
<summary>Claude Code permission modes</summary>

| Mode | What Tokmizer does |
| --- | --- |
| Default | Build and test commands (`npm test`, `cargo test`, `pytest`, `./gradlew build`…) are shortened before they run; Claude Code asks for them once, as it would anyway. Read-only commands (`ls`, `cat`, `git status`) run as typed, so Claude Code still approves them on its own, and their output is shortened once they succeed. |
| Default, with a narrow allow rule of yours such as `Bash(pytest:*)` | A single command it covers is rewritten too, with no new prompt. |
| `bypassPermissions`, or a plain `Bash` allow rule | Every routed command is rewritten, and failing output is shortened too. |

Your deny and ask rules, `--disallowedTools`, `--settings`, managed policies and the claude.ai console rules always win. In a linked git worktree, commands that mention git run as typed so Claude Code's worktree check never refuses them.

</details>

## Commands

| Claude Code | Terminal | What it does |
| --- | --- | --- |
| `/tkr-status` | `tkr status` | account, engine and rule status |
| `/tkr-gain` | `tkr gain` | tokens saved, by day, project or rule |
| `/tkr-compression` | `tkr compression light\|balanced\|max` | how hard output is shortened, `balanced` by default |
| `/tkr-reducer` | `tkr reducer off\|light\|balanced\|max` | shorter replies from the model itself, `off` by default |
| `/tkr-yolo` | `tkr yolo on\|off\|status` | very aggressive mode, see below |
| `/power` | `$power` in Codex, `/power` in most agents | plan, build, test and ship a change in one go |
| `/tkr` | `tkr settings show\|set\|configure` | every setting |
| `/tkr-telemetry` | `tkr telemetry on\|off\|status` | usage stats |
| `/tkr-link` | `tkr link <key>` | optional account: synced settings and a dashboard, up to 15 devices at once |
| `/tkr-unlink` | `tkr unlink` | detach this machine from the account |
| `/tkr-update` | npm, brew or auto-update | latest version |

Also in the terminal: `tkr restore`, `tkr doctor [--fix]`, `tkr discover`, `tkr session`, `tkr network`, `tkr filters`, `tkr migrate rtk`, `tkr setup`, `tkr uninstall`. `tkr help` lists everything.

## Compression modes

| Mode | Use it for |
| --- | --- |
| `light` | gentle shortening; file reads up to 16 KB stay whole. Pick it when you need implementation details. |
| `balanced` | the default: compact output, code bodies can be folded in large reads |
| `max` | the strongest standard level; repeated log lines become one line with a count |

All three keep failures, distinct diagnostics and exit codes. Short or exact output is often identical across levels. `normal`, `compact` and `minimal` work as aliases.

> **Warning: YOLO** (`tkr yolo on`) goes further and **can remove errors, list entries and useful details**. It keeps no restore copy, so what it drops cannot be recovered. It is off by default, applies to this machine only and cannot be turned on from the dashboard. Keep it off for debugging, reviews, audits or anything that needs the full output.

The **reducer** is separate: from the next session it asks the model to answer in fewer words, while keeping code, errors and security warnings. It works in Claude Code and in every agent set up with `tkr setup-<agent>`. How much it saves depends on the model.

## Getting the full output back

```bash
tkr restore <hash>                     # the whole original output
tkr restore <hash> --lines 120:180     # only some lines
tkr restore <hash> --grep timeout      # matching lines with their numbers
tkr restore --grep timeout             # search every cached output of this project
tkr restore --list                     # what is cached here; --all-projects for every project
```

Copies stay on your machine for 30 days, up to 8 MB each and 200 MB in total. Private keys, GitHub, npm, AWS, Slack and Stripe tokens, `Bearer` headers and passwords in URLs are masked before a copy is saved; what the agent sees is unchanged. `TOKMIZER_CCR_DISABLED=1` turns copies off.

## Measuring your own savings

```bash
tkr gain                 # all time
tkr gain --week --graph  # last 7 days, one bar per day
tkr gain --by-rule       # which rules saved the most
tkr gain --failures      # commands left unchanged, and why
tkr gain --quota 5x      # rough share of a Claude plan budget (pro, 5x or 20x)
```

Each view also takes `--project` and `--json`. `tkr gain` estimates command-output tokens as bytes divided by four; it is not your actual usage. Restores count against the saving.

## /power and the reducer in other agents

`tkr setup-<agent>` also installs `/power` and the reducer where the agent offers a documented way to do it. `/power` runs only the steps the agent's tools allow and says what is left when it cannot run tests or open a pull request. A command or skill you wrote yourself is never overwritten. In rules files, Tokmizer only edits the block between `<!-- tokmizer:begin managed-by: tokmizer -->` and `<!-- tokmizer:end -->`.

<details>
<summary>Where each agent gets them</summary>

| Agent | `/power` | Reducer |
| --- | --- | --- |
| Claude Code | `/power` command | SessionStart and UserPromptSubmit hooks |
| Codex | skill `~/.agents/skills/power`, type `$power <request>` | SessionStart and UserPromptSubmit hooks |
| Gemini CLI | `~/.gemini/commands/power.toml` | SessionStart and BeforeAgent hooks |
| Cursor | skill `/power`, `~/.agents/skills` | sessionStart hook |
| GitHub Copilot CLI | skill `/power`, `~/.agents/skills` | sessionStart hook |
| Factory Droid | skill `/power`, `~/.agents/skills` | SessionStart and UserPromptSubmit hooks |
| Qwen Code | `~/.qwen/commands/power.md` | SessionStart and UserPromptSubmit hooks |
| ZCode | skill `/power`, `~/.zcode/skills` | SessionStart and UserPromptSubmit hooks |
| Trae | no documented location | SessionStart and UserPromptSubmit hooks |
| Antigravity | skill `/power`, `~/.gemini/config/skills` | SessionStart hook |
| Crush | skill `user:power`, `~/.agents/skills` | managed block in `~/.config/crush/CRUSH.md` |
| Junie CLI | `~/.junie/commands/power.md` | managed block in `~/.junie/AGENTS.md` |
| Grok Build | skill `/power`, `~/.grok/skills` | managed block in `~/.grok/AGENTS.md` |
| Mistral Vibe | skill `/power`, `~/.vibe/skills` | managed block in `~/.vibe/AGENTS.md` |
| OpenCode | `~/.config/opencode/commands/power.md` | plugin, experimental system prompt hook |
| Kilo Code | `~/.config/kilo/commands/power.md` | plugin, experimental system prompt hook |
| Amp | skill `power`, `~/.agents/skills`; ask Amp to use it | managed block in `~/.config/amp/AGENTS.md` |
| Pi | `~/.pi/agent/prompts/power.md` | managed block in `~/.pi/agent/APPEND_SYSTEM.md` |
| Oh My Pi | `~/.omp/agent/commands/power.md` | managed block in `~/.omp/agent/APPEND_SYSTEM.md` |
| Hermes | skill `/power`, `~/.hermes/skills` | plugin, system prompt section |
| OpenClaw | skill `/power`, `~/.openclaw/skills` | plugin, once `plugins.entries.tokmizer.hooks.allowConversationAccess` is `true` |
| Aider, Cline, Windsurf | not installed | not installed |

</details>

## Your own rules

Drop a `*.toml` file in `~/.tokmizer/filters/`. Your rules load next to the built-in ones, win for the commands they match, and never leave your machine.

```toml
schema_version = 1

[filters.make-check]
match_command = "^make\\s+check(\\s|$)"
strip_lines_matching = ["^make\\[\\d+\\]: (Entering|Leaving) directory"]
max_lines = 120
on_empty = "make check: no output"

[[filters.make-check.tests]]
name = "drops directory noise"
input = "make[1]: Entering directory '/src'\nok\n"
expected = "ok"
```

```bash
tkr filters test    # run the inline tests, exit 1 on failure
tkr filters trust   # after review: records the file's SHA-256 and starts using it
```

An edited file stops being used until you trust it again. Also available: `strip_ansi`, `keep_failures`, `truncate_lines_at` and `priority`. `tkr doctor` shows what loaded and why something was skipped.

## Coming from rtk

```bash
tkr migrate rtk --dry-run   # show the plan
tkr migrate rtk             # show it, ask, then apply
tkr migrate rtk --undo      # put every changed file back
```

It brings over your rtk filters and runs their tests on Tokmizer, plus `exclude_commands`, the `rtk recall` retention and a telemetry opt-out. rtk's history shows on its own line in `tkr gain`. In each agent where Tokmizer is installed, rtk's hook is removed so commands are not wrapped twice. Anything that cannot be imported is listed with the reason, and every changed file is backed up in `~/.tokmizer/migrate-rtk/`. `--shim` adds an `rtk` command that forwards `rtk gain` and `rtk recall` to Tokmizer.

## In CI

Add Tokmizer to Claude Code jobs that run with `anthropics/claude-code-action`:

```yaml
- id: tokmizer
  uses: norwelltw/Tokmizer@main
- uses: anthropics/claude-code-action@v1
  with:
    plugin_marketplaces: ${{ steps.tokmizer.outputs.plugin_marketplaces }}
    plugins: ${{ steps.tokmizer.outputs.plugins }}
```

Full workflow and options: [action/README.md](https://github.com/norwelltw/Tokmizer/blob/main/action/README.md).

## Network and privacy

Tokmizer works without an account or email. It contacts `tokmizer.com` to keep its rules current and to learn which commands to optimize next. **Never sent: command arguments, command output, file contents, file paths.**

```bash
tkr telemetry off   # stop usage stats
tkr network off     # stop every connection; compression keeps working with the built-in rules
```

`TOKMIZER_NETWORK=0` does the same for one shell or a CI job. Rules and commands downloaded from `tokmizer.com` are signed and checked against a key pinned in the CLI.

<details>
<summary>Exactly what leaves your machine</summary>

| When | What is sent | Why |
| --- | --- | --- |
| First online run | A random install ID, its SHA-256 hash (the fingerprint), your time zone and the plugin version. Nothing that describes your machine: no computer name, OS, hardware or user name | create the install token used to download rules |
| `tkr link <key>` | The same, plus your key, and your email only with `--email` | attach this machine to your account (up to 15 connected at once) |
| Check-in (heartbeat) | Install ID, fingerprint, plugin version, local date and time zone; while usage stats are on, install health counts such as outdated shims, broken hooks and repairs | refresh access, announce new versions, spot broken installs |
| Rule downloads | Install ID, fingerprint, plugin version | latest rules, `/power` and reducer instructions |
| Settings sync, linked accounts only | Your Tokmizer settings | keep them in sync with the dashboard |
| Usage stats, only while on | Command names such as `npm install` (never arguments), token counts, rule IDs with output sizes, session ID, agent name | see which commands to optimize next |
| `tkr unlink` | Install ID, fingerprint | remove this device from your account |
| Self-update | `npm i -g @tokmizer/plugin@<version>` or `brew upgrade tokmizer` | keep the CLI current; `tkr auto-update off` stops it |

The install ID is drawn at random on first run and says nothing about your machine. Like any web server, `tokmizer.com` sees your IP address and keeps it in its security log. Usage stats are on by default; Tokmizer says so once before anything is sent, and turning them off survives updates. Detailed rows are kept 90 days, then only a running total. With the network off, Tokmizer uses the last downloaded rules for up to 7 days, then the rules built into the CLI. `tkr network off` does not cover Claude Code's own marketplace auto-update. Full policy: [tokmizer.com/en/privacy](https://tokmizer.com/en/privacy).

</details>

## Uninstall

```bash
tkr uninstall                        # every hook, shim, PATH line, /power and reducer block Tokmizer added
npm uninstall -g @tokmizer/plugin    # or: brew uninstall tokmizer
```

In Claude Code: `/plugin uninstall tokmizer@tokmizer`. Your savings history stays in `~/.tokmizer` until you delete it. To pause without uninstalling: `tkr settings set enabled false`.

## Build from source

Node.js 24.22.1+ (or 22.23.4+) and npm. The optional native launcher needs Rust.

```bash
git clone https://github.com/norwelltw/Tokmizer
cd Tokmizer
npm install
npm run build
npm test
node packages/plugin/dist/bin/tkr.js help
```

Native launcher: `npm --workspace packages/plugin run build:native`, then `npm run build` again. To try your build in Claude Code, install the folder as a local plugin or run `npm --workspace packages/plugin link`. The `tokmizer.com` service (accounts, rule downloads, telemetry) is not part of this repository.

## Licence

Apache-2.0, except the compression engine (`packages/plugin/src/engine/`) and the rule catalogue (`packages/plugin/filters/`), which are under the Business Source License 1.1. Production use is allowed, including inside your own tools; offering them as part of a competing token-optimization product or hosted service is not. Each release becomes Apache-2.0 four years after it ships. Rules you write yourself stay yours. Details: [LICENSES.md](https://github.com/norwelltw/Tokmizer/blob/main/packages/plugin/LICENSES.md).

## Bugs and security

Found a bug? [Open an issue](https://github.com/norwelltw/Tokmizer/issues/new/choose). You can suggest a fix in it; the maintainer reviews and applies changes, see [CONTRIBUTING.md](https://github.com/norwelltw/Tokmizer/blob/main/CONTRIBUTING.md). Security reports: [SECURITY.md](https://github.com/norwelltw/Tokmizer/blob/main/SECURITY.md).
