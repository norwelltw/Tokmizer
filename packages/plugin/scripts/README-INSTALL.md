# Installing Tokmizer on any AI coding tool

Tokmizer works with **Claude Code, OpenAI Codex, Cursor, Cline, Aider, Gemini CLI, Windsurf, and GitHub Copilot** — on **macOS, Linux, and Windows**.

Claude Code, Codex, Cursor, Gemini CLI, GitHub Copilot, Factory Droid, Trae, Qwen Code, Crush, Junie CLI, ZCode, Grok Build and Kilo Code use native hooks or plugins (`tkr setup-<tool>` installs them; see the table below). Aider, Cline and Windsurf have no hook system: Tokmizer reaches them through command shims that are active only inside the agent, never in your own terminals. Tokmizer does not edit your shell profile. Node.js 24.22.1 or newer (or 22.23.4+) is required for npm installation. Tokmizer is free and requires no account.

## macOS / Linux

```bash
curl -fsSL https://tokmizer.com/install.sh | bash
```

Without Node.js, the script installs the standalone executable and first checks the release signature with OpenSSL 3 or `ssh-keygen -Y verify` (OpenSSH 8.1+, included in macOS). If neither tool is available, the installation stops. To install anyway with only the SHA256SUMS checksums, at your own risk:

```bash
curl -fsSL https://tokmizer.com/install.sh | TOKMIZER_ALLOW_UNSIGNED=1 bash
```

`TOKMIZER_REQUIRE_SIG=1` keeps the signature mandatory even when `TOKMIZER_ALLOW_UNSIGNED=1` is set.

## Windows (PowerShell)

```powershell
npm.cmd install -g @tokmizer/plugin
```

Claude Code users can also install via the marketplace (see Per-tool notes below).

## npm (macOS / Linux)

```bash
npm install -g @tokmizer/plugin
```

## Homebrew

```bash
brew install norwelltw/tokmizer/tokmizer
```

## Per-tool notes

| Tool          | Adapter         | Setup                                                          |
|---------------|-----------------|----------------------------------------------------------------|
| Claude Code   | Native hooks    | `/plugin marketplace add norwelltw/Tokmizer` then `/plugin install tokmizer@tokmizer`. Without Node.js, `install.sh` runs `tkr setup-claude` for you (`tkr setup-claude --remove` undoes it) |
| Codex CLI     | Native hook     | Install tkr (npm or brew), run `tkr setup-codex`, restart Codex, then approve in `/hooks` |
| Cursor        | Native hook     | Install tkr (npm or brew), run `tkr setup-cursor`, then restart Cursor. |
| Cline         | Agent shims     | Start VS Code from a terminal with `tkr wrap --host cline code .`, or add the workspace setting below. |
| Aider         | Agent shims     | Start it with `tkr wrap aider [args]`.                          |
| Gemini CLI    | Native hook     | Install tkr (npm or brew), run `tkr setup-gemini`, then restart Gemini CLI. |
| Windsurf      | Agent shims     | Start it from a terminal with `tkr wrap --host windsurf windsurf .`, or add the workspace setting below. |
| GitHub Copilot| Native hook     | Install tkr (npm or brew), run `tkr setup-copilot`, then restart VS Code or Copilot CLI. |
| Factory Droid | Native hook     | Run `tkr setup-droid`, then restart Droid.                      |
| Trae          | Native hook     | Run `tkr setup-trae`, then restart Trae.                        |
| Qwen Code     | Native hook     | Run `tkr setup-qwen`, then restart Qwen Code.                   |
| Crush         | Native hook     | Run `tkr setup-crush`, then restart Crush.                      |
| Junie CLI     | Native hook     | Run `tkr setup-junie`, then restart Junie.                      |
| ZCode         | Native hook     | Run `tkr setup-zcode`, then restart ZCode.                      |
| Grok Build    | Native hook     | Run `tkr setup-grok`, then restart Grok Build (1.0.4 or newer). |
| Kilo Code     | Plugin          | Run `tkr setup-kilo`, then restart Kilo Code.                   |
| Plain shell   | None by default | Your terminals are left alone. To route every terminal through Tokmizer anyway: `tkr shim global-path on` (undo: `tkr shim global-path off`). |

Run `tkr status` after installation. If activation is pending because the service could not be reached, rerun `tkr status` when online. Connecting an account is optional: `tkr link <your-key>`.

## Agents without hooks

`tkr wrap [--host aider|cline|windsurf] <command> [args]` starts the agent with the shim folder first on its `PATH` and `TOKMIZER_HOST` set, so only that agent and the commands it runs go through Tokmizer.

For Cline and Windsurf (both run commands in the editor terminal), the same can be set per workspace in `.vscode/settings.json`. Replace `HOME` with your home folder and use `terminal.integrated.env.linux` on Linux:

```json
{
  "terminal.integrated.env.osx": {
    "PATH": "HOME/.tokmizer/shims:${env:PATH}",
    "TOKMIZER_HOST": "cline"
  }
}
```

Shims never call a versioned install folder. They go through `~/.tokmizer/bin/tkr-shim-launch`, which finds the current install at run time. If no install is found, the command runs unchanged and prints a one-line hint to run `tkr doctor --fix`.

## Repair and upgrades

`tkr doctor` lists outdated shims, old PATH lines in your shell profile and hooks that point at a removed install. `tkr doctor --fix` repairs them. Each edited shell profile is first copied to `~/.tokmizer/backup/rc/` (private to you), and only the exact two lines Tokmizer wrote are removed. `tkr shim global-path on` puts them back.

If an old version left your shell unable to run commands (`Error: Cannot find module .../tkr-shim.js`), run this in any terminal; it needs no Node.js and no network:

```bash
mv ~/.tokmizer/shims ~/.tokmizer/shims.off
```

Then open a new terminal, update Tokmizer, and run `npx -y -p @tokmizer/plugin@latest tkr doctor --fix` (or `tkr doctor --fix`) to remove the old PATH line.

## Choose a mode

`balanced` is the default compression level. Use `tkr compression light`, `balanced`, or `max` to change it.

YOLO is separate, off by default, and enabled only by an explicit `tkr yolo on`. It stays on this machine and does not sync. Use it for repeated commands only when incomplete output is acceptable and you can check the result independently. Turn it off with `tkr yolo off` before debugging, diagnosis, exhaustive code review, or audits.

YOLO can discard useful details, including failed-command output. It creates no new restoration copies, leaves the existing cache unchanged, and cannot recover discarded details when turned off. Change modes between commands. It does not promise faster coding, rendering, or builds.

See the [mode guide and measured comparison](https://tokmizer.com/en/docs#configuration).
