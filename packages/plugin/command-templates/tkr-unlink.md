---
description: Unlink this machine from your Tokmizer account (it keeps working without an account).
disable-model-invocation: true
---

Unlink the local plugin from the user's Tokmizer account.

Run the bundled CLI:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/bin/tkr.js" unlink
```

Print the output as is. After unlinking, the plugin keeps working without an account; a new install token is created on the next online run. To link another account, the user runs `tkr link` with the key from their dashboard.

If the command fails because the plugin files are missing, tokmizer was uninstalled. Offer to clean up: delete the tokmizer-managed `tkr*.md` copies (they end with a `managed-by: tokmizer` marker) from `~/.claude/commands/`.
