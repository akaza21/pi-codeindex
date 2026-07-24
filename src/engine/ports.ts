/**
 * Ports: the only contracts the core depends on. Adapters implement
 * these; nothing pi-/io-specific leaks inward. Tests inject in-memory fakes.
 */

import type {
	FileMeta,
	IndexStatus,
	OccurrenceRecord,
	Range,
	ReferenceRole,
	Role,
	SymbolRecord,
	SyncResult,
	Visibility,
} from "./model/types.ts";

export interface FileStat {
	mtimeMs: number;
	size: number;
}

export interface FileSystem {
	/** Read a file as UTF-8, or undefined if unreadable. */
	readFile(absPath: string): string | undefined;
	stat(absPath: string): FileStat | undefined;
	exists(absPath: string): boolean;
	/** Reset repository ignore state before an incremental source scan. */
	refreshIgnoreRules?(root: string): void;
	/** Whether repository-local ignore rules or a nested-repository boundary exclude a path. */
	isIgnored?(root: string, relativePath: string, directory?: boolean): boolean;
	/** Yield absolute file paths under `root`, skipping ignored/pruned dirs (impl-defined). */
	walk(root: string): Iterable<string>;
}

export type ImportKind = "named" | "default" | "namespace" | "wildcard" | "side-effect" | "reexport" | "reexport-star";

/** A declaration as seen by the parser, before a moniker is minted. */
export interface ParsedSymbol {
	kind: string;
	name: string;
	range: Range;
	/** Range of the declared name token alone (the `range` covers the whole declaration). */
	nameRange: Range;
	exported: boolean;
	exportedAs?: string;
	ownerType?: string;
	isStatic?: boolean;
	isAbstract?: boolean;
	visibility?: Visibility;
	/** Declared parameter count for callables; absent = not a callable / unknown. */
	paramCount?: number;
	/** Callable accepts a variable number of args (rest/`*args`/variadic). */
	variadic?: boolean;
}

/** An unresolved use of a name (call/reference/inheritance), before binding to a symbol. */
export interface ParsedReference {
	name: string;
	role: ReferenceRole;
	range: Range;
	/** Receiver/namespace text (e.g. `foo` in `foo.bar()`), when present. */
	receiver?: string;
	/** Argument count at a call site; absent = not a call / unknown. */
	argCount?: number;
}

export interface ParsedImport {
	source: string;
	kind: ImportKind;
	imported?: string;
	local?: string;
	/** Java `import static`: `source` is the class FQN and `imported`/`local` is the member. */
	isStatic?: boolean;
}

/** A lexical scope node in a file's scope graph. */
export interface ParsedScope {
	range: Range;
	/** Index of the enclosing scope in the same file's scope list; null for the file root. */
	parentIndex: number | null;
}

/** A name binding placed in a scope. `symbolIndex` links to an indexed declaration; null = local-only. */
export interface ParsedScopeDef {
	name: string;
	scopeIndex: number;
	symbolIndex: number | null;
}

export interface ParsedFile {
	symbols: ParsedSymbol[];
	references: ParsedReference[];
	imports: ParsedImport[];
	/** Per-file scope graph; empty for languages without scope rules. */
	scopes: ParsedScope[];
	scopeDefs: ParsedScopeDef[];
}

/** One captured node of a structural match. */
export interface StructuralCapture {
	name: string;
	range: Range;
	text: string;
}

/** One match of a structural query: the span over its captures, plus the captures themselves. */
export interface StructuralMatch {
	range: Range;
	captures: StructuralCapture[];
}

/** A compiled structural query, reusable across files. `free()` releases its native memory. */
export interface StructuralQuery {
	match(source: string): StructuralMatch[];
	free(): void;
}

export interface Parser {
	languageForFile(path: string): string | undefined;
	supportedExtensions(): readonly string[];
	parse(path: string, source: string): Promise<ParsedFile | undefined>;
	/**
	 * Compile a raw tree-sitter query for `lang` into a reusable matcher. Strict: throws a
	 * clear error if the language is unavailable or the query is malformed (unlike the lenient
	 * compilation used for bundled query files), and requires the query to capture ≥ 1 node.
	 */
	structuralQuery(lang: string, pattern: string): Promise<StructuralQuery>;
}

