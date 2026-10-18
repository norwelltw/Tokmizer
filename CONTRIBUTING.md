# Contributing

Thanks for your interest in Tokmizer. Bug reports, new filter rules and fixes are welcome.

## Before you start

- For a bug, open an issue with the command, the raw output (or a reduced sample), what Tokmizer produced and what you expected. Remove any secret or private path from samples.
- For a larger change (new transform, new agent adapter, behaviour change), open an issue first so we can agree on the approach.
- Security problems go to contact@tokmizer.com, not to a public issue. See [SECURITY.md](SECURITY.md).

## Development

```
npm install
npm run build
npm test
```

- `npm run lint` type-checks the plugin.
- Run one test file with `npx vitest run packages/plugin/src/__tests__/<name>.test.ts`.
- Tests that need a built `dist/` are skipped until you run `npm run build`.
- The native launcher lives in `packages/plugin/native/` (`cargo test --manifest-path packages/plugin/native/Cargo.toml`).

## Adding or changing a filter rule

Rules live in `packages/plugin/filters/*.toml`. Each rule needs a `match_command`, a short `description` and, when possible, inline tests. Keep a rule conservative: it must never hide an error, a failing test or a diagnostic. Add a test with a real (anonymised) output sample.

## Style

- TypeScript, strict mode, ES modules.
- Follow the style of the surrounding code; keep changes small and focused.
- No new runtime dependency without discussion: everything ends up bundled in `dist/`.

## Contributor License Agreement

Before we can merge your first pull request, you need to sign the [Contributor License Agreement](CLA.md) (CLA) in favour of Impulse Creation, which owns the project. The CLA check comments on your pull request; reply with the sentence it asks for. One signature covers all your later contributions.

Why a CLA: Tokmizer is distributed under two licences (Apache-2.0 for most of the repository, BUSL-1.1 for `packages/plugin/src/engine/` and `packages/plugin/filters/`, see [packages/plugin/LICENSES.md](packages/plugin/LICENSES.md)), and Impulse Creation may also offer the project under other terms, including commercial licences. The CLA lets Impulse Creation ship your change under the licence of the directory it lands in, and also under other licences, including commercial ones. You keep the copyright on your work and can reuse it however you like. Your contribution stays available to the public under at least the licence of the directory you changed.

The CLA replaces the Developer Certificate of Origin: `git commit -s` sign-off is not required.

## Code of conduct

This project follows the [code of conduct](CODE_OF_CONDUCT.md).
