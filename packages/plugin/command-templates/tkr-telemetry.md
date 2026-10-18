---
description: Show or change Tokmizer usage stats (status, on, off, forget).
argument-hint: status | on | off | forget
---

Manage the user's Tokmizer telemetry preference.

Pick the subcommand from the user's request. Default to `status` when they only ask to see it.

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/bin/tkr.js" telemetry status
```

- `telemetry status` shows whether usage stats are on or off, the network state, whether an account is linked, what is sent and the local record count.
- `telemetry on` turns it on.
- `telemetry off` turns it off.
- `telemetry forget` erases telemetry data stored on this machine.

Print the output as is. If the user asks what is collected, tell them: command names and token counts only, never arguments, output or file contents. Like every request to tokmizer.com, they come with the install ID and a fingerprint of the machine, so they are not anonymous. They are sent with or without an account; without one they are tied to the install's key, and linking an account later moves them to it. Detailed rows are kept 90 days. The online dashboard at https://tokmizer.com needs telemetry on to show savings. To stop every connection, not only usage stats, the user runs `tkr network off`.

If the command fails because the plugin files are missing, tokmizer was uninstalled. Offer to clean up: delete the tokmizer-managed `tkr*.md` copies (they end with a `managed-by: tokmizer` marker) from `~/.claude/commands/`.
