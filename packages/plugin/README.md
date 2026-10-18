# Tokmizer

Tokmizer reduces token consumption for 21 AI coding agents, including Claude Code, OpenAI Codex, Cursor, Gemini CLI and GitHub Copilot. Aider, Cline and Windsurf run through `tkr wrap`. Works on macOS, Linux, and Windows.

It shortens command output before it reaches the model, reducing the space it takes in the context window. The reduction depends on the output and the chosen mode. This is not a promise of lower usage costs or faster work.

## Install

In Claude Code:

```
/plugin marketplace add norwelltw/Tokmizer
/plugin install tokmizer@tokmizer
```

Then restart Claude Code once, hooks only load at startup. Verify with `/tkr-status`, you should see Status active.

Any other agent: install the CLI with npm (Node.js 20.11 or newer), then set up every agent found on this machine:

```bash
npm install -g @tokmizer/plugin
tkr setup --all
```

Without Node.js, the install script uses npm when Node.js 20.11 or newer is there and otherwise downloads a standalone build for macOS or Linux, checked against its SHA-256. It leaves your shell profile unchanged. Then run `tkr setup --all`.

```bash
curl -fsSL https://tokmizer.com/install.sh | bash
```

Windows (PowerShell):

```powershell
npm.cmd install -g @tokmizer/plugin
tkr.cmd setup --all
```