/** Raw facts for one file, with monikers and enclosing already attributed. */
export interface FileFacts {
	symbols: SymbolRecord[];
	references: StoredReference[];
	imports: ParsedImport[];
	scopes: StoredScope[];
	scopeDefs: StoredScopeDef[];
}

export interface StoredScope {
	idx: number;
	parentIdx: number | null;
	range: Range;
}

export interface StoredScopeDef {
	scopeIdx: number;
	name: string;
	/** Moniker of the bound indexed declaration, or null for a local-only binding (param/var). */
	moniker: string | null;
}

/** A reference persisted before resolution; resolved into occurrences during rebuild. */
export interface StoredReference {
	name: string;
	role: ReferenceRole;
	range: Range;
	receiver?: string;
	/** Moniker of the enclosing definition (the caller), if any. */
	enclosing?: string;
	argCount?: number;
}

export interface SymbolHit {
	name: string;
	kind: string;
	file: string;
	range: Range;
	/** Stable id for this exact declaration; pass it back to a by-moniker query to disambiguate. */
	moniker?: string;
	exported: boolean;
	ownerType?: string;
	isStatic?: boolean;
	isAbstract?: boolean;
	visibility?: Visibility;
}

export interface OccurrenceHit {
	/** Target symbol name. */
	name: string;
	/** Enclosing symbol name, or "(top level)". */
	enclosing: string;
	file: string;
	range: Range;
	role: Role;
	provenance: string;
	confidence: number;
	depth?: number;
	/** Impact only: how many call sites this enclosing symbol contributes (aggregated). */
	sites?: number;
}

/** Why a by-name read returned nothing: not-found vs. defined-but-unused vs. suppressed-ambiguous. */
export type EmptyReason =
	| { kind: "no-symbol" }
	| { kind: "no-edges"; definitions: number }
	| { kind: "suppressed"; definitions: number; sites: number };

/** Definition and bounded relationship data returned by an explore query. */
export interface ExplorationResult {
	/** All definitions for a name selector; a single element for a moniker selector; [] if unknown. */
	candidates: SymbolHit[];
	ambiguous: boolean;
	/** The subject, set only when exactly one candidate resolved. */
	resolved?: SymbolHit;
	callers: OccurrenceHit[];
	callees: OccurrenceHit[];
	implementers: OccurrenceHit[];
	supertypes: OccurrenceHit[];
	callerTotal: number;
	calleeTotal: number;
	/** Reverse-call reach counts by hop depth (summary, capped-traversal counts, not exact totals). */
	impactByDepth: { 1: number; 2: number };
}

/**
 * Persistence + read contract. The resolution pipeline writes occurrences; the query
 * layer and adapters read through the same port.
 */
export interface Store {
	// lifecycle
	getMeta(key: string): string | undefined;
	setMeta(key: string, value: string): void;
	transaction<T>(fn: () => T): T;
	close(): void;

	// incremental fact persistence
	getFileMeta(path: string): FileMeta | undefined;
	allFiles(): FileMeta[];
	upsertFileFacts(path: string, lang: string, mtimeMs: number, size: number, hash: string, facts: FileFacts): void;
	/** Refresh stored mtime (and hash) when content is unchanged but the file was touched. */
	touchFile(path: string, mtimeMs: number, hash: string): void;
	deleteFile(path: string): void;

	// resolution
	/** Build a resolver view. When file ids are supplied, load only their refs plus inheritance refs. */
	snapshot(referenceFileIds?: ReadonlySet<number>): ResolveSnapshot;
	/** Build the lightweight file/import/layout view used by import-graph queries. */
	importSnapshot(): ImportSnapshot;
	/** Compute the files whose bindings can change after a scoped source update. */
	affectedFileIds(paths: readonly string[], names: ReadonlySet<string>, dependents: readonly number[]): Set<number>;
	/** Write the resolver's occurrences (replaces every non-ingested row; leaves `scip` rows intact). */
	replaceOccurrences(occurrences: Iterable<OccurrenceRecord>): void;
	/**
	 * Scoped rebuild: replace only the non-ingested occurrences in `fileIds` with `occurrences`
	 * (which must already be scoped to those files). Unaffected files' rows and all `scip` rows stay.
	 */
	replaceOccurrencesForFiles(fileIds: ReadonlySet<number>, occurrences: Iterable<OccurrenceRecord>): void;
	/**
	 * Pre-mutation snapshot for scoped re-resolution: reverse dependents plus the declaration /
	 * re-export names and inheritance-edge signature of `paths`. Captured BEFORE upsert/delete
	 * because `ON DELETE CASCADE` and moniker position-shifts destroy the reverse-dependency evidence.
	 */
	capturePreSync(paths: readonly string[]): PreSyncCapture;
	/** Distinct `imported_name`s of every named re-export (`export { X as Y } from …`) in the index. */
	reexportImportedNames(): Set<string>;
	/** Write ingested SCIP occurrences (replaces only `provenance: "scip"` rows). */
	replaceIngestedOccurrences(occurrences: OccurrenceRecord[]): void;

