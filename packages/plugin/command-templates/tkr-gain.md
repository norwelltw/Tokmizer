---
description: Show estimated token reductions in recorded tool outputs.
argument-hint: [--day | --week | --month] [--project [path]] [--csv | --graph | --history | --by-rule | --failures | --quota [pro|5x|20x]]
disable-model-invocation: true
---

Show the user Tokmizer's recorded tool-output reductions.

Run the bundled CLI:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/bin/tkr.js" gain
```

Choose the scope the user requested:

- Default: `gain` for all recorded activity, with today, last 7 days and all-time lines.
- Today or `--day`: `gain --day` for the current local calendar day.
- Last seven days or `--week`: `gain --week`.
- Last thirty days or `--month`: `gain --month`.
- Only this project (or a given directory): add `--project` or `--project <path>`. It covers the live local journal only; older rotated history is not included, and commands recorded before this field existed are excluded.
- Export or alternative views, combinable with a period: `--csv` (one row per day), `--graph` (per-day bar chart, default last 30 days), `--history` (last 20 recorded commands).
- Savings per rule: `--by-rule` (custom filters by name, built-in rules grouped by command).
- Commands left unchanged and why: `--failures`.
- Share of a Claude plan budget: `--quota`, optionally followed by `pro`, `5x` or `20x` (default `pro`, last 30 days unless a period is given). Only when the user asks for it; it is a labelled estimate with its formula, not a plan limit.
- This session: `session` for session coverage. This command reports routing counts, not token or dollar savings.

Show the CLI output verbatim inside a fenced code block: do not summarize, translate, reformat or rebuild it as a table. After the block, add at most one short sentence. Keep its measurement scope and caveats. Token counts are estimates from output bytes, not model tokenizer counts. Dollar values use reference input prices and do not measure a bill reduction. Percentages apply only to the recorded tool outputs, not all tokens used by the agent.

Keep modeled reducer estimates separate from observed output reductions. Do not add them together, invent replay or repeated-context savings, or infer avoided model calls. Do not turn a period's estimate into a monthly projection or paid-plan payback, except the projection printed by `--quota`, kept with its estimate label. A comparison with another optimizer requires measurements on the same workload; these local totals alone do not establish one.

If the output shows zero activity, report that no activity was recorded in the selected scope. This does not establish whether the optimizer is configured or running.

If the command fails because the plugin files are missing, tokmizer was uninstalled. Offer to clean up: delete the tokmizer-managed `tkr*.md` copies (they end with a `managed-by: tokmizer` marker) from `~/.claude/commands/`.
