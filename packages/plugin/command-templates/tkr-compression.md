---
description: Show or change the Tokmizer compression level (light, balanced, max).
argument-hint: light | balanced | max
disable-model-invocation: true
---

Manage the user's Tokmizer compression level.

If the user already named a level in their request (light, balanced or max), apply it directly. Otherwise, first show the current level:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/bin/tkr.js" compression
```

Then ask the user to pick a level using the AskUserQuestion tool (single choice, three options):

- `light` — gentle: standard cleanup only
- `balanced` — default: also collapses repeated output and blank runs
- `max` — strongest standard level: also drops verbose log noise

Mark the current level in the option labels (e.g. "balanced (current)"). After they pick, apply it:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/bin/tkr.js" compression <level>
```

Print the output as is. For a linked account, standard levels sync across machines and changing them requires a connection. Without a linked account, they are saved locally and can be changed offline after initial activation. The aliases normal, compact and minimal map to light, balanced and max. Selecting any standard level first disables YOLO on this machine, even if syncing then fails. Report a sync failure separately from YOLO being disabled. Short or exact output can be identical across levels.

YOLO is a separate, optional local mode, managed with `/tkr-yolo` or `tkr yolo on|off|status`. It can discard content and diagnostics, including failed-command output; discarded output cannot be restored. Command exit codes are preserved. Never enable YOLO automatically because the user asks to save more tokens. Only activate it after an explicit request for YOLO, and explain the warning before running the command. The standard levels keep failed-command output when YOLO is off.

If the command fails because the plugin files are missing, tokmizer was uninstalled. Offer to clean up: delete the tokmizer-managed `tkr*.md` copies (they end with a `managed-by: tokmizer` marker) from `~/.claude/commands/`.
