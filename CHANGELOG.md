# Changelog

Notable user-facing changes are documented here. The project follows [Semantic Versioning](https://semver.org/). Before 1.0, minor releases may contain breaking changes.

## Unreleased

### Fixed

- Degrade supported watcher errors safely, bound event storms, and avoid automatically watching every repository discovered below a container workspace.
- Resolve relative repository selectors such as `repo: "."` against the session cwd.
- Report high-fan-out suppression and unsupported Go structural interface queries without implying complete or recoverable results.

### Changed

- Make code-navigation steering advisory; the extension no longer intercepts `grep` or `find`.
- Describe resolution scores as heuristic evidence rather than calibrated confidence.

## 0.1.0 - 2026-07-25

### Added

- Local tree-sitter indexing for TypeScript/TSX, JavaScript, Python, Go, Java, Ruby, Kotlin, C#, C++, PHP, Scala, Rust, and C.
- pi tools for symbol search, definitions, callers/callees, references, hierarchy, reverse-call reach, file discovery, structural matching, import cycles, status, and synchronization.
- Standalone `codeindex` CLI, incremental SQLite persistence, optional TypeScript resolution, and SCIP import/export.
- Multi-repository workspace discovery, background warming, file watching, and conservative grep steering for pi.
