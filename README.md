# pi-codeindex

Code navigation for [pi](https://github.com/earendil-works/pi) agents and the command line.

pi-codeindex gives an agent a persistent map of definitions, references, callers, callees, inheritance, reverse-call reach, files, and AST shapes. It runs entirely on the user's machine: there is no server, network request, account, or telemetry in this package.

## Why use it?

Text search is useful for strings, but it makes an agent repeatedly scan files and infer which same-named symbol a result belongs to. Compiler services are precise, but usually language-specific and not always available. pi-codeindex sits between those approaches:

- one local SQLite index across 14 language IDs;
- repo-local monikers that distinguish same-named declarations;
- heuristic resolution scores and provenance on resolved references;
- background incremental updates in pi and deterministic snapshot reads in the CLI;
- optional TypeScript compiler resolution and external SCIP facts when more precision is available; and
- bounded outputs designed for an agent's context window.

It is a navigation aid, not a semantic rename engine or a prediction of which edits will break.

## Supported languages

Built-in indexing supports TypeScript, TSX, JavaScript, Python, Go, Java, Ruby, Kotlin, C#, C++, PHP, Scala, Rust, and C. All work without a compiler toolchain; optional TypeScript resolution and imported SCIP facts can add precision where available. See the [language support matrix](docs/languages.md) for resolution capabilities and known limits.

## Quick start

Requires Node.js 22.19 or newer and pi 0.81.1 or newer.

### Use it in pi

Install the npm package:

```bash
pi install npm:@akaza21/pi-codeindex
```

Or install a local checkout while developing:

```bash
pi install /path/to/pi-codeindex
```

Start pi inside a repository. The extension warms and watches that repository in the background. Child repositories discovered from a container directory are indexed on demand rather than all being watched at startup. For example:

```text
Use codeindex_status, then use codeindex_explore to explain openIndex and show who calls it.
```

Use `codeindex_explore` when you know the symbol name. It returns the definition, source head, callers, callees, hierarchy, and reverse-call reach. Use `codeindex_search` when the name is uncertain.

### Use the standalone CLI

```bash
npm install -g @akaza21/pi-codeindex

cd /path/to/repository
codeindex sync .
codeindex search Calculator .
codeindex explore Calculator .
codeindex callers Calculator .
```

Standalone reads are snapshots. Run `codeindex sync` after edits; the CLI does not start a watcher.

## What it can answer

| Intent | Start with |
| --- | --- |
| “Where is this symbol and what surrounds it?” | `codeindex_explore` |
| “I know part of the name.” | `codeindex_search` |
| “Who uses this function?” | `codeindex_callers` or `codeindex_refs` |
| “What does this function depend on?” | `codeindex_callees` |
| “Which callers can reach this symbol?” | `codeindex_impact` |
| “Which types explicitly implement or extend this?” | `codeindex_implementers` / `codeindex_supertypes` |
| “Find code with this AST shape.” | `codeindex_match` |
| “Is the index current and is watching active?” | `codeindex_status` |

See the complete [tool and CLI reference](docs/tools.md).

## Precision model

pi-codeindex prefers the most specific available resolver and does not merge lower tiers into a higher-tier answer:

1. optional TypeScript compiler resolution;
2. lexical scope resolution;
3. compiler-free import/package and same-file binding;
4. bounded, lower-score same-name candidates.

Imported compiler-produced SCIP facts replace heuristic facts at the exact source locations they cover.

Resolution scores are heuristic ranking evidence, not calibrated probabilities or a guarantee of completeness. Precisely resolved bindings normally score `0.9–1.0`. Ambiguous candidates share lower scores, and name-only fan-out above eight candidates is suppressed rather than expanded into every possible edge. When suppression is reported, use source search, typed resolution, or imported SCIP facts; selecting a moniker cannot recover an edge that was never stored.

Resolution coverage differs by language. In particular, Go's structural interface satisfaction is not computed by the built-in index. The [language support matrix](docs/languages.md) lists import binding, receiver handling, inheritance, and typed-index support.

## Typed and SCIP precision

Enable the optional in-process TypeScript resolver for TS/JS:

```bash
codeindex sync . --typed
```

In pi, set `PI_CODEINDEX_TYPED=1` before starting the agent. Typed mode reads the repository's root `tsconfig.json` through the TypeScript API when present. Because it rebuilds a compiler program for each index snapshot, its default scope is 500 files; choose a larger `--max-files` or `PI_CODEINDEX_MAX_FILES` value explicitly after measuring the target repository.

SCIP is optional interoperability, not a requirement for installation or normal indexing. pi-codeindex does not download or invoke compiler indexers. If the language ecosystem provides a [SCIP indexer](https://github.com/scip-code/scip), generate `index.scip` separately and import it:

```bash
codeindex scip-import index.scip .
```

SCIP import/export needs the optional `protobufjs` dependency. Imported facts cover locally indexed symbols only and must be re-imported after relevant source changes. The repository's `.codeindex/index.db` is pi-codeindex's own SQLite cache, not a SCIP database.

## Local data and privacy

Each repository stores its cache in `.codeindex/index.db`. Source files and the index stay local, and pi-codeindex itself makes no network calls. Tool output returned to pi can still enter the context sent to the model provider the user configured, so that provider's data policy still applies to sensitive code.

Directory and file symlinks are not indexed, preventing traversal outside the selected repository. The index is a cache, not a sandbox; the process otherwise has the same filesystem permissions as the user running it.

## Documentation

- [Tools and CLI](docs/tools.md)
- [Language support](docs/languages.md)
- [Configuration and troubleshooting](docs/configuration.md)
- [How the index works](docs/how-it-works.md)
- [Evaluation](docs/evaluation.md)
- [Performance](docs/performance.md)
- [Security policy](SECURITY.md)

## Development

```bash
npm ci
npm run check
```

The check verifies the engine/pi boundary, types, formatting and lint rules, the full test suite, the npm payload, and a fresh install of the packed CLI. See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidance.

## License

[MIT](LICENSE). Vendored and dependency attribution is documented in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