	// bulk reads (export)
	/** Every indexed declaration, for whole-index export (e.g. SCIP). */
	allSymbols(): SymbolRecord[];
	/**
	 * Every persisted occurrence whose target symbol is present, for whole-index export (e.g. SCIP).
	 * Occurrences are stored by integer symbol FK, so an occurrence whose target symbol does not
	 * exist is not persisted (and never surfaced) — the resolver/ingest only emit existing monikers,
	 * so this excludes nothing real; it just can't return a dangling target.
	 */
	allOccurrences(): OccurrenceRecord[];
	/** Cheap existence check: is any symbol indexed? (avoids the full counts in `status()`). */
	hasSymbols(): boolean;

	// agent-facing reads
	search(query: string, limit: number): SymbolHit[];
	/** Return a definition with bounded callers, callees, hierarchy, and impact counts. */
	explore(sel: { name: string } | { moniker: string }): ExplorationResult;
	definitions(name: string, limit: number): SymbolHit[];
	callers(name: string, limit: number): OccurrenceHit[];
	callees(name: string, limit: number): OccurrenceHit[];
	references(name: string, limit: number): OccurrenceHit[];
	// By-moniker variants: target one exact declaration (from a prior result's `moniker`) instead
	// of every same-named symbol, so the agent can disambiguate after a name query.
	callersByMoniker(moniker: string, limit: number): OccurrenceHit[];
	calleesByMoniker(moniker: string, limit: number): OccurrenceHit[];
	referencesByMoniker(moniker: string, limit: number): OccurrenceHit[];
	impactByMoniker(moniker: string, depth: number, limit: number): OccurrenceHit[];
	/** Types that extend/implement `name` (incoming inheritance edges). */
	implementers(name: string, limit: number): OccurrenceHit[];
	/** Types that `name` extends/implements (outgoing inheritance edges). */
	supertypes(name: string, limit: number): OccurrenceHit[];
	impact(name: string, depth: number, limit: number): OccurrenceHit[];
	/** Explain a zero-result by-name read: not indexed, indexed-but-unused, or fan-out-suppressed. */
	diagnoseEmpty(name: string): EmptyReason;
	files(pattern: string | undefined, limit: number): string[];
	status(): IndexStatus;
	isReady(): boolean;
}

/** Immutable cross-file view used by resolver providers for one rebuild. */
export interface ResolveSnapshot {
	references: SnapshotReference[];
	symbolsByName(name: string): readonly SnapshotSymbol[];
	exportedSymbols(fileId: number): readonly SnapshotSymbol[];
	importsInFile(fileId: number): readonly ParsedImport[];
	pathByFileId(fileId: number): string | undefined;
	/** Lexical (scope-graph) binding of a name at a position within a file. */
	scopeBinding(fileId: number, name: string, line: number, col: number, scopeIdx?: number): ScopeBinding;
	/** Moniker of the smallest indexed symbol whose range contains (line,col) in `path`. */
	symbolAt(path: string, line: number, col: number): string | undefined;
	/**
	 * Moniker of the symbol whose *declared name token* starts exactly at (line,col) in `path`.
	 * Unlike `symbolAt` (containment), this matches only a real declaration at that position — so a
	 * SCIP definition for an entity we do not index as a symbol (e.g. an interface method spec, an
	 * attr-generated accessor) yields nothing instead of mis-mapping to its enclosing symbol.
	 */
	symbolAtName(path: string, line: number, col: number): string | undefined;

