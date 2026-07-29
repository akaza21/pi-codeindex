# Tools and CLI

pi tool names use the `codeindex_` prefix. Standalone CLI commands omit it. Results are bounded; raise a tool's `limit` or `budget` only when the first response is insufficient.

## Choosing a tool

1. Use `codeindex_explore` when the symbol is known. It returns the definition, source, callers, callees, hierarchy, and reverse-call reach.
2. Use `codeindex_search` when the name is partial or uncertain. A returned moniker can identify one declaration in later queries.
3. Use `codeindex_status` if results are empty or stale. It reports counts, last sync time, watcher state, and background errors.
4. Use `codeindex_sync` to refresh the index. It updates the local cache and blocks until the requested repositories finish.

All other query tools are read-only. A cancelled tool call stops waiting or scanning promptly; an already shared background sync may safely finish updating the cache.

Indexed relationships are navigation evidence, not proof of absence. Switch to source search when a tool reports high-fan-out suppression or unsupported language semantics. A moniker precisely selects an existing stored declaration or edge; it cannot recreate an edge suppressed during indexing.

## Reference

| pi tool | CLI | Behavior |
| --- | --- | --- |
| `codeindex_explore` | `explore` | Definition/body head, up to 15 stored callers and callees, name-scoped hierarchy, and capped depth-2 impact summary. |
| `codeindex_search` | `search` | Ranked symbol-name/text search: exact names, then FTS and bounded single-token subsequence fallback. |
| `codeindex_def` | `def` | Exact-name declaration sites with kind, path, known modifiers, and moniker. |
| `codeindex_callers` | `callers` | Stored incoming call/reference edges to a name or repo-local moniker, ordered by heuristic resolution score; ambiguous name-only sites may be absent. |
| `codeindex_callees` | `callees` | Stored outgoing call/reference edges from a name or repo-local moniker; ambiguous target bindings may be absent. |
| `codeindex_refs` | `refs` | Stored resolved occurrences targeting a name or moniker, including inheritance roles. |
| `codeindex_implementers` | `implementers` | Name-scoped explicit `extends`/`implements` edges. Go structural interface satisfaction is not computed. |
| `codeindex_supertypes` | `supertypes` | Name-scoped explicit outgoing hierarchy edges. Go type/interface embedding is not computed. |
| `codeindex_impact` | `impact` | Fair, capped reverse-call traversal over stored edges, aggregated by enclosing caller and labelled by hop depth. |
| `codeindex_files` | `files` | Indexed paths, optionally filtered by path substring. |
| `codeindex_match` | `match` | Current-disk tree-sitter structural query for one language, limited to 2,000 candidate files. |
| `codeindex_cycles` | `cycles` | TS/JS file-level import strongly connected components. |
| `codeindex_status` | `status` | Per-repo counts, cap status, last sync, watcher state, and background errors. CLI `--verify` also checks current disk metadata. |
| `codeindex_sync` | `sync` | Blocking full sync of the selected workspace repositories. |
| — | `scip` | Export optional, best-effort SCIP interop. Standalone only. |
| — | `scip-import` | Optionally replace prior imported SCIP facts with a separately generated compiler index. Standalone only. |

## Common parameters

- `repo` narrows a pi query by name, absolute path, or path relative to cwd. `.` selects the repository containing cwd.
- `moniker` targets one exact declaration returned by `search` or `def`; pass it with its `repo` tag in workspace mode.
- `limit` is a positive maximum result count, up to 500.
- `budget` is an approximate positive character cap for `explore`, not a token count; the maximum is 50,000.
- `depth` is a positive reverse-call hop limit for `impact`, up to 10.

## Structural queries

`codeindex_match` accepts a tree-sitter query that captures at least one node. For example:

```text
(function_declaration name: (identifier) @name)
```

The query language cannot express “a node without child X.” Match the surrounding structure and post-filter captures instead. A scope above 2,000 candidate files is rejected; add a `path` filter.

## Reading results

Definition/search rows include repo-local monikers. Occurrence rows include provenance and a heuristic resolution score, not a calibrated probability. `direct` impact rows are one reverse-call hop away; `transitive (depth N)` rows are reached in N hops. Impact is reachability over stored call/reference edges, not edit semantics.
