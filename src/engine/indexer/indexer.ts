/**
 * Indexer: drives the build over the ports. Walk the repo, parse
 * changed files into facts, persist them incrementally, then — if any file changed OR
 * the project layout (tsconfig/go.mod) changed — rebuild occurrences from a fresh
 * cross-file snapshot, because one file's export/import edits (or a changed import
 * alias) can change how references elsewhere bind.
 *
 * `occurrences_dirty` meta guards the rebuild: it is set before the first fact
 * mutation and cleared only after a successful rebuild, so an interrupted sync never
 * leaves stale occurrences undetected.
 */

import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import { DEFAULT_INDEX_FILE_LIMIT, validateIndexFileLimit } from "../../limits.ts";
import { buildProjectLayout } from "../imports/project-layout.ts";
import { buildMoniker } from "../model/moniker.ts";
import type { Range, SymbolRecord, SyncResult } from "../model/types.ts";
import type {
	Clock,
	FileFacts,
	FileSystem,
	ParsedFile,
	Parser,
	PreSyncCapture,
	ResolverProvider,
	Store,
	StoredReference,
	StoredScope,
	StoredScopeDef,
} from "../ports.ts";
import { iterateOccurrences } from "../resolve/pipeline.ts";
import { precedenceSiblings, shouldIndexSource } from "./source-filter.ts";

interface IndexerDeps {
	fs: FileSystem;
	parser: Parser;
	store: Store;
	providers: ResolverProvider[];
	clock: Clock;
	/** Safety cap on indexed files per repo. Overridable for tests. */
	maxFiles?: number;
}

const MAX_FILE_BYTES = 512 * 1024;
const YIELD_EVERY_FILES = 25;

export class Indexer {
	private readonly root: string;
	private readonly deps: IndexerDeps;

	constructor(root: string, deps: IndexerDeps) {
		this.root = root;
		this.deps = deps;
		if (deps.maxFiles !== undefined) validateIndexFileLimit(deps.maxFiles);
	}

