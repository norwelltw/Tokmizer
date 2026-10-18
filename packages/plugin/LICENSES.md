# Licences

Tokmizer uses two licences, split by directory. No source file carries a licence header: the directory decides.

Copyright 2026 Impulse Creation, the copyright holder and the Licensor named in the BUSL-1.1 files.

| Path | Licence | Text |
|---|---|---|
| `src/engine/**` (compression engine: pipeline, routing, matcher, filter schema and loader, transforms, structured compaction, test-failure folding) | BUSL-1.1, converts to Apache-2.0 on the Change Date | [`src/engine/LICENSE`](src/engine/LICENSE) |
| `filters/**` (TOML rule catalogue), including the default rules built from it and embedded in `dist/` | BUSL-1.1, same Licensed Work as the engine | [`filters/LICENSE`](filters/LICENSE) |
| Everything else: CLI (`src/bin`, `src/*.ts`), hooks (`hooks/`, `src/hooks-host`), agent adapters (`src/adapters`, `agent-plugins/`), daemon, launcher and shims (`src/daemon`, `src/exec`, `src/shim`), native launcher (`native/`), setup commands (`command-templates/`, `codex-plugin/`, `.claude-plugin/`, install scripts), tests and fixtures (`src/__tests__`), build scripts (`scripts/`) and documentation | Apache-2.0 | [`LICENSE`](LICENSE) |
| `dist/` and the npm package `@tokmizer/plugin` | `Apache-2.0 AND BUSL-1.1`: the bundled files contain code and rules under both licences | both texts above |
| Third-party code bundled into `dist/` and into the native launcher | its own licence | [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md) |

The BUSL-1.1 text is the same file in `src/engine/LICENSE`, `filters/LICENSE` and, at the root, [`LICENSE-ENGINE`](LICENSE-ENGINE).

## What BUSL-1.1 allows here

You can read, copy, modify and redistribute the engine and the rules, and use them in production, including inside the Tokmizer CLI, hooks and plugins and in your own internal tools. You cannot offer the engine or the rules, alone or together, or a derivative of them, to third parties as part of a product or service that reduces, compresses or optimizes AI-model tokens or context and competes with Tokmizer. The exact terms are in [`LICENSE-ENGINE`](LICENSE-ENGINE).

Each published version becomes Apache-2.0 on its Change Date: four years after that version's first public release, or earlier if the licence file of that version says so.

## Your own rules

Rules you write yourself, in your project or user configuration, are yours. Writing or reading rules in the same TOML format with your own tools needs no licence from us; only the engine source and the rule catalogue published here are BUSL-1.1.

## Contributions

The source is published to be read, built and checked. Bug reports and suggested fixes are welcome as issues; pull requests are closed and the maintainer applies changes himself. A suggested fix may be used, changed and published under the licences above, see `CONTRIBUTING.md` at the root of the public repository.