	// Generic index primitives for the cross-file binders (Go/Python/Java imports).
	// No language logic lives here; the per-language binders compose these.
	/** File id for an exact repo-relative path. */
	fileIdByPath(path: string): number | undefined;
	/** The declaration with this moniker, if indexed. */
	symbolByMoniker(moniker: string): SnapshotSymbol | undefined;
	/** Symbols named `name` declared in a specific file. */
	symbolsInFileNamed(fileId: number, name: string): readonly SnapshotSymbol[];
	/** Repo-relative directory of a file ("" for repo root). */
	dirOf(fileId: number): string;
	/** File ids whose directory is exactly `dir`. */
	fileIdsInDir(dir: string): readonly number[];
	/** Whether any indexed file lives directly in `dir`. */
	hasDir(dir: string): boolean;
	/** File ids whose path ends with `suffix` (segment-aligned), for module/package layouts. */
	filesEndingWith(suffix: string): readonly number[];
	/** Per-repo config that affects import resolution (tsconfig paths/baseUrl, go.mod module). */
	projectLayout(): import("./imports/project-layout.ts").ProjectLayout;
}

/** Minimal resolver view needed to map import specifiers to indexed files. */
export type ImportSnapshot = Pick<ResolveSnapshot, "importsInFile" | "fileIdByPath" | "projectLayout">;

/** Inputs the indexer needs to compute the scoped affected-file set (see `Store.capturePreSync`). */
export interface PreSyncCapture {
	/** File ids whose occurrences currently resolve INTO the captured paths (target symbol lives there). */
	dependents: number[];
	/** Declaration names, exported-as names, and re-export imported/local names in the captured paths. */
	names: string[];
	/** Per-path canonical multiset of inheritance references (`role|name|enclosing`), for wiring-change detection. */
	inheritance: Map<string, string>;
	/** Per-path canonical declaration/import facts that can alter cross-file binding. */
	resolutionFacts: Map<string, string>;
}

export interface ScopeBinding {
	/** True when the name binds to some declaration in an enclosing scope. */
	bound: boolean;
	/** Moniker of the bound indexed declaration when the binding is tracked. */
	moniker?: string;
}

export interface SnapshotSymbol {
	moniker: string;
	fileId: number;
	name: string;
	kind: string;
	exported: boolean;
	exportedAs?: string;
	/** Owner type for members (the declaring class/interface name). */
	ownerType?: string;
	range: Range;
	/** Range of the declared name token alone (used for exact-location matching, e.g. SCIP ingest). */
	nameRange: Range;
	/** Member metadata for inheritance-aware ranking; absent = unknown (see SymbolRecord). */
	isStatic?: boolean;
	isAbstract?: boolean;
	visibility?: Visibility;
	paramCount?: number;
	variadic?: boolean;
}

export interface SnapshotReference {
	id: number;
	fileId: number;
	path: string;
	name: string;
	role: ReferenceRole;
	receiver?: string;
	range: Range;
	enclosing?: string;
	argCount?: number;
	/** Precomputed innermost lexical scope. Internal snapshots populate this to keep resolution O(refs). */
	scopeIdx?: number;
}

/**
 * Sentinel moniker meaning "this reference binds to a local non-symbol (param/var)".
 * A provider returns it to terminally suppress lower-tier resolution; the pipeline
 * treats it as a binding (stops) but emits no occurrence.
 */
export const LOCAL_BINDING = "\u0000local";

export interface ResolvedTarget {
	/** Moniker of the bound symbol, or LOCAL_BINDING for a terminal local suppression. */
	moniker: string;
	/** How the binding was found (e.g. "same-file", "import", "name"). */
	resolution: string;
	/** Provider-local confidence before pipeline weighting. */
	confidence: number;
}

export interface ResolverProvider {
	tier: 1 | 2 | 3 | 4;
	provenance: import("./model/types.ts").Provenance;
	languages: ReadonlySet<string> | "*";
	available(snapshot: ResolveSnapshot): boolean;
	/** Recall-first: one confident target, or a ranked candidate list. */
	resolve(ref: SnapshotReference, snapshot: ResolveSnapshot): ResolvedTarget[];
}

export interface Clock {
	now(): number;
	isoNow(): string;
}

export type { FileMeta, IndexStatus, Range, SymbolRecord, SyncResult };
