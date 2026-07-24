# Contributing to pi-codeindex

Bug reports, fixes, language-support improvements, tests, and documentation corrections are welcome.

## Before you start

- Search existing issues before opening a new one.
- For a substantial behavior or API change, open an issue first so the design and compatibility tradeoffs can be discussed.
- Report security problems privately as described in [SECURITY.md](SECURITY.md).

## Development setup

Use Node.js 22.19 or newer and npm:

```bash
npm ci
npm run check
```

`npm run check` enforces the engine/pi boundary, typechecks, lints, runs the test suite, validates the npm payload, and installs the packed CLI into a temporary consumer project for a smoke test.

## Project structure

- `src/engine/` is the reusable indexing engine. It must not import pi packages.
- `src/pi/` adapts the engine to pi tools, lifecycle events, workspace discovery, and steering.
- `bin/` contains the standalone CLI.
- `test/` contains unit and integration tests plus language fixtures.
- `docs/` contains public behavior and design documentation.

See [How it works](docs/how-it-works.md) before changing resolution, persistence, incremental sync, or workspace behavior.

## Change guidelines

- Keep changes focused and explain user-visible behavior in the pull request.
- Add or update tests for correctness changes. Language-resolution changes should include both positive and ambiguity/safety cases.
- Preserve explicit confidence and provenance reporting; do not present heuristic results as compiler facts.
- Update the README or relevant document when installation, tools, configuration, supported behavior, or limitations change.
- Do not commit `.codeindex/`, databases, generated SCIP files, package tarballs, credentials, or local editor state.
- Run `npm run check` from a clean install before requesting review.

By contributing, you agree that your contribution is licensed under the repository's [MIT license](LICENSE), except where a file clearly carries a compatible third-party license notice.
