# Third-party notices

pi-codeindex is MIT-licensed, but it depends on and redistributes material under compatible third-party licenses. The Apache License 2.0 text is included at [`LICENSES/Apache-2.0.txt`](LICENSES/Apache-2.0.txt).

## Runtime and optional npm packages

The installed dependency tree supplies its own license files. Direct runtime dependencies include:

- the MIT- or Apache-2.0-licensed tree-sitter grammar packages for C, C#, C++, Go, Java, JavaScript, Kotlin, PHP, Python, Ruby, Rust, Scala, and TypeScript/TSX;
- `web-tree-sitter`, `jiti`, `ignore`, and `typebox`, under their package licenses; and
- optional `protobufjs` (BSD-3-Clause) and TypeScript (Apache-2.0) support.

Package names and resolved versions are recorded in `package.json` and `package-lock.json`. Their license texts are installed with the packages under `node_modules` and are not copied into this package tarball.

## Vendored tree-sitter queries

The query files under `src/engine/parser/queries/` ship in the npm package.

- `python/locals.scm`, `go/locals.scm`, and `java/locals.scm` are adapted from the Apache-2.0-licensed [nvim-treesitter query collection at commit `7248feaca45e4d944591497964bc19afa89ad1c6`](https://github.com/nvim-treesitter/nvim-treesitter/tree/7248feaca45e4d944591497964bc19afa89ad1c6). They were reduced and adjusted for pi-codeindex's scope model and grammar versions; they are not byte-for-byte copies.
- The remaining vendored query files for C, C#, C++, Kotlin, PHP, and Rust were authored for pi-codeindex and are covered by the repository's MIT license.

## SCIP schema test fixture

`test/fixtures/vendor/scip.proto` is the canonical SCIP schema from [scip-code/scip](https://github.com/scip-code/scip/blob/f6083368e99b0b3a5c127ed56e57489e01ad9257/scip.proto), commit `f6083368e99b0b3a5c127ed56e57489e01ad9257`, licensed Apache-2.0 and copyright Sourcegraph. The vendored copy is unmodified except for its attribution header and is used only to validate protobuf compatibility in tests; it is not included in the npm package.
