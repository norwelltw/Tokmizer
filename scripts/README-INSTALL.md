# Installing Tokmizer on any AI coding tool

Tokmizer works with **Claude Code, OpenAI Codex, Cursor, Cline, Aider, Gemini CLI, Windsurf, and GitHub Copilot** — on **macOS, Linux, and Windows**.

Claude Code and Codex use native hooks. Other tools can use command wrappers configured by `tkr shim install`. Node.js 20.11 or newer is required for npm installation. Tokmizer is free and requires no account.

## macOS / Linux

```bash
curl -fsSL https://tokmizer.com/install.sh | bash
```

## Windows (PowerShell)

```powershell
npm.cmd install -g @tokmizer/plugin
tkr.cmd shim install
```

Claude Code users can also install via the marketplace (see Per-tool notes below).

## npm (macOS / Linux)

```bash
npm install -g @tokmizer/plugin && tkr shim install
```

## Homebrew

```bash
brew install norwelltw/tokmizer/tokmizer && tkr shim install
```

## Per-tool notes

| Tool          | Adapter         | Setup                                                          |
|---------------|-----------------|----------------------------------------------------------------|
| Claude Code   | Native hooks    | `/plugin marketplace add norwelltw/Tokmizer` then `/plugin install tokmizer@tokmizer` |
| Codex CLI     | Native hook     | Install tkr (npm or brew), run `tkr setup-codex`, restart Codex, then approve in `/hooks` |
| Cursor        | Shell-shim      | Open a new terminal after install.                             |
| Cline         | Shell-shim      | Open a new terminal after install.                             |
| Aider         | Shell-shim      | Open a new terminal after install.                             |
| Gemini CLI    | Shell-shim      | Open a new terminal after install.                             |
| Windsurf      | Shell-shim      | Open a new terminal after install.                             |
| GitHub Copilot| Shell-shim      | Open a new terminal after install.                             |
| Plain shell   | Shell-shim      | Works out of the box.                                          |

Open a new terminal after installation and run `tkr status`. If activation is pending because the service could not be reached, rerun `tkr status` when online. Connecting an account is optional: `tkr link <your-key>`.