	/**
	 * Sync the index. A full sync (default) walks the repo, refreshing changed files and
	 * deleting vanished ones. An incremental sync (`only`) re-indexes just the paths the
	 * watcher reported changed, avoiding the whole-repository filesystem walk and parse pass.
	 */
	async sync(opts: { only?: readonly string[] } = {}): Promise<SyncResult> {
		const { fs, store, clock } = this.deps;
		// Incremental syncs do not call walk(), so explicitly refresh repository
		// ignore rules before applying source predicates to watcher-named paths.
		fs.refreshIgnoreRules?.(this.root);
		const started = clock.now();
		let indexed = 0;
		let removed = 0;
		let mutated = store.getMeta("occurrences_dirty") === "1";
		// occurrences_dirty already set = a prior rebuild was interrupted; we don't know which files are
		// stale, so recover with a full global re-resolve rather than a scoped one.
		const priorDirty = mutated;
		let forceGlobal = false;
		let truncated = store.getMeta("file_cap_reached") === "1";
		// Pre-mutation capture for the scoped incremental path (set only when `only` is used).
		let scoped: { pre: PreSyncCapture; considered: string[] } | undefined;
		const markMutated = (): void => {
			if (!mutated) {
				mutated = true;
				store.setMeta("occurrences_dirty", "1");
			}
		};

		if (opts.only) {
			// Fan out to lower-precedence siblings (a.ts -> a.js): adding/removing a source file
			// changes whether its compiled sibling should be indexed.
			const targets = new Set<string>();
			for (const rel of opts.only) {
				targets.add(rel);
				for (const sibling of precedenceSiblings(rel)) targets.add(sibling);
			}
			// Capture reverse dependents + old names/inheritance BEFORE any mutation (cascade destroys
			// the reverse-dependency evidence). The typed resolver's output isn't name-invalidatable.
			const considered = [...targets];
			scoped = { pre: store.capturePreSync(considered), considered };
			forceGlobal = priorDirty || this.deps.providers.some((provider) => provider.tier >= 3);
			for (const rel of targets) {
				const lang = this.deps.parser.languageForFile(rel);
				if (!lang) continue; // non-source change; a config edit is caught by layout detection below
				const abs = join(this.root, rel);
				const stat = fs.stat(abs);
				const indexable =
					stat !== undefined && stat.size <= MAX_FILE_BYTES && shouldIndexSource(fs, this.root, rel);
				if (!indexable) {
					// Vanished, too big, or now superseded/generated: drop its facts if we had it.
					if (store.getFileMeta(rel)) {
						store.transaction(() => {
							store.setMeta("occurrences_dirty", "1");
							store.deleteFile(rel);
						});
						markMutated();
						removed++;
					}
					continue;
				}
				// A watcher named this path, so confirm its content even if a filesystem reports
				// unchanged/coarse mtime metadata for a same-size edit.
				if (await this.ensureFileIndexed(rel, abs, lang, stat.mtimeMs, stat.size, true)) {
					markMutated();
					indexed++;
				}
			}
		} else {
			const maxFiles = this.deps.maxFiles ?? DEFAULT_INDEX_FILE_LIMIT;
			const seen = new Set<string>();
			let visited = 0;
			truncated = false;
			for (const absPath of fs.walk(this.root)) {
				const rel = toPosix(relative(this.root, absPath));
				const lang = this.deps.parser.languageForFile(rel);
				if (!lang) continue;
				if (!shouldIndexSource(fs, this.root, rel)) continue;
				const stat = fs.stat(absPath);
				if (!stat || stat.size > MAX_FILE_BYTES) continue;
				if (seen.size >= maxFiles) {
					truncated = true;
					break;
				}
				seen.add(rel);
				// A full sync is the authoritative recovery path, so hash the selected corpus even
				// when filesystem metadata is unchanged. The mtime/size shortcut is reserved for
				// callers that did not request a repository sync.
				if (await this.ensureFileIndexed(rel, absPath, lang, stat.mtimeMs, stat.size, true)) {
					markMutated();
					indexed++;
				}
				if (++visited % YIELD_EVERY_FILES === 0) await yieldToEventLoop();
			}
			// `seen` is the deterministic selected corpus for this sync. When the cap is reached,
			// remove rows outside that corpus as well: retaining an older, larger selection would
			// violate the cap and return results a clean rebuild would not contain.
			const stale = store.allFiles().filter((file) => !seen.has(file.path));
			if (stale.length > 0) {
				store.transaction(() => {
					store.setMeta("occurrences_dirty", "1");
					for (const file of stale) {
						store.deleteFile(file.path);
						removed++;
					}
				});
				markMutated();
			}
		}
		if (!opts.only) store.setMeta("file_cap_reached", truncated ? "1" : "0");

		// Config files (tsconfig.json, go.mod) aren't language files; detect a layout change
		// and force a rebuild so alias / module-prefix resolution can't go stale.
		const layoutJson = JSON.stringify(buildProjectLayout(fs, this.root));
		if (layoutJson !== store.getMeta("project_layout")) {
			store.transaction(() => {
				store.setMeta("occurrences_dirty", "1");
				store.setMeta("project_layout", layoutJson);
			});
			markMutated();
			// A layout edit (tsconfig paths / go.mod) can re-route resolution repo-wide; not scopeable.
			forceGlobal = true;
		}

		if (mutated) {
			store.transaction(() => {
				if (scoped && !forceGlobal) {
					// Re-capture names/inheritance post-mutation; changed inheritance wiring can re-route
					// dispatch in files that reference no changed name, so fall back to global then.
					const post = store.capturePreSync(scoped.considered);
					if (
						inheritanceChanged(scoped.pre, post) ||
						reexportRerouted(scoped.pre, post, store.reexportImportedNames())
					) {
						const snap = store.snapshot();
						store.replaceOccurrences(iterateOccurrences(snap, this.deps.providers));
					} else {
						const semanticChange = resolutionFactsChanged(scoped.pre, post);
						const names = semanticChange ? new Set([...scoped.pre.names, ...post.names]) : new Set<string>();
						const affected = store.affectedFileIds(
							scoped.considered,
							names,
							semanticChange ? scoped.pre.dependents : [],
						);
						const snap = store.snapshot(affected);
						store.replaceOccurrencesForFiles(affected, iterateOccurrences(snap, this.deps.providers, affected));
					}
				} else {
					const snap = store.snapshot();
					store.replaceOccurrences(iterateOccurrences(snap, this.deps.providers));
				}
				store.setMeta("occurrences_dirty", "0");
			});
		}
		store.setMeta("last_sync_at", clock.isoNow());

		const status = store.status();
		return {
			indexedFiles: indexed,
			removedFiles: removed,
			totalFiles: status.files,
			symbols: status.symbols,
			truncated,
			durationMs: clock.now() - started,
		};
	}

