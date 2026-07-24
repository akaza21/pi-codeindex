# Performance

From a source checkout, `scripts/bench-sync.mjs` measures a default, compiler-free full sync and a one-file incremental sync in separate fresh Node.js processes. It copies the source repository without Git or prior index state, records the process RSS high-water mark, and appends one newline to the lexicographically first indexed file before the incremental run.

## Reference run

These are single-run reference measurements, not latency guarantees. Repository shape, storage, CPU, language mix, and optional typed resolution can change the result.

Source: Visual Studio Code commit `6ba0ce0a149c3036a13cf91ff301f330b1b009be`.

Indexer: pi-codeindex 0.1.0.

Environment: Node.js 24.15.0; WSL2 Linux `6.6.87.2-microsoft-standard-WSL2`; AMD Ryzen 9 8945H; WSL VM reporting 15.6 GiB RAM.

| Scope | Indexed output | Full sync | Full peak RSS | One-file sync | One-file peak RSS | Database |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 2,000-file cap | 31,752 symbols; 233,724 occurrences | 25.97 s | 502.3 MB | 1.10 s | 333.7 MB | 90.9 MB |
| Complete 11,073-file corpus | 162,466 symbols; 1,195,169 occurrences | 157.36 s | 1,404.2 MB | 5.35 s | 672.5 MB | 453.2 MB |

The capped run edited `eslint.config.js`; the complete-corpus run edited `cli/build.rs`. Both edits changed content without changing declarations or imports.

From a source checkout of the same release, reproduce the two scopes with:

```bash
node scripts/bench-sync.mjs /path/to/vscode 2000
node scripts/bench-sync.mjs /path/to/vscode
```

The script prints the repository revision, Node/OS/CPU metadata, indexed counts, truncation state, chosen edit target, and database size with each result.

## Typed TypeScript cost

Typed resolution is opt-in and has a separate 500-file default because it rebuilds a TypeScript program for each index snapshot. On the same machine, Microsoft TypeScript 5.6.3 source at commit `d48a5cf89a62a62d6c6ed53ffa18f070d9458b85` produced:

| Resolver | Scope | Full sync | Full peak RSS | One-file sync | One-file peak RSS |
| --- | ---: | ---: | ---: | ---: | ---: |
| Compiler-free | 500 files | 7.04 s | 315.6 MB | 0.33 s | 159.2 MB |
| Typed TypeScript | 500 files | 41.70 s | 1,507.7 MB | 35.50 s | 1,514.5 MB |

The edited file was `src/harness/client.ts`; the change did not alter declarations or imports. These figures explain the conservative typed default and serialized typed workspace syncs. Measure the target repository before explicitly increasing its typed file cap:

```bash
node scripts/bench-sync.mjs /path/to/typescript-project 500 --typed
```
