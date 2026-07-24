# Changelog

Notable user-facing changes are documented here. The project follows [Semantic Versioning](https://semver.org/). Before 1.0, minor releases may contain breaking changes.

## Unreleased

### Added

- Local tree-sitter indexing for TypeScript/TSX, JavaScript, Python, Go, Java, Ruby, Kotlin, C#, C++, PHP, Scala, Rust, and C.
- pi tools for symbol search, definitions, callers/callees, references, hierarchy, reverse-call reach, file discovery, structural matching, import cycles, status, and synchronization.
- Standalone `codeindex` CLI, incremental SQLite persistence, optional TypeScript resolution, and SCIP import/export.
- Multi-repository workspace discovery, background warming, file watching, and conservative grep steering for pi.