	/**
	 * Read-only freshness check: walk the same deterministic corpus as a full sync and compare
	 * content hashes, reporting changed / new / removed cache entries. This deliberately reads
	 * source content so same-size edits with preserved timestamps cannot remain invisible.
	 */
	async verify(): Promise<{ changed: number; new: number; deleted: number }> {
		const { fs, parser, store } = this.deps;
		const maxFiles = this.deps.maxFiles ?? DEFAULT_INDEX_FILE_LIMIT;
		const seen = new Set<string>();
		let changed = 0;
		let added = 0;
		for (const absPath of fs.walk(this.root)) {
			if (seen.size >= maxFiles) break;
			const rel = toPosix(relative(this.root, absPath));
			if (!parser.languageForFile(rel)) continue;
			if (!shouldIndexSource(fs, this.root, rel)) continue;
			const stat = fs.stat(absPath);
			if (!stat || stat.size > MAX_FILE_BYTES) continue;
			const existing = store.getFileMeta(rel);
			const source = fs.readFile(absPath);
			if (source === undefined || !shouldIndexSource(fs, this.root, rel, source)) continue;
			seen.add(rel);
			if (!existing) added++;
			else if (existing.hash !== sha256(source)) changed++;
		}
		// Mirror sync semantics: rows outside the current deterministic capped corpus are stale.
		const deleted = store.allFiles().filter((file) => !seen.has(file.path)).length;
		return { changed, new: added, deleted };
	}

	/**
	 * Ensure one indexable source file's facts are current: git-style fast path (unchanged
	 * mtime+size → skip), content-confirm by hash (touched-but-identical → refresh mtime
	 * only), else parse + upsert. Returns whether it re-parsed (a mutation).
	 */
	private async ensureFileIndexed(
		rel: string,
		abs: string,
		lang: string,
		mtimeMs: number,
		size: number,
		forceContentCheck = false,
	): Promise<boolean> {
		const { fs, parser, store } = this.deps;
		const existing = store.getFileMeta(rel);
		if (!forceContentCheck && existing && existing.mtimeMs === mtimeMs && existing.size === size) return false;
		const source = fs.readFile(abs);
		if (source === undefined) return false;
		if (!shouldIndexSource(fs, this.root, rel, source)) {
			// Source-text filter (e.g. a newly-added generated-by banner) now rejects the file;
			// drop any facts we held for it so they don't go stale.
			if (!existing) return false;
			store.transaction(() => {
				store.setMeta("occurrences_dirty", "1");
				store.deleteFile(rel);
			});
			return true;
		}
		const hash = sha256(source);
		if (existing && existing.hash === hash) {
			store.touchFile(rel, mtimeMs, hash);
			return false;
		}
		const parsed = await parser.parse(rel, source);
		if (!parsed) {
			// A supported extension whose grammar/query cannot currently load must not keep
			// previously indexed facts that now look current. Drop the cache entry so status
			// and reads fail conservatively until a later successful sync restores it.
			if (!existing) return false;
			store.transaction(() => {
				store.setMeta("occurrences_dirty", "1");
				store.deleteFile(rel);
			});
			return true;
		}
		store.transaction(() => {
			store.setMeta("occurrences_dirty", "1");
			store.upsertFileFacts(rel, lang, mtimeMs, size, hash, buildFacts(rel, parsed));
		});
		return true;
	}
}

/**
 * A changed declaration name that some barrel re-exports under an alias (`export { name as alias }`)
 * forces a global rebuild: importers bind to the alias, not this name, so making a dangling re-export
 * live (adding the name) or killing a live one is invisible to name / reverse-dependency matching.
 */
function reexportRerouted(pre: PreSyncCapture, post: PreSyncCapture, reexportImported: Set<string>): boolean {
	if (reexportImported.size === 0) return false;
	const before = new Set(pre.names);
	const after = new Set(post.names);
	for (const name of reexportImported) {
		if (before.has(name) !== after.has(name)) return true;
	}
	return false;
}

/** Any changed/deleted file whose inheritance-edge signature differs old-vs-new forces a global
 * rebuild: an `extends`/`implements` swap can re-route inherited-member dispatch in grandchild files
 * that reference no changed name, a transitive closure not worth computing incrementally. */
