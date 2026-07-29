# Configuration and troubleshooting

Configuration is limited to a few runtime options. Repository state lives in `.codeindex/`; there is no global service or account.

## Configuration

| Setting | Effect |
| --- | --- |
| `PI_CODEINDEX_TYPED=1` | Enables in-process TypeScript resolution for TS/JS when pi starts; the default file cap becomes 500. |
| `PI_CODEINDEX_MAX_FILES=N` | Sets pi's explicit full-sync source-file cap (compiler-free default 20,000; maximum 100,000). |
| `PI_CODEINDEX_WATCH=0` | Disables automatic filesystem watching. Manual sync and all read tools remain available. |
| CLI `--typed` | Enables the same resolver for that CLI sync; the default file cap becomes 500. |
| CLI `--max-files N` | Sets the full-sync source-file cap for that invocation (maximum 100,000). |
| Tool/CLI `repo` or trailing directory | Selects one repository or root. |
| `limit`, `depth`, `budget` | Bounded output/traversal controls; see [Tools and CLI](tools.md#common-parameters). |

Source discovery follows repository `.gitignore` files, including nested rules and negations. Hard safety exclusions
still win: hidden paths, symlinks, generated/build/vendor directories, and nested Git repositories or submodules are
not indexed. A `.gitignore` edit triggers a full refresh when filesystem watching is available.

Typed mode is optional because building a TypeScript program costs substantially more than syntactic indexing. It reloads the compiler service for each changed index snapshot and reads the root `tsconfig.json` when present. Typed mode therefore defaults to 500 indexed files and serializes repository syncs in pi. Set `--max-files` or `PI_CODEINDEX_MAX_FILES` explicitly to evaluate a larger typed scope.

## Index lifecycle

- In pi, session startup warms and watches only the repository containing cwd. Repositories discovered below a container workspace are warmed on demand and are not all watched automatically.
- Watch events are batched for 750 ms and normally trigger changed-file syncs.
- Event storms are bounded and fall back to one full refresh.
- Read tools serve the last committed SQLite/WAL snapshot while a sync is running.
- In the standalone CLI, run `codeindex sync` manually after edits; a full sync content-checks the selected corpus.
- A schema-version change or corrupt SQLite cache rebuilds the cache from source.

## Workspaces

Inside a git repository, pi indexes that enclosing repository. Otherwise it discovers nested git or build-marker roots to depth 4. Unfiltered reads and syncs fan out to at most eight repositories, with the current repository first. Query coverage and sync concurrency are separate: all eight can be queried, while at most two compiler-free repository syncs or one typed sync runs at once. Child repositories discovered from a container directory are warmed when first queried. There are no cross-repository symbol bindings.

The `repo` selector accepts a repository name, absolute path, or a path relative to cwd. `repo: "."` selects the repository containing cwd; from a container workspace, use a child path such as `repo: "./service-a"`.

Start pi inside a project directory. Outside a discovered repository or marker root, the cwd becomes a marker workspace and may receive `.codeindex/` state.

## Troubleshooting

### Empty or stale results

Run `codeindex_status`. In pi it reports:

- indexed file/symbol/occurrence counts;
- the last completed sync;
- whether the file watcher is starting, active, disabled, unavailable, or failed, including its backend; and
- the last background sync error, if any.

Then run `codeindex_sync`. In the CLI, `codeindex status . --verify` also walks current file metadata and reports changed, new, and deleted counts.

### A language is missing

A grammar or query that cannot load is skipped with a warning. Previously cached facts for a file are removed after a failed parse so stale symbols are not presented as current. Reinstall or update pi-codeindex using the same method used for installation, then sync again. Contributors working from a source checkout can run `npm ci`.

### SCIP commands are unavailable

SCIP import/export requires the optional `protobufjs` package. Install optional dependencies and retry. The compiler/indexer for the target language must generate the `.scip` input; pi-codeindex does not invoke external compilers. Import supports SCIP's declared UTF-8, UTF-16, and UTF-32 position encodings; malformed or ambiguously encoded locations are skipped rather than guessed.

### Structural search says the scope is too broad

Add a `path` substring to narrow the candidate set below 2,000 files.

### A symlinked source or repository is absent

Symlinked files and directories are deliberately skipped to keep indexing within the selected repository and avoid traversal cycles. Index the real repository path instead.

### Watching is unavailable

`codeindex_status` reports the watcher backend and degraded state. macOS and Linux use native recursive events; Windows uses a slower polling backend to avoid known process-level failures in native recursive watching while paths change. Set `PI_CODEINDEX_WATCH=0` before starting pi to disable watching explicitly. Manual `codeindex_sync` remains available when watching is disabled or unavailable.

## Privacy

The package makes no network or telemetry calls. Tool results can enter the configured model's context through pi, so users remain responsible for the model provider and repository permissions they choose.
