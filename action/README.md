# Tokmizer in GitHub Actions

Shorter command output for Claude Code when it runs in CI with
[`anthropics/claude-code-action`](https://github.com/anthropics/claude-code-action).

```yaml
name: Claude
on:
  issue_comment:
    types: [created]

jobs:
  claude:
    if: contains(github.event.comment.body, '@claude')
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
      issues: write
      id-token: write
    steps:
      - uses: actions/checkout@v6
      - id: tokmizer
        uses: norwelltw/Tokmizer@main
      - uses: anthropics/claude-code-action@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          plugin_marketplaces: ${{ steps.tokmizer.outputs.plugin_marketplaces }}
          plugins: ${{ steps.tokmizer.outputs.plugins }}
      - if: always()
        uses: norwelltw/Tokmizer@main
        with:
          summary: true
```

To pin the action, replace `main` with a release tag that contains `action.yml`.

## What it does

1. Installs `@tokmizer/plugin` from npm into the runner's temp folder.
2. Builds a local plugin marketplace from that install. `claude-code-action` loads it through its `plugin_marketplaces` and `plugins` inputs, so the Tokmizer hooks run for the whole job.
3. Sets `TOKMIZER_NETWORK=0` for the rest of the job: no telemetry, no rule updates. Tokmizer uses the rules shipped in the package.
4. With `summary: true`, writes the `tkr gain` totals to the job summary. Nothing leaves the runner.

Failing tests, errors and stack traces stay in the output. If Claude needs a full output, it can get it back with `tkr restore`.

## Inputs

| Input | Default | |
|---|---|---|
| `version` | `latest` | npm version of `@tokmizer/plugin`. Pin it for repeatable runs. |
| `network` | `off` | `on` lets Tokmizer update its rules and send usage stats. |
| `summary` | `false` | `true` only writes the job summary. Use it as the last step. |

## Outputs

| Output | |
|---|---|
| `plugin_marketplaces` | Path of the local marketplace, for `claude-code-action`. |
| `plugins` | `tokmizer@tokmizer`, for `claude-code-action`. |
| `version` | Installed version. |

Needs Node.js 20.11 or newer on the runner. GitHub-hosted runners have it.
