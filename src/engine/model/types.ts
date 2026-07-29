/**
 * Core data model: everything is occurrences over symbols.
 *
 * Resolution prefers precise evidence and retains bounded ambiguous candidate sets.
 * Intractable name-only fan-out is suppressed rather than materialized as false edges.
 * A higher-provenance occurrence replaces a lower one for the same range, so layers
 * can refine results without coordinating.
 */

/** Which layer produced a fact. Ordered low → high precision; higher overwrites lower. */
export type Provenance = "syntactic" | "scoped" | "typed" | "scip" | "lsp";

/** Precedence rank for a provenance; higher wins on conflict. */
export const PROVENANCE_RANK: Readonly<Record<Provenance, number>> = {
	syntactic: 1,
	scoped: 2,
	typed: 3,
	scip: 4,
	lsp: 5,
};

/** What an occurrence does at its location. */
export type Role =
	| "definition"
	| "reference"
	| "call"
	| "read"
	| "write"
	| "import"
	/** subtype → base class (`class Dog extends Animal`). */
	| "extends"
	/** implementer → interface (`class Dog implements Pet`). */
	| "implements";

/** Roles a pre-resolution reference/relation can carry (definitions are not references). */
export type ReferenceRole = Extract<Role, "call" | "reference" | "extends" | "implements">;

/** Inheritance roles — the edges that form the type hierarchy. */
export const INHERITANCE_ROLES: readonly ReferenceRole[] = ["extends", "implements"];

/** [startLine, startCol, endLine, endCol]. Lines are 1-based; columns are 0-based. */
export type Range = readonly [number, number, number, number];

/** Member access level, where the language expresses one. */
export type Visibility = "public" | "protected" | "private";

/** A declared symbol. `moniker` is the stable id occurrences point at. */
export interface SymbolRecord {
	/** Stable id (SCIP-style descriptor); unique within a repo index. */
	moniker: string;
	name: string;
	/** function | class | method | type | interface | module | constant | ... */
	kind: string;
	/** Repo-relative POSIX path. */
	file: string;
	/** Full declaration span (signature/body), used for display and navigation. */
	range: Range;
	/** Range of the declared name token alone; precise enough for rename/highlight. */
	nameRange?: Range;
	exported: boolean;
	/** Export alias when re-exported under another name (e.g. "default"). */
	exportedAs?: string;
	/** Receiver/owner type for methods (e.g. "Foo"); disambiguates same-name methods. */
	ownerType?: string;
	/** Class-level member (`static`/`@staticmethod`); absent = unknown, not "instance". */
	isStatic?: boolean;
	/** Explicitly marked abstract (`abstract` keyword / `@abstractmethod`); absent = unknown. */
	isAbstract?: boolean;
	/** Access level (explicit modifier, or Python naming convention); absent = unknown. */
	visibility?: Visibility;
	/** Declared parameter count for callables; absent = not a callable / unknown. */
	paramCount?: number;
	/** Callable accepts a variable number of args (rest/`*args`/variadic). */
	variadic?: boolean;
}

/** A resolved occurrence of a symbol (reference/call/import). Definitions live on SymbolRecord. */
export interface OccurrenceRecord {
	/** Moniker of the target symbol this occurrence binds to. */
	symbol: string;
	/** Repo-relative POSIX path where the occurrence sits. */
	file: string;
	range: Range;
	role: Role;
	/** Moniker of the symbol this occurrence sits inside (the caller). */
	enclosing?: string;
	provenance: Provenance;
	/** Heuristic resolver score in [0,1]; ambiguous matches share their score across candidates. */
	confidence: number;
}

/** Persisted file metadata used for incremental sync. */
export interface FileMeta {
	id: number;
	path: string;
	lang: string;
	mtimeMs: number;
	size: number;
	/** SHA-256 of file contents at last index; used to skip re-parsing unchanged-but-touched files. */
	hash?: string;
}

export interface IndexStatus {
	root: string;
	files: number;
	symbols: number;
	occurrences: number;
	truncated: boolean;
	lastSyncAt?: string;
}

export interface SyncResult {
	indexedFiles: number;
	removedFiles: number;
	totalFiles: number;
	symbols: number;
	truncated: boolean;
	durationMs: number;
}
