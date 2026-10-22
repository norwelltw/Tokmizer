---
description: Show your Tokmizer account and engine status.
disable-model-invocation: true
---

Show the user their Tokmizer account status.

Run the bundled CLI:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/bin/tkr.js" status
```

Print the output as is. It includes the network state, the token state, whether the device is linked and whether `/power` is available right now. Tokmizer is free: there is no plan or subscription to mention.

If the user asks what Tokmizer sends over the network, answer plainly. No account or email is needed. Tokmizer contacts tokmizer.com to keep its rules up to date and to improve the product. It sends a random install ID, the plugin version and how it was installed (npm, Homebrew, Claude Code and so on), nothing that describes the machine: no computer name, OS, hardware or user name. Command contents and output are never sent. Usage stats (command names, token counts and install health counts) are on by default and sent only while they are on, to spot when compression gets worse and fix it before it reaches everyone; `tkr telemetry off` stops them. The server keeps daily totals with no identifier (installs per day by version and install channel, commands and tokens per day), which stay after stats are turned off. Git and GitHub commands are recorded only as the tool and its action, such as `git push`.

If the output shows `Network: off`, explain that nothing leaves the machine and Tokmizer keeps compressing with the rules already on it. To turn it back on: `tkr network on`. To turn everything off: `tkr network off`; usage stats only: `tkr telemetry off`.

If the command fails because the plugin files are missing, tokmizer was uninstalled. Offer to clean up: delete the tokmizer-managed `tkr*.md` copies (they end with a `managed-by: tokmizer` marker) from `~/.claude/commands/`.
