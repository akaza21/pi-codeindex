/**
 * Public engine surface shared by the pi adapter and standalone CLI. Engine modules do not import
 * pi packages; `scripts/check-boundary.mjs` enforces that boundary.
 */

import { effectiveIndexFileLimit } from "../limits.ts";
import { NodeFileSystem } from "./adapters/node-fs.ts";
import { SystemClock } from "./adapters/system-clock.ts";
import { Indexer } from "./indexer/indexer.ts";
import { TreeSitterParser } from "./parser/tree-sitter-parser.ts";
import type { Clock, Parser, ResolverProvider, Store } from "./ports.ts";
import { SyntacticResolver } from "./resolve/l1-syntactic.ts";
import { ScopedResolver } from "./resolve/l2-scoped.ts";
import { TypedResolver } from "./resolve/l3-typed.ts";
import { openCacheStore } from "./store/sqlite-store.ts";

export { NodeFileSystem } from "./adapters/node-fs.ts";
export { defaultDbPath, ensureStateDir, STATE_DIR_NAME } from "./adapters/state-dir.ts";
export { SystemClock } from "./adapters/system-clock.ts";
export { type ImportCycle, importCycles } from "./imports/cycles.ts";
export { Indexer } from "./indexer/indexer.ts";
export * from "./model/types.ts";
export { languageForFile, languageIds, supportedExtensions } from "./parser/languages.ts";
export { TreeSitterParser } from "./parser/tree-sitter-parser.ts";
export * from "./ports.ts";
export { SyntacticResolver } from "./resolve/l1-syntactic.ts";
export { ScopedResolver } from "./resolve/l2-scoped.ts";
export { TypedResolver } from "./resolve/l3-typed.ts";
export { TsTypeService } from "./resolve/ts-service.ts";
export { exportScip, type ScipExportOptions, scipAvailable } from "./scip/export.ts";
export { ingestScip, type ScipIngestOptions } from "./scip/ingest.ts";
export { scipSymbol } from "./scip/symbol.ts";
export {
	type StructuralHit,
	type StructuralSearchDeps,
	type StructuralSearchInput,
	structuralSearch,
} from "./search/structural.ts";
export { SqliteStore } from "./store/sqlite-store.ts";

/**
 * Resolver providers for a repo, highest tier first. The typed (TypeScript) layer is
 * opt-in; when requested it is added here and the pipeline drops it during resolution if
 * `typescript` is not installed. Scope-graph and syntactic resolution always run.
 */
function providersFor(root: string, opts: { typed?: boolean } = {}): ResolverProvider[] {
	const providers: ResolverProvider[] = [];
	// When typed is requested, add the typed resolver unconditionally; the pipeline drops it via
	// `available(snapshot)` if `typescript` is not installed (and preloads it there).
	if (opts.typed) providers.push(new TypedResolver(root));
	providers.push(new ScopedResolver(), new SyntacticResolver());
	return providers;
}

export interface OpenIndexOptions {
	root: string;
	dbPath: string;
	parser?: Parser;
	clock?: Clock;
	providers?: ResolverProvider[];
	/** Enable the in-process TypeScript typed resolver for TS/JS. Off by default. */
	typed?: boolean;
	/** Safety cap on indexed files per repo (default 20,000; typed default 500). */
	maxFiles?: number;
}

export interface OpenedIndex {
	store: Store;
	indexer: Indexer;
}

/** Wire a single-repo index (store + indexer) over the default adapters. */
export function openIndex(options: OpenIndexOptions): OpenedIndex {
	const maxFiles = effectiveIndexFileLimit(options.typed === true, options.maxFiles);
	const clock = options.clock ?? new SystemClock();
	const parser = options.parser ?? new TreeSitterParser();
	const store = openCacheStore(options.root, options.dbPath);
	const indexer = new Indexer(options.root, {
		fs: new NodeFileSystem(),
		parser,
		store,
		providers: options.providers ?? providersFor(options.root, { typed: options.typed }),
		clock,
		maxFiles,
	});
	return { store, indexer };
}