function inheritanceChanged(pre: PreSyncCapture, post: PreSyncCapture): boolean {
	for (const path of new Set([...pre.inheritance.keys(), ...post.inheritance.keys()])) {
		if ((pre.inheritance.get(path) ?? "") !== (post.inheritance.get(path) ?? "")) return true;
	}
	return false;
}

function resolutionFactsChanged(pre: PreSyncCapture, post: PreSyncCapture): boolean {
	for (const path of new Set([...pre.resolutionFacts.keys(), ...post.resolutionFacts.keys()])) {
		if ((pre.resolutionFacts.get(path) ?? "") !== (post.resolutionFacts.get(path) ?? "")) return true;
	}
	return false;
}

/**
 * File ids whose occurrences may have changed and must be re-resolved: the changed files themselves
 * (a), files that resolved INTO them before the edit (d, captured pre-mutation), and files that
 * reference or import a changed declaration / re-export name (b, c). Every ref resolves against the
 * complete snapshot independently of other files' occurrences, so re-resolving just these files is
 * equivalent to a full rebuild — unaffected files reference no changed name and bind unchanged.
 */
/** Mint monikers for declarations and attribute each reference to its enclosing definition. */
function buildFacts(file: string, parsed: ParsedFile): FileFacts {
	const symbols: SymbolRecord[] = parsed.symbols.map((symbol) => ({
		moniker: buildMoniker({
			file,
			name: symbol.name,
			kind: symbol.kind,
			startLine: symbol.range[0],
			startCol: symbol.range[1],
			ownerType: symbol.ownerType,
		}),
		name: symbol.name,
		kind: symbol.kind,
		file,
		range: symbol.range,
		nameRange: symbol.nameRange,
		exported: symbol.exported,
		...(symbol.exportedAs ? { exportedAs: symbol.exportedAs } : {}),
		...(symbol.ownerType ? { ownerType: symbol.ownerType } : {}),
		...(symbol.isStatic ? { isStatic: true } : {}),
		...(symbol.isAbstract ? { isAbstract: true } : {}),
		...(symbol.visibility ? { visibility: symbol.visibility } : {}),
		...(symbol.paramCount === undefined ? {} : { paramCount: symbol.paramCount }),
		...(symbol.variadic ? { variadic: true } : {}),
	}));

	const references: StoredReference[] = parsed.references.map((ref) => {
		const enclosing = enclosingMoniker(ref.range, symbols);
		return {
			name: ref.name,
			role: ref.role,
			range: ref.range,
			...(ref.receiver ? { receiver: ref.receiver } : {}),
			...(enclosing ? { enclosing } : {}),
			...(ref.argCount === undefined ? {} : { argCount: ref.argCount }),
		};
	});

	const scopes: StoredScope[] = parsed.scopes.map((scope, idx) => ({
		idx,
		parentIdx: scope.parentIndex,
		range: scope.range,
	}));
	const scopeDefs: StoredScopeDef[] = parsed.scopeDefs.map((def) => ({
		scopeIdx: def.scopeIndex,
		name: def.name,
		moniker: def.symbolIndex === null ? null : (symbols[def.symbolIndex]?.moniker ?? null),
	}));

	return { symbols, references, imports: parsed.imports, scopes, scopeDefs };
}

/** The smallest definition whose range CONTAINS the reference start position (line+column). */
function enclosingMoniker(range: Range, symbols: SymbolRecord[]): string | undefined {
	const [line, col] = range;
	let best: SymbolRecord | undefined;
	let bestSpan = Number.POSITIVE_INFINITY;
	for (const symbol of symbols) {
		const [sl, sc, el, ec] = symbol.range;
		if (line < sl || line > el) continue;
		if (line === sl && col < sc) continue;
		if (line === el && col > ec) continue;
		// Column-weighted span so same-line nested defs (e.g. an inner arrow) win over outer ones.
		const span = (el - sl) * 100_000 + (ec - sc);
		if (span < bestSpan) {
			bestSpan = span;
			best = symbol;
		}
	}
	return best?.moniker;
}

function toPosix(path: string): string {
	return path.replaceAll("\\", "/");
}

function sha256(source: string): string {
	return createHash("sha256").update(source).digest("hex");
}

function yieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}