See the [installation guide](https://tokmizer.com/en/docs#installation) for per-tool notes.

Codex, after installing with npm or Homebrew:

```bash
tkr setup-codex
```

Restart Codex, then approve the hook in `/hooks`. `tkr setup --all` includes Codex.

If Codex reports `PreToolUse hook returned updatedInput without permissionDecision:allow`, it is running the Claude Code hooks: an older Tokmizer plugin installed in Codex, or hooks copied over by Codex `/import`. Run `tkr doctor --fix`, then approve the Tokmizer hook in `/hooks` and restart Codex.

Cursor or Gemini CLI, after installing with npm or Homebrew:

```bash
tkr setup-cursor
tkr setup-gemini
```

`tkr setup-cursor` adds a `preToolUse` hook to `~/.cursor/hooks.json`; `tkr setup-gemini` adds a `BeforeTool` hook to `~/.gemini/settings.json`. Each hook routes the agent's shell commands through Tokmizer before they run, keeps your other hooks and settings, and saves the file as it was before each change in `~/.tokmizer/backup/config/` (latest copy only). Remove either with `--remove`. Cursor's `afterShellExecution` and Gemini's `AfterTool` events cannot replace command output, so these hooks rewrite the command itself.

Other agents with plugin or hook support:

| Agent | Command | What it installs |
| --- | --- | --- |
| OpenCode | `tkr setup-opencode` | plugin `~/.config/opencode/plugins/tokmizer.js` |
| Kilo Code (CLI and VS Code extension) | `tkr setup-kilo` | plugin `~/.config/kilo/plugin/tokmizer.js` |
| Amp | `tkr setup-amp` | plugin `~/.config/amp/plugins/tokmizer.js` |
| Mistral Vibe | `tkr setup-vibe` | `pre_tool` hook in `~/.vibe/hooks.toml` |
| Antigravity | `tkr setup-antigravity` | `PreToolUse` hook in `~/.gemini/config/hooks.json` |
| OpenClaw | `tkr setup-openclaw` | plugin `~/.openclaw/extensions/tokmizer/`, then `openclaw plugins enable tokmizer` |
| Pi | `tkr setup-pi` | extension `~/.pi/agent/extensions/tokmizer.js` |
| Oh My Pi | `tkr setup-omp` | extension `~/.omp/agent/extensions/tokmizer.js` |
| Hermes | `tkr setup-hermes` | plugin `~/.hermes/plugins/tokmizer/`, then `hermes plugins enable tokmizer` (Hermes v2026.8.16 or newer) |

Each plugin asks `tkr rewrite` for the Tokmizer form of a shell command just before the agent runs it. If `tkr` is missing, slow or fails, the command runs as typed. `XDG_CONFIG_HOME`, `VIBE_HOME`, `PI_CODING_AGENT_DIR` and `HERMES_HOME` are respected. Run the same command with `--remove` to take it out; your other plugins, hooks and settings are kept.

GitHub Copilot, Factory Droid, Trae, Qwen Code, Crush, Junie CLI, ZCode or Grok Build, after installing with npm or Homebrew:

```bash
tkr setup-copilot
tkr setup-droid
tkr setup-trae
tkr setup-qwen
tkr setup-crush
tkr setup-junie
tkr setup-zcode
tkr setup-grok
```

| Command | Agent | File it edits |
|---|---|---|
| `tkr setup-copilot` | Copilot in VS Code and Copilot CLI | `~/.copilot/hooks/tokmizer.json` (or `$COPILOT_HOME/hooks/`) |
| `tkr setup-droid` | Factory Droid | `~/.factory/hooks.json`, or `~/.factory/settings.json` when your own `PreToolUse` hooks live there |
| `tkr setup-trae` | Trae | `~/.trae/hooks.json`, plus `~/.trae-cn/hooks.json` when Trae CN is installed |
| `tkr setup-qwen` | Qwen Code | `~/.qwen/settings.json` (or `$QWEN_HOME`) |
| `tkr setup-crush` | Crush | `~/.config/crush/crush.json` (or `$XDG_CONFIG_HOME/crush/`) |
| `tkr setup-junie` | Junie CLI | `~/.junie/config.json` |
| `tkr setup-zcode` | ZCode | `~/.zcode/cli/config.json` (`hooks.events.PreToolUse`) |
| `tkr setup-grok` | Grok Build 1.0.4 or newer | `~/.grok/hooks/tokmizer.json` |

Each command adds one `PreToolUse` hook for the agent's shell tool. It rewrites the command before it runs, never approves it: the agent keeps asking for permission as usual. Your other hooks and settings stay as they are, the file as it was before each change is saved in `~/.tokmizer/backup/config/` (latest copy only), and `--remove` takes the hook out again. Restart the agent after setup. Crush still reads `crush.json` but now prefers `crushrc`; a `crush.json` with comments is left untouched and reported.

Permission rules stay in force. Agents match their allow, ask and deny rules against the command text, so Tokmizer leaves a command untouched whenever one of your deny or ask rules matches it. Tokmizer reads those rules for Claude Code (`permissions.deny` and `permissions.ask` in user, project, local and managed settings; a command matched by one of your `permissions.allow` rules is left untouched too, so that rule keeps approving it), OpenCode (`permission` in `opencode.json`), Cursor CLI (`permissions.deny`), Gemini CLI (policy files and `tools.exclude`) and Antigravity CLI (`permissions.deny` and `permissions.ask`). For the other agents, and on top of the Cursor, Gemini and Antigravity rules, only inspection, build and test commands (`cat`, `rg`, `git log`, `npm test`, `cargo build` and similar; inspection only for Codex) are routed; anything else, such as `git push` or `rm`, runs exactly as typed. If a settings file cannot be read, nothing is routed. Shell functions, aliases, builtins and anything that is not a program on your `PATH` always run exactly as typed.

In Claude Code, a command is rewritten only when that adds no permission prompt: in `bypassPermissions` mode, or when a plain `Bash` allow rule in your user or managed settings applies and the session is in default, `acceptEdits` or `dontAsk` mode. Otherwise it runs exactly as typed, so Claude Code still approves read-only commands such as `ls`, `cat` or `git status` on its own, and Tokmizer shortens the output once the command has succeeded. Claude Code runs that after-command hook only for successful commands, so in this default mode a failing command reaches Claude in full. A single command typed on its own (no `&&`, `;`, pipe, redirection, `$( )` or wildcard) is also rewritten when one of your own allow rules for it, such as `Bash(pytest:*)` or `Bash(cargo build:*)` in your user or managed settings, applies and no deny or ask rule matches: Tokmizer then gives the approval Claude Code would have given to the command as typed, so no new prompt appears. When commands are rewritten, failing output is shortened too, with its failure details kept.

Aider, Cline and Windsurf have no hooks. Start them through Tokmizer, for example `tkr wrap aider`: only that session goes through Tokmizer's command shims. Your own terminals are not changed; `tkr shim global-path on` routes every terminal through the shims by adding a PATH line to your shell profile, and `tkr shim global-path off` removes it.

Every agent found on this machine at once (each `tkr setup-…` above runs in turn, agents that are not installed are skipped, and a summary ends the run):

```bash
tkr setup --all
```

`tkr setup` without `--all` lists the agents it found and asks which ones to set up.

### Importing your setup from one agent to another

Some agents import another agent's settings (Codex `/import` copies your Claude Code hooks), and config files get copied by hand. Tokmizer hooks are safe to bring along: each one reads which agent is calling it from the hook input and answers in that agent's format; if the input mixes fields of two agents, it changes nothing. Afterwards, run `tkr setup --all` or `tkr doctor --fix`: each agent gets its own Tokmizer hook, the copied ones are removed, your own hooks stay and every changed file is backed up in `~/.tokmizer/backup/config/`. `tkr doctor` also checks a project's `.codex/hooks.json` and `.codex/config.toml`. Junie CLI and ZCode send the same hook input as Claude Code, so a hook copied between those three answers in the format of the agent it was set up for.

Homebrew:

```bash
brew install norwelltw/tokmizer/tokmizer
tkr setup --all
```

The formula brings Node.js with it. Installed with npm or Homebrew, tkr updates itself when a new version is out; `tkr auto-update off` stops that. Restart each agent after its setup, then run `tkr status`. An offline installation reports that free activation is pending; run `tkr status` again when online.

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
- `/tkr-status` shows your account and engine status
- `/tkr-compression` picks the compression level (light, balanced, max)
- `/tkr-yolo on` explicitly enables YOLO on this machine; `/tkr-yolo off` disables it
- `/tkr-reducer` makes the assistant's replies shorter (off, light, balanced, max), in Claude Code and in every agent set up with `tkr setup-<agent>`
- `/tkr-telemetry` views or changes usage stats (command names and token counts; on by default, off in one command)
- `/tkr-update` updates the plugin when a new version is out

From any terminal (after installing with npm, the install script or Homebrew):

- `tkr status` shows your account and engine status
- `tkr gain` shows the estimated reduction in command-output tokens
- `tkr link <key>` connects an optional account
- `tkr unlink` unlinks this machine
- `tkr compression light|balanced|max` picks how hard output gets compressed (default balanced)
- `tkr yolo on|off|status` enables, disables, or checks the local YOLO mode
- `tkr reducer off|light|balanced|max` makes the assistant's replies shorter (default off)
- `tkr settings show|set|configure` manages settings and syncs them across your machines
- `tkr network off|on|status` blocks or allows every connection to tokmizer.com
- `tkr migrate rtk` moves your rtk filters, settings and history over and turns off rtk hooks where Tokmizer runs (see [Switching from rtk to Tokmizer](#switching-from-rtk-to-tokmizer))
- `tkr setup [--all]` sets up the agents found on this machine; `tkr setup-<agent> --remove` takes one out
- `tkr doctor [--fix]` shows what is detected and repairs outdated shims and hooks
- `tkr uninstall` removes every hook, shim and PATH line Tokmizer added (see [Uninstall](#uninstall))

## /power and the reducer in other agents

`tkr setup-<agent>` also installs `/power` and the reducer where the agent offers a documented way to do it; `tkr setup-<agent> --remove` and `tkr uninstall` take them out again. `/power` reads the same synced instructions as in Claude Code (`~/.tokmizer/skills/power.md`, refreshed by `tkr heartbeat`) and runs only the steps the agent's tools allow: it says what is left when it cannot run tests, commit or open a pull request. The reducer uses the same ruleset, word for word, in every agent and follows the single `tkr reducer off|light|balanced|max` setting.

| Agent | `/power` | Reducer |
| --- | --- | --- |
| Claude Code | native: `/power` command | native: SessionStart and UserPromptSubmit hooks |
| Codex | skill `~/.agents/skills/power`, type `$power <request>` | native: SessionStart and UserPromptSubmit hooks (approve them in `/hooks`) |
| Gemini CLI | native: `~/.gemini/commands/power.toml` | native: SessionStart and BeforeAgent hooks |
| Cursor | skill `/power` (`~/.agents/skills`) | native: sessionStart hook (no per-prompt context hook exists) |
| GitHub Copilot CLI | skill `/power` (`~/.agents/skills`) | native: sessionStart hook (per-prompt hook output is dropped by Copilot) |
| Factory Droid | skill `/power` (`~/.agents/skills`) | native: SessionStart and UserPromptSubmit hooks |
| Qwen Code | native: `~/.qwen/commands/power.md` | native: SessionStart and UserPromptSubmit hooks |
| ZCode | skill `/power` (`~/.zcode/skills`) | native: SessionStart and UserPromptSubmit hooks |
| Trae | not possible: no documented location for custom commands or skills | native: SessionStart and UserPromptSubmit hooks |
| Antigravity | skill `/power` (`~/.gemini/config/skills`) | native: SessionStart hook (system message) |
| Crush | skill `user:power` in the command palette (`~/.agents/skills`) | via rules: managed block in `~/.config/crush/CRUSH.md` (no session or prompt hook) |
| Junie CLI | native: `~/.junie/commands/power.md` | via rules: managed block in `~/.junie/AGENTS.md` (session-start context is ignored) |
| Grok Build | skill `/power` (`~/.grok/skills`) | via rules: managed block in `~/.grok/AGENTS.md` (hook output is ignored) |
| Mistral Vibe | skill `/power` (`~/.vibe/skills`) | via rules: managed block in `~/.vibe/AGENTS.md` (no session or prompt hook) |
| OpenCode | native: `~/.config/opencode/commands/power.md` | via plugin: system prompt, experimental `experimental.chat.system.transform` hook |
| Kilo Code | native: `~/.config/kilo/commands/power.md` | via plugin: system prompt, experimental `experimental.chat.system.transform` hook |
| Amp | skill `power` (`~/.agents/skills`); ask Amp to use it, Amp has no custom slash commands | via rules: managed block in `~/.config/amp/AGENTS.md` |
| Pi | native: `~/.pi/agent/prompts/power.md` | via rules: managed block in `~/.pi/agent/APPEND_SYSTEM.md` |
| Oh My Pi | native: `~/.omp/agent/commands/power.md` | via rules: managed block in `~/.omp/agent/APPEND_SYSTEM.md` |
| Hermes | skill `/power` (`~/.hermes/skills`) | via plugin: system prompt section |
| OpenClaw | skill `/power` (`~/.openclaw/skills`) | via plugin: `before_prompt_build`, once you set `plugins.entries.tokmizer.hooks.allowConversationAccess` to `true` |
| Cline, Windsurf, Aider | not installed: these agents only get command shims and have no `tkr setup-<agent>` command | not installed |

Never overwritten: an existing `power` command or skill that Tokmizer did not write is left as it is and reported. Rules files keep your text; Tokmizer only edits the block between `<!-- tokmizer:begin managed-by: tokmizer -->` and `<!-- tokmizer:end -->`, saves the file as it was before each change in `~/.tokmizer/backup/config/`, and rewrites that block when the reducer setting or its ruleset changes (`tkr reducer`, `tkr settings`, or a heartbeat). With the reducer off the block is removed, and it comes back when you turn the reducer on. When several agents read the same rules file through symlinks, the block stays until the last of them is removed. The shared `~/.agents/skills/power` skill stays while another agent that reads it is still set up. The OpenCode, Kilo Code, Hermes and OpenClaw plugins read the active ruleset from `~/.tokmizer/reducer-context.txt` (under `TOKMIZER_HOME` when set) without starting a process; Tokmizer rewrites that file when the reducer changes and deletes it when the reducer is off. `tkr uninstall` also deletes these backups.

## Choosing a compression mode

Choose `light` for gentle reduction, `balanced` (the default) for more compact output, or `max` for the strongest standard reduction. The aliases `normal`, `compact`, and `minimal` map to these levels respectively. Short or exact output can be identical across levels.

Since 0.9.54, Light keeps recognized file reads of up to 16 KB complete; larger reads are shortened again. Balanced and Max can fold code bodies. Choose Light when you need implementation details. Explicit outlining remains available to callers that request it. Host limits and the CLI's output buffer still apply.

Since 0.9.52, short code reads and small explicit excerpts stay complete by default in all three standard modes. Larger reads can still be shortened. Recognized failures retain their diagnostics; Max can summarize repeated log lines with an occurrence count. Distinct diagnostic messages and command exit codes are preserved.

Without a linked account, standard settings stay on this machine and work offline after initial activation. With a linked account, changes require a connection and sync across machines. Linking an account restores its server settings.

The separate `reducer` setting provides response-style instructions, starting with the next session, for Claude Code and for every agent set up with its `tkr setup-<agent>` command (see the table below). The instructions ask the model to preserve code, errors, and security information; compliance and actual savings depend on the model. If the ruleset is unavailable, the CLI reports it instead of claiming activation. Reconnect and run `tkr heartbeat` before starting a new session.

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

`tkr gain` measures output size before and after compression and estimates tokens as UTF-8 bytes divided by four. Token and cost figures are estimates about command output, not a measure of your actual API usage, task quality or completion speed.

Since 0.9.53, successful `tkr restore` calls are counted as additional output in the local gain history, even with telemetry disabled. They reduce the net saving; repeated restorations count again and can make it negative. The display shows restored tokens separately. `gain --json` exposes the net estimate in `observed.savedTokens` and restoration totals in `restoration`; the existing top-level `savedTokens` remains the total for reduced outputs only. Earlier restorations cannot be reconstructed from local history. Manually repeated commands, prompts, replies and replayed conversation context are not attributed to restoration costs.

Other local views: `tkr gain --by-rule` groups savings by rule (your custom filters by name, built-in rules by command), `tkr gain --failures` lists commands whose output went through unchanged and why (no rule, nothing to cut, failed run kept in full), and `tkr gain --quota [pro|5x|20x]` estimates the share of a Claude plan budget the savings represent. The quota view is an estimate, not a plan limit: tokens saved per day × 30, divided by an assumed 44,000 tokens per 5-hour window × 144 windows × the plan multiplier (1, 5 or 20). Anthropic does not publish plan limits in tokens. All three combine with a period, `--project` and `--json`.

The percentages in `tkr gain` measure byte reduction. A byte percentage can differ substantially from the reduction counted by a model's tokenizer. Restoring a full file after reading its outline can cost more tokens than reading it once. Compression is not a promise of faster task completion or a correct answer.

## Restoring shortened output

When Tokmizer shortens an output it can add a `[tkr restore <hash>]` hint. `tkr restore <hash>` prints the complete original output when it is at most 8 MB, except detected secrets, which are masked; for a larger output, the entry holds only the part that was left out and `tkr restore` says so. A unique prefix of the hash is enough.

| Command | Effect |
| --- | --- |
| `tkr restore <hash>` | Print the cached output |
| `tkr restore <hash> --lines 120:180` | Print only lines 120 to 180 (`120:`, `:40` and `57` also work) |
| `tkr restore <hash> --grep <pattern>` | Print matching lines with their line numbers |
| `tkr restore --grep <pattern>` | Search the cached outputs of the current project |
| `tkr restore --grep <pattern> --all-projects` | Search the cached outputs of every project |
| `tkr restore --list` | List this project's cached outputs with age, size, line count and command (`--all-projects` for every project) |

Before a copy is saved, private keys, GitHub, npm, AWS, Slack and Stripe live tokens, `Authorization: Bearer` values and passwords in URLs are replaced by `[tkr: secret masked]`; the output your agent sees is unchanged. Entries are kept 30 days, up to 8 MB each and 200 MB in total; the oldest go first. `TOKMIZER_CCR_MAX_AGE_MS`, `TOKMIZER_CCR_ENTRY_MAX_BYTES` and `TOKMIZER_CCR_DIR_CAP_BYTES` change these limits, `TOKMIZER_CCR_DISABLED=1` turns copies off. `tkr gain` shows the restored tokens and the cache size.

## Measured comparison

On October 9, 2026, a fixed set of 30 real and synthetic command outputs contained 774,863 tokens before compression. The table counts tokens with the cl100k tokenizer, excluding restoration notices. It is a test corpus, not a sample of customer usage.

These are historical results for the earlier mode behavior, not measurements of the Light read policy introduced in 0.9.54.

| Mode | Output tokens | Preservation checks passed |
| --- | ---: | ---: |
| `light` | 112,816 | 85 / 85 |
| `balanced` | 102,052 | 85 / 85 |
| `max` | 93,131 | 85 / 85 |
| YOLO | 1,925 | 44 / 85 |

The 85 checks cover 13 of the 30 cases. The other 17 have no complete preservation checks, so these results do not prove universal fidelity. YOLO's smaller output comes with observed information loss.

The result also depends on the output. In a separate set of five JSON examples, `light` produced 285 tokens, `balanced` 253, and both `max` and YOLO 197. YOLO does not always save more than `max`.

In one real failed test, `max` kept 302 tokens and YOLO kept 77. Both retained the actual and expected values. YOLO removed the explanation about invoice 42 and the location `payment.test.mjs:4:10`, which were retained by `max`. That missing context can matter when fixing the failure.

In a separate controlled test for 0.9.52, a repetitive failure log went from 1,094 to 84 tokens in Max (92.3% fewer, counted with cl100k). Every distinct diagnostic and the repetition counts were retained. This result applies to that example, not to typical usage.

These tokenizer counts are separate from the byte-based estimates in `tkr gain`. They measure output volume, not API usage, an agent's task success, or execution speed. See the [mode guide](https://tokmizer.com/en/docs#configuration) for usage and limits.

### Benchmark of October 17, 2026

Each tool's Claude Code hook chain replayed 68 real command outputs offline (network cut, empty home folder, no account, median of 3 runs) with Tokmizer 0.9.60 and its default settings, against rtk 1.0.1. Tokmizer removed 84% of tokens in Claude Code's default mode and up to 93% when commands are rewritten (`bypassPermissions` or a blanket `Bash` allow); rtk removed 55%. All 307 failure details were kept in both Tokmizer modes. A later offline run of the same 68 cases with Tokmizer 0.9.63, counted with Anthropic's legacy tokenizer rather than o200k_base, gave 84.2% in the default mode without allow rules, 92.8% in the default mode with narrow allow rules for the test and build commands and 93.5% in `bypassPermissions`, against 57.2% for rtk; 307/307 failure details were kept in every Tokmizer mode. The full results are on [tokmizer.com/en/compare/rtk](https://tokmizer.com/en/compare/rtk).

## Custom filters

Add your own output rules as `*.toml` files in `~/.tokmizer/filters/` (or `$TOKMIZER_HOME/filters/`). They load next to the built-in rules and win over them for the commands they match. They stay on your machine and are never uploaded. A file or rule that fails validation is skipped; `tkr doctor` shows what was loaded and why something was skipped.

A file is used only after you trust it: review it, then run `tkr filters trust` (all files) or `tkr filters trust <file>`. Tokmizer records the file's SHA-256; editing the file stops it from being used until you trust it again. `tkr filters untrust [file]` removes the trust.

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

`schema_version` is optional; a version this tkr cannot read makes the file skipped with a message. `tkr filters test [rule]` runs the inline tests, including on files you have not trusted yet, and exits with 1 when one fails. Tests check the rule as written (the Light level) and ignore trailing whitespace; Balanced and Max shorten `max_lines` further.

`match_command` is a regular expression tested against the command line. `strip_lines_matching` drops matching lines, `max_lines` caps the number of lines kept and `on_empty` replaces an empty result. Also available: `strip_ansi = true`, `keep_failures = true` (failure lines survive the cap), `truncate_lines_at = 400`, and `priority = 60` to pick between several of your rules that match the same command.

## Switching from rtk to Tokmizer

If you already use rtk, one command brings over what can be brought over and stops commands from going through two hooks:

```sh
tkr migrate rtk            # show the plan, then ask before changing anything
tkr migrate rtk --dry-run  # only show the plan
tkr migrate rtk --yes      # apply without asking
tkr migrate rtk --undo     # put back every file the migrations changed, newest first
```

- **Filters.** rtk's global `filters.toml` (`~/.config/rtk/` on Linux, `~/Library/Application Support/rtk/` on macOS, `%APPDATA%\rtk\` on Windows) and the project's `.rtk/filters.toml` become files in `~/.tokmizer/filters/`. Their `[[tests]]` run again on Tokmizer and each result is printed. A filter that uses an option Tokmizer filters do not have (`replace`, `match_output`, `keep_lines_matching`, `head_lines`, `tail_lines`, `filter_stderr`) is not imported, and the plan says why. A file rtk had trusted stays trusted; the others, and project files (Tokmizer filters apply in every project), wait for `tkr filters trust`.
- **Settings.** From `config.toml`: `exclude_commands` (the output of those commands is left unchanged), the `rtk recall` retention or its `disabled` mode (`~/.tokmizer/restore.json`), and telemetry turned off (`tkr telemetry off`). Every other setting is listed as not imported.
- **History.** The totals in rtk's `history.db` are read without changing it. `tkr gain` shows them on their own "Imported from rtk" line, never added to the savings Tokmizer measured. An unreadable file is skipped.
- **Agent hooks.** For each agent where both rtk and Tokmizer are installed (Claude Code, Codex, Cursor, Gemini CLI, GitHub Copilot, Factory Droid, Trae, Mistral Vibe, Antigravity, OpenCode, Pi, Oh My Pi), the rtk hook is removed so commands are not wrapped twice. Where Tokmizer is not installed yet, the rtk hook stays and the plan says which `tkr setup-…` to run first. rtk's own proxy setting (`ANTHROPIC_BASE_URL`) is left alone. `tkr doctor` reports any agent where both still hook the same commands.

Every changed file is backed up under `~/.tokmizer/migrate-rtk/`. Running `--yes` again changes only what is new since the last migration and says `Already migrated` when nothing is; `--undo` reverts every migration still in place, newest first, and does not overwrite a file you changed after the migration: it tells you where its backup is.

`tkr migrate rtk --shim` also adds an `rtk` command to `~/.tokmizer/shims` for scripts and habits: `rtk gain` runs `tkr gain`, `rtk recall <hash>` runs `tkr restore <hash>`, `rtk bypass <cmd>` (or `rtk proxy <cmd>`) runs the command unchanged, and any other subcommand explains what to run instead. It takes over once rtk itself is uninstalled and `~/.tokmizer/shims` is on your `PATH`.

## Distribution

This README is shared by the npm package and the public GitHub repository.

- The npm package includes the CLI, Claude Code hooks and command templates, the Codex manifest and the compiled compression engine.
- The public repository contains the full source of the package: CLI, hooks, agent adapters, native launcher, setup commands, the TOML rule catalogue and the compression engine.

## Build from source

Requirements: Node.js 20.11 or later and npm. The native launcher is optional and needs a Rust toolchain.

```
git clone https://github.com/norwelltw/Tokmizer
cd Tokmizer
npm install
npm run build
npm test
```

`npm run build` type-checks the sources and bundles them into `packages/plugin/dist/`. Run the result with `node packages/plugin/dist/bin/tkr.js help`.

To build the native launcher for your platform: `npm --workspace packages/plugin run build:native`, then `npm run build` again to copy it into `dist/native/`.

To try your build in Claude Code, install the folder as a local plugin or link the CLI with `npm --workspace packages/plugin link`.

## Network & privacy

Tokmizer works without an account or email. It contacts `tokmizer.com` to keep its rules up to date and to improve the product. One command turns all of it off: `tkr network off`.

What leaves your machine, and when:

| When | What is sent | Why |
|---|---|---|
| First online run, no account | A random install ID, your computer name, OS and version, CPU model and core count, a SHA-256 hash of your network card (MAC) address, a SHA-256 hash of your user name, a fingerprint (SHA-256 of all of these), your time zone and the plugin version | Create the install token used to download rules |
| `tkr link <key>` | The same, plus your key, and your email only if you pass `--email` | Attach this machine to your account |
| Regular check-in (heartbeat) | Install ID, fingerprint, plugin version, local date and time zone; while usage stats are on, also install health counts, for example outdated shims, broken hooks, repairs and commands that ran without Tokmizer because its files were missing | Refresh access, learn that a new version is out and spot broken installs |
| Rule downloads | Install ID, fingerprint, plugin version | Get the latest compression rules and the `/power` and reducer instructions |
| Settings sync, linked accounts only | Your Tokmizer settings | Keep them in sync with the dashboard |
| Usage stats, only while they are on (with or without an account) | Command names such as `npm install` (never arguments; Git and GitHub commands only as the tool and its action, such as `git push` or `gh pr`), token counts, rule IDs with output sizes, session ID, agent name | See which commands to optimize next |
| `tkr unlink` | Install ID, fingerprint | Remove this device from your account |
| CLI self-update, after a check-in reports a new version | Runs `npm i -g @tokmizer/plugin@<version>` or `brew upgrade tokmizer`, which contact the npm registry, Homebrew and GitHub | Keep the CLI current (`tkr auto-update off` stops only this) |

The hashes are not anonymous: the same machine always gives the same values, and a user name hash can be guessed. Like any web server, `tokmizer.com` sees your IP address and keeps it in its security log. Tokmizer never sends command arguments, command output, file contents or file paths.

Usage stats are on by default and off in one command: `tkr telemetry off` (or `tkr network off` to stop every connection). The choice is saved on this machine and survives updates; an install that turned them off stays off. Before anything is sent, Tokmizer says so once, in the terminal or in the Claude Code session notice. Check with `tkr telemetry status`.

### Usage stats without an account

Usage stats do not need an account. Without one, they are stored against this install's random key, not against an email or a person. They are still not anonymous: the computer name and the other device details listed above are sent when the install registers and are kept with that key.

- **Sent:** for each command, its name, the token count before compression, tokens saved and restored, whether it was compressed, the session ID and the agent name. Never arguments, output, file contents or paths.
- **Only with your consent:** the plugin uploads them only while `tkr telemetry status` says `on`, and tells the server so with each upload. Nothing is accepted from an install that is off or whose network is off.
- **Once per install, before the first upload:** Tokmizer says so once (first run, setup, session start or upgrade) and sends nothing until that notice has been shown, then stays quiet.
- **Kept:** detailed rows for 90 days, then only a running total of tokens saved per key.
- **Linking later:** `tkr link` moves the install's past usage stats to your account, so your dashboard includes them.
- **Turn off:** `tkr telemetry off`. To stop every connection: `tkr network off`.

### Turn the network off

```bash
tkr network off      # nothing leaves this machine
tkr network status
tkr network on
```

In CI or for one shell, set `TOKMIZER_NETWORK=0`. `tkr status` and `tkr doctor` show the current state.

While it is off there is no sign-up, heartbeat, rule download, settings sync, usage stats or update check. Tokmizer keeps compressing locally: with the last downloaded rules for up to 7 days, then with the rules built into the CLI. Settings are saved on this machine only. `tkr link` and `tkr heartbeat` explain how to turn the network back on.

The switch does not cover Claude Code's own marketplace auto-update, which `/tkr-update` turns on (set `extraKnownMarketplaces.tokmizer.autoUpdate` to `false` in `~/.claude/settings.json` to stop it), nor commands you run yourself such as the installer, `/tkr-update`, npm or brew.

### Local data

- Restoration copies are local and kept up to 30 days. A restore hint identifies available cached content; there is no guarantee that every removed detail has a saved copy. YOLO creates no new restoration copies.
- The [redaction helpers](https://github.com/norwelltw/Tokmizer/blob/main/packages/plugin/src/learn/redact.ts) are available for inspection, like the rest of the source.
- Local state lives in `~/.tokmizer/`.

## Uninstall

```bash
tkr uninstall
```

`tkr uninstall` removes every hook, shim and PATH line Tokmizer added, `/power` and the reducer in the other agents, and the config backups. It does not remove the program itself. Then run the command for the way you installed it:

```bash
npm uninstall -g @tokmizer/plugin
brew uninstall tokmizer
```

In Claude Code: `/plugin uninstall tokmizer@tokmizer`. Your savings history stays in `~/.tokmizer` until you delete that folder. To pause Tokmizer without uninstalling: `tkr settings set enabled false`.

## License

Apache-2.0, except the compression engine in `src/engine/` and the rule catalogue in `filters/`, which are under the Business Source License 1.1 and become Apache-2.0 four years after each release. Production use is allowed, including inside your own tools; offering the engine or the rules as part of a competing token-optimization product or hosted service is not. Rules you write yourself stay yours. See [LICENSES.md](LICENSES.md), [LICENSE](LICENSE), [LICENSE-ENGINE](LICENSE-ENGINE) and [NOTICE](NOTICE).
