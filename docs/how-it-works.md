# How it works

pi-codeindex turns source code into a local navigation graph:

```text
source files -> declarations and uses -> resolved relationships -> indexed queries
```

The index answers navigation questions; it does not compile the project or predict whether an edit will build successfully.

## Parsing and resolution

Source files are parsed with tree-sitter WASM. The parser records declarations, references, imports, lexical scopes, inheritance, receivers, and available callable metadata. The [language matrix](languages.md) describes what is recognized for each language.

Each reference is resolved by the strongest applicable method:

1. Optional TypeScript compiler resolution handles typed TS/JS receiver dispatch and aliases.
2. Lexical resolution binds tracked names to the nearest declaration in the same file.
3. Compiler-free resolution handles supported imports, packages, same-file declarations, and `this`/`self` members.
4. When no precise binding exists, up to eight compatible same-name declarations may be returned at a lower score.

The first method that produces candidates wins; results from weaker methods are not mixed into it. Locals that are not indexed as declarations suppress a guess rather than being connected to an unrelated same-named symbol.

SCIP is a separate, optional interoperability path. A user-generated `.scip` file can contribute compiler-produced bindings at the exact source locations it covers. pi-codeindex does not download or run language indexers. Imported facts replace heuristic facts only at those locations and must be regenerated after relevant source changes.

Results carry provenance (`typed`, `scoped`, `syntactic`, or `scip`) and a heuristic resolution score. The score orders evidence; it is not a calibrated probability and does not establish completeness. Precisely resolved bindings are normally `0.9–1.0`; ambiguous same-name candidates share lower scores. Name-only sets above eight declarations are suppressed rather than materialized as every possible edge.

## Local cache

Each repository stores its index at `.codeindex/index.db`. This is a pi-codeindex SQLite cache, not a SCIP database. It contains declarations, resolved uses, imports, scopes, and graph relationships needed by the query tools.

Declaration identities are repository-local and include their source location. They remain stable across body-only edits but can change when a declaration moves or its name, kind, owner, or position changes.

SQLite WAL allows queries to read the last committed snapshot while a background sync writes the next one. Schema changes and explicit database-corruption errors rebuild the cache from source.

## Updates

A full sync walks a deterministic source selection, follows repository `.gitignore` rules, applies the configured file cap, and content-hashes the selected files before parsing only changed content. Files no longer in the selected corpus are removed, including when a lower cap replaces a larger one.

In pi, supported filesystem events are batched for 750 ms and normally trigger a changed-file sync. Changed paths are content-checked, and project-layout, ignore-rule, nested-repository boundary, unknown-path, or event-storm changes trigger a full refresh. Reads can continue against the previous committed snapshot while this happens.

Compiler-free incremental resolution normally updates the changed files and relationships that can depend on them. Typed TypeScript mode rebuilds its compiler program for each changed snapshot, which is why it is opt-in, defaults to 500 files, and serializes repository syncs.

Supported watcher setup and backend errors degrade watcher status without disabling manual indexing. If watching is disabled or unavailable, `codeindex_status` reports it and `codeindex_sync` remains the recovery path.

## Graph queries

Resolved uses inside declarations create caller-to-callee relationships. Inheritance is stored separately through `extends` and `implements` edges.

Impact analysis walks incoming call/reference relationships breadth-first. It is reachability over the indexed graph, not a semantic breakage forecast. Results are bounded by depth and count, aggregate repeated sites by enclosing caller, and avoid revisiting cycles.

Structural search is different: it runs a supplied tree-sitter query against current source files instead of reading stored symbol relationships.

## Pi and workspaces

At session start, the extension discovers repositories and warms and watches only the repository containing cwd. When cwd is a container of several repositories, no child watcher starts automatically; query tools warm matching repositories on demand. `codeindex_sync` waits for its selected repositories to finish.

Inside a Git repository, the enclosing repository is selected. Outside one, pi can discover Git or build-marker roots to depth 4. Queries can cover up to eight repositories, prioritizing the current one, while background syncs are limited to two repositories at once—or one in typed mode. Each repository has its own cache, and there are no cross-repository symbol bindings.

The extension adds advisory navigation guidance when a usable index exists. It does not intercept or block `grep` or `find`; agents can switch directly to text search when indexed evidence is incomplete.

## Important boundaries

- Compiler-free indexing defaults to 20,000 files; typed mode defaults to 500. Explicit caps may be raised to 100,000.
- Files over 512 KiB, hidden paths, symlinks, nested Git repositories, generated/build/vendor content, and lower-precedence compiled sources are excluded.
- Structural search requires a path filter above 2,000 candidate files.
- Arbitrary object receiver types usually require typed TS/JS or imported SCIP.
- Go structural interface satisfaction is not computed; `codeindex_implementers` reports this boundary explicitly.
- External dependencies and standard libraries are not graph nodes.
- Compiler-free project layout reads the root `tsconfig.json` and `go.mod`; multi-project compiler semantics are not generalized.
- C/C++ preprocessing, PHP namespace/use binding, Rust module/use binding, and Scala member selection are not modeled.

See [Configuration and troubleshooting](configuration.md) for runtime behavior and [Language support](languages.md) for language-specific precision.
