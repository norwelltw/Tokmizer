---
description: Show, enable or disable the optional local YOLO mode. Content and diagnostics can be lost.
argument-hint: on | off | status
disable-model-invocation: true
---

Manage YOLO on this machine only. It is off by default and does not sync to other machines.

Describe YOLO as aggressive output reduction for repeated commands where the user accepts incomplete output and can check the result independently. It is unsuitable for debugging, diagnosis, exhaustive code review, audits, or any task that needs complete output. Do not promise faster coding, rendering, or builds. A preserved exit code alone does not verify the result.

Without an explicit `on` or `off` request, show its state:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/bin/tkr.js" yolo status
```

Enable YOLO only when the user explicitly requests YOLO activation. A general request to save tokens, compress more or choose the strongest standard level is not permission to enable YOLO. Before activation, explain: YOLO can discard content and diagnostics, including failed-command output. It creates no new restoration copies and leaves older caches unchanged. Turning it off cannot recover discarded details. Command exit codes are preserved. Then run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/bin/tkr.js" yolo on
```

Disable it immediately when requested:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/bin/tkr.js" yolo off
```

These commands work offline and do not require an account. Print stdout and any warning from stderr. Prefer changing modes between commands. Wrapped terminal commands read the mode before execution; native tool responses use the mode active when their output is received. Output processing that already started in YOLO stays without restoration copies after it is turned off. Previous output caches stay unchanged. Turning YOLO off does not recover discarded content; rerun the original command with YOLO off if the full output is needed and rerunning is safe.

To return to a standard level, use `tkr compression light`, `balanced` or `max`. Each disables YOLO locally before attempting to sync the standard level. If the sync fails, report that failure and the local YOLO state separately.

If the command fails because the plugin files are missing, tokmizer was uninstalled. Offer to clean up: delete the tokmizer-managed `tkr*.md` copies (they end with a `managed-by: tokmizer` marker) from `~/.claude/commands/`.
