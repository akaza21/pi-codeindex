# Language support

Most languages use syntactic resolution. “Scope” means same-file lexical binding and local-variable suppression. “Receiver/owner” does not imply general type inference: an arbitrary `obj.m()` is usually a same-name guess unless typed TS/JS or imported SCIP covers it. Inheritance edges come from syntax rather than compiler validation.

| Language (`--lang` ID) | Scope | Cross-file import/package binding | Default receiver/owner behavior | Inheritance edges | Typed path |
| --- | --- | --- | --- | --- | --- |
| TypeScript (`typescript`), TSX (`tsx`), JavaScript (`javascript`) | Yes | Relative modules, index files, re-exports, root `tsconfig` `baseUrl`/`paths` | Imported namespace and own/inherited `this`; arbitrary object receiver is a guess | `extends`/`implements` | Opt-in TypeScript; SCIP import |
| Python (`python`) | Yes | `import`, `from`, aliases, relative modules, `__init__.py` | Imported module/from-import and own/inherited `self`; other receivers are guesses | Multiple bases as `extends` | SCIP import |
| Go (`go`) | Yes | `go.mod` module path, package aliases, same-package siblings, dot imports | Package receiver binding; ordinary value receiver dispatch is a guess | None | SCIP import |
| Java (`java`) | Yes | Class/static/wildcard imports and same-package siblings | Imported/same-package class receivers and own/inherited `this`; ordinary object receiver is a guess | `extends`/`implements` | SCIP import |
| Ruby (`ruby`) | Yes | No import binder | Own/inherited `self` when owner/heritage resolves; other receivers are guesses | Class superclass only; not `include`/`prepend` | SCIP import |
| Kotlin (`kotlin`) | Yes | No import binder | Own/inherited `this` only when syntactic edges resolve; other receivers are guesses | Supertypes emitted as `extends` | SCIP import |
| C# (`csharp`) | Yes | No import/namespace binder | Own/inherited `this` only when syntactic edges resolve; other receivers are guesses | Base-list entries emitted as `extends` | SCIP import |
| C++ (`cpp`) | Yes | No include/namespace binder | Owner metadata and own/inherited `this` when syntactically resolvable; other receivers are guesses | Base classes as `extends` | SCIP import |
| PHP (`php`) | Yes | No `use`/namespace binder | Receiver is captured, but `$this` is not special to the resolver; member dispatch is generally a guess | `extends`/`implements` syntax | SCIP import |
| Scala (`scala`) | Yes | No import binder | Owner metadata; member selections are intentionally not tagged | Superclass/mixins emitted as `extends` | SCIP import |
| Rust (`rust`) | Yes | No `use`/module binder | Own in-file `self` member can bind by owner; other receiver dispatch is a guess | None | SCIP import |
| C (`c`) | Yes | No include binder | No owner/member model | None | SCIP import |

## Shared limits

- Files larger than 512 KiB, paths excluded by nested `.gitignore` rules, hidden entries, directory/file symlinks, nested Git repositories, common VCS/build/vendor directories, generated artifacts, and lower-precedence compiled JS are skipped.
- Each repository defaults to 20,000 compiler-free source files or 500 files in typed mode. An explicit cap can raise either scope up to 100,000; status and sync report when it is reached.
- Name-only sets above eight candidates are suppressed.
- Only the syntactic resolver's root `tsconfig.json` paths/base URL and `go.mod` module are modeled. Typed TS/JS reads the root tsconfig through TypeScript and can follow its compiler configuration.
- C/C++ preprocessing, PHP namespaces/use binding, and Scala member selection are not modeled.

When the table does not cover the precision required for a change, inspect the returned source and use a compiler-produced SCIP index where available.
