/**
 * SQLite Store adapter. One per-repo database, WAL + busy_timeout so
 * a background sync worker and the main-thread reader can share it. Implements the
 * Store port: incremental fact persistence, an in-memory resolution snapshot, full
 * occurrence rebuild, and the agent-facing reads.
 */

import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isSafeRepoRelativePath } from "../adapters/repo-path.ts";
import { EMPTY_LAYOUT, type ProjectLayout } from "../imports/project-layout.ts";
import {
	INHERITANCE_ROLES,
	type IndexStatus,
	type OccurrenceRecord,
	PROVENANCE_RANK,
	type Range,
	type SymbolRecord,
} from "../model/types.ts";
import type {
	EmptyReason,
	ExplorationResult,
	FileFacts,
	FileMeta,
	ImportSnapshot,
	OccurrenceHit,
	ParsedImport,
	PreSyncCapture,
	ResolveSnapshot,
	ScopeBinding,
	SnapshotReference,
	SnapshotSymbol,
	Store,
	SymbolHit,
} from "../ports.ts";
import { MAX_NAME_FANOUT } from "../resolve/ranking.ts";
import { DROP_SQL, INDEX_FORMAT_VERSION, SCHEMA_SQL } from "./schema.ts";

const CALL_ROLES = "('call','reference')";
/** SQL `IN (...)` list of the inheritance roles, derived from the one role source. */
const INHERITANCE_ROLES_SQL = `(${INHERITANCE_ROLES.map((role) => `'${role}'`).join(",")})`;
const MIN_IMPACT_CONFIDENCE = 0.1;
/** Impact dedup sentinel for the shared `(top level)` bucket (no enclosing symbol). */
const TOP_LEVEL = "\u0000toplevel";

/**
 * Deterministic, precision-aware ordering for occurrence reads. Confidence is the
 * primary key; equal-confidence hits break ties by provenance (a type-checked binding
 * outranks a same-name guess), then by stable location so results never reorder between
 * runs. Built from the single provenance-rank source so the two never drift.
 */
const PROVENANCE_ORDER = `CASE occ.provenance ${Object.entries(PROVENANCE_RANK)
	.map(([provenance, rank]) => `WHEN '${provenance}' THEN ${rank}`)
	.join(" ")} ELSE 0 END`;
const OCCURRENCE_ORDER = `ORDER BY occ.confidence DESC, ${PROVENANCE_ORDER} DESC, f.path, occ.s_line, occ.s_col, occ.id`;

/** Provenance of externally-ingested (SCIP) occurrences: authoritative, preserved across syncs. */
const SCIP_PROVENANCE = "scip";

/** Shared search projection: FTS columns plus the exact-location moniker for each symbol row. */
const SEARCH_COLUMNS = `name, kind, path, s_line, s_col, e_line, e_col, exported, owner_type,
		(SELECT s.moniker FROM symbols s
			WHERE s.file_id = sym_fts.file_id AND s.s_line = sym_fts.s_line AND s.s_col = sym_fts.s_col
			AND s.e_line = sym_fts.e_line AND s.e_col = sym_fts.e_col LIMIT 1) AS moniker`;

type Row = Record<string, unknown>;

export class SqliteStore implements Store {
	private readonly db: DatabaseSync;
	private readonly root: string;

	constructor(root: string, dbPath: string) {
		this.root = resolve(root);
		this.db = new DatabaseSync(dbPath);
		try {
			// busy_timeout first: the WAL switch itself takes a lock and must wait out a
			// concurrent writer (e.g. a sync worker on the same repo).
			this.db.exec("PRAGMA busy_timeout = 5000");
			this.db.exec("PRAGMA journal_mode = WAL");
			// Enforce ON DELETE CASCADE on occurrences (off by default in SQLite); must be set per
			// connection and outside any transaction. This keeps a deleted symbol's occurrences from
			// surviving to rebind to a later symbol that reuses its rowid.
			this.db.exec("PRAGMA foreign_keys = ON");
			// Speed pragmas for an index that is always rebuildable (so durability of the last write
			// matters less than throughput): NORMAL fsync is WAL-safe (no corruption, only the last txn
			// is at risk on OS crash), an in-memory page cache and temp store cut sync time, and a 64 MB
			// mmap makes the agent-facing reads largely memory-speed.
			this.db.exec("PRAGMA synchronous = NORMAL");
			this.db.exec("PRAGMA temp_store = MEMORY");
			this.db.exec("PRAGMA cache_size = -16000");
			this.db.exec("PRAGMA mmap_size = 67108864");
			this.migrate();
		} catch (error) {
			try {
				this.db.close();
			} catch {}
			throw error;
		}
	}

	getMeta(key: string): string | undefined {
		const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as Row | undefined;
		return row ? String(row.value) : undefined;
	}

	setMeta(key: string, value: string): void {
		this.db
			.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
			.run(key, value);
	}

	transaction<T>(fn: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const result = fn();
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			try {
				this.db.exec("ROLLBACK");
			} catch {}
			throw error;
		}
	}

	close(): void {
		this.db.close();
	}

	private migrate(): void {
		this.db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
		const current = this.getMeta("index_format_version");
		const storedRoot = this.getMeta("repository_root");
		if (current !== INDEX_FORMAT_VERSION || storedRoot !== this.root) {
			this.resetSchema();
			return;
		}
		this.db.exec(SCHEMA_SQL);
		const unsafe = (
			this.db.prepare("SELECT path FROM files").all() as Array<{
				path?: unknown;
			}>
		).some((row) => !isSafeRepoRelativePath(String(row.path ?? "")));
		if (unsafe) this.resetSchema();
	}

	private resetSchema(): void {
		this.db.exec(DROP_SQL);
		this.db.exec("DELETE FROM meta");
		this.db.exec(SCHEMA_SQL);
		this.setMeta("index_format_version", INDEX_FORMAT_VERSION);
		this.setMeta("repository_root", this.root);
	}

	getFileMeta(path: string): FileMeta | undefined {
		const row = this.db.prepare("SELECT id, path, lang, mtime_ms, size, hash FROM files WHERE path = ?").get(path) as
			| Row
			| undefined;
		return row ? fileMeta(row) : undefined;
	}

	allFiles(): FileMeta[] {
		return (this.db.prepare("SELECT id, path, lang, mtime_ms, size, hash FROM files").all() as Row[]).map(fileMeta);
	}

	allSymbols(): SymbolRecord[] {
		const rows = this.db
			.prepare(
				`SELECT s.moniker, s.name, s.kind, f.path, s.s_line, s.s_col, s.e_line, s.e_col,
					s.name_s_line, s.name_s_col, s.name_e_line, s.name_e_col, s.exported, s.export_name, s.owner_type
				FROM symbols s JOIN files f ON f.id = s.file_id ORDER BY s.id`,
			)
			.all() as Row[];
		return rows.map((row) => ({
			moniker: String(row.moniker),
			name: String(row.name),
			kind: String(row.kind),
			file: String(row.path),
			range: [Number(row.s_line), Number(row.s_col), Number(row.e_line), Number(row.e_col)],
			nameRange: [Number(row.name_s_line), Number(row.name_s_col), Number(row.name_e_line), Number(row.name_e_col)],
			exported: Number(row.exported) === 1,
			...(row.export_name === null ? {} : { exportedAs: String(row.export_name) }),
			...(row.owner_type === null ? {} : { ownerType: String(row.owner_type) }),
		}));
	}

	allOccurrences(): OccurrenceRecord[] {
		const rows = this.db
			.prepare(
				`SELECT target.moniker AS symbol_moniker, f.path, occ.s_line, occ.s_col, occ.e_line, occ.e_col, occ.role,
					caller.moniker AS enclosing, occ.provenance, occ.confidence
				FROM occurrences occ
				JOIN symbols target ON target.id = occ.symbol_id
				LEFT JOIN symbols caller ON caller.id = occ.enclosing_id
				JOIN files f ON f.id = occ.file_id ORDER BY occ.id`,
			)
			.all() as Row[];
		return rows.map((row) => ({
			symbol: String(row.symbol_moniker),
			file: String(row.path),
			range: [Number(row.s_line), Number(row.s_col), Number(row.e_line), Number(row.e_col)],
			role: String(row.role) as OccurrenceRecord["role"],
			...(row.enclosing === null ? {} : { enclosing: String(row.enclosing) }),
			provenance: String(row.provenance) as OccurrenceRecord["provenance"],
			confidence: Number(row.confidence),
		}));
	}

	touchFile(path: string, mtimeMs: number, hash: string): void {
		this.db.prepare("UPDATE files SET mtime_ms = ?, hash = ? WHERE path = ?").run(mtimeMs, hash, path);
	}

	upsertFileFacts(path: string, lang: string, mtimeMs: number, size: number, hash: string, facts: FileFacts): void {
		if (!isSafeRepoRelativePath(path)) throw new Error(`refusing to store a path outside the repository: ${path}`);
		const { fileId, existed } = this.upsertFile(path, lang, mtimeMs, size, hash);
		// A new file cannot have child rows. Skipping the deletes matters for FTS5: deleting by the
		// UNINDEXED file_id column scans the growing virtual table and made fresh builds quadratic.
		if (existed) {
			this.clearMutableFileRows(fileId);
			const incoming = new Set(facts.symbols.map((symbol) => symbol.moniker));
			for (const row of this.db.prepare("SELECT id, moniker FROM symbols WHERE file_id = ?").all(fileId) as Row[]) {
				if (!incoming.has(String(row.moniker)))
					this.db.prepare("DELETE FROM symbols WHERE id = ?").run(Number(row.id));
			}
		}
		const insertSymbol = this.db.prepare(
			`INSERT INTO symbols (moniker, file_id, name, kind, s_line, s_col, e_line, e_col, name_s_line, name_s_col, name_e_line, name_e_col, exported, export_name, owner_type, is_static, is_abstract, visibility, param_count, variadic)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(moniker) DO UPDATE SET
				file_id=excluded.file_id, name=excluded.name, kind=excluded.kind,
				s_line=excluded.s_line, s_col=excluded.s_col, e_line=excluded.e_line, e_col=excluded.e_col,
				name_s_line=excluded.name_s_line, name_s_col=excluded.name_s_col,
				name_e_line=excluded.name_e_line, name_e_col=excluded.name_e_col,
				exported=excluded.exported, export_name=excluded.export_name, owner_type=excluded.owner_type,
				is_static=excluded.is_static, is_abstract=excluded.is_abstract, visibility=excluded.visibility,
				param_count=excluded.param_count, variadic=excluded.variadic`,
		);
		const insertFts = this.db.prepare(
			`INSERT INTO sym_fts (name, kind, path, s_line, s_col, e_line, e_col, exported, owner_type, file_id)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		for (const symbol of facts.symbols) {
			const [sl, sc, el, ec] = symbol.range;
			const [nsl, nsc, nel, nec] = symbol.nameRange ?? symbol.range;
			insertSymbol.run(
				symbol.moniker,
				fileId,
				symbol.name,
				symbol.kind,
				sl,
				sc,
				el,
				ec,
				nsl,
				nsc,
				nel,
				nec,
				symbol.exported ? 1 : 0,
				symbol.exportedAs ?? null,
				symbol.ownerType ?? null,
				symbol.isStatic ? 1 : 0,
				symbol.isAbstract ? 1 : 0,
				symbol.visibility ?? null,
				symbol.paramCount ?? null,
				symbol.variadic ? 1 : 0,
			);
			insertFts.run(
				symbol.name,
				symbol.kind,
				path,
				sl,
				sc,
				el,
				ec,
				symbol.exported ? 1 : 0,
				symbol.ownerType ?? null,
				fileId,
			);
		}
		const insertRef = this.db.prepare(
			"INSERT INTO refs (file_id, name, role, s_line, s_col, e_line, e_col, receiver, enclosing, arg_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		);
		for (const ref of facts.references) {
			const [sl, sc, el, ec] = ref.range;
			insertRef.run(
				fileId,
				ref.name,
				ref.role,
				sl,
				sc,
				el,
				ec,
				ref.receiver ?? null,
				ref.enclosing ?? null,
				ref.argCount ?? null,
			);
		}
		const insertImport = this.db.prepare(
			"INSERT INTO imports (file_id, source, kind, imported_name, local_name, is_static) VALUES (?, ?, ?, ?, ?, ?)",
		);
		for (const item of facts.imports) {
			insertImport.run(
				fileId,
				item.source,
				item.kind,
				item.imported ?? null,
				item.local ?? null,
				item.isStatic ? 1 : 0,
			);
		}
		const insertScope = this.db.prepare(
			"INSERT INTO scopes (file_id, idx, parent_idx, s_line, s_col, e_line, e_col) VALUES (?, ?, ?, ?, ?, ?, ?)",
		);
		for (const scope of facts.scopes) {
			const [sl, sc, el, ec] = scope.range;
			insertScope.run(fileId, scope.idx, scope.parentIdx, sl, sc, el, ec);
		}
		const insertScopeDef = this.db.prepare(
			"INSERT INTO scope_defs (file_id, scope_idx, name, symbol_moniker) VALUES (?, ?, ?, ?)",
		);
		for (const def of facts.scopeDefs) {
			insertScopeDef.run(fileId, def.scopeIdx, def.name, def.moniker);
		}
	}

	deleteFile(path: string): void {
		const row = this.db.prepare("SELECT id FROM files WHERE path = ?").get(path) as Row | undefined;
		if (!row) return;
		const fileId = Number(row.id);
		this.clearFileRows(fileId);
		this.db.prepare("DELETE FROM files WHERE id = ?").run(fileId);
	}

	private upsertFile(
		path: string,
		lang: string,
		mtimeMs: number,
		size: number,
		hash: string,
	): { fileId: number; existed: boolean } {
		const existing = this.db.prepare("SELECT id FROM files WHERE path = ?").get(path) as Row | undefined;
		if (existing) {
			const id = Number(existing.id);
			this.db
				.prepare("UPDATE files SET lang = ?, mtime_ms = ?, size = ?, hash = ? WHERE id = ?")
				.run(lang, mtimeMs, size, hash, id);
			return { fileId: id, existed: true };
		}
		const { lastInsertRowid } = this.db
			.prepare("INSERT INTO files (path, lang, mtime_ms, size, hash) VALUES (?, ?, ?, ?, ?)")
			.run(path, lang, mtimeMs, size, hash);
		return { fileId: Number(lastInsertRowid), existed: false };
	}

	private clearFileRows(fileId: number): void {
		this.db.prepare("DELETE FROM symbols WHERE file_id = ?").run(fileId);
		this.clearMutableFileRows(fileId);
	}

	/** Clear facts whose identity is not stable across a parse, while retaining symbol row ids. */
	private clearMutableFileRows(fileId: number): void {
		this.db.prepare("DELETE FROM refs WHERE file_id = ?").run(fileId);
		this.db.prepare("DELETE FROM imports WHERE file_id = ?").run(fileId);
		this.db.prepare("DELETE FROM scopes WHERE file_id = ?").run(fileId);
		this.db.prepare("DELETE FROM scope_defs WHERE file_id = ?").run(fileId);
		this.db.prepare("DELETE FROM sym_fts WHERE file_id = ?").run(fileId);
		// Drop this file's occurrences too (all provenances): on delete this removes its rows, and on
		// re-index it clears now-stale ingested SCIP facts before the resolver rewrites the rest.
		this.db.prepare("DELETE FROM occurrences WHERE file_id = ?").run(fileId);
	}

	snapshot(referenceFileIds?: ReadonlySet<number>): ResolveSnapshot {
		return SqliteSnapshot.load(this.db, referenceFileIds);
	}

	importSnapshot(): ImportSnapshot {
		return SqliteImportSnapshot.load(this.db);
	}

	affectedFileIds(paths: readonly string[], names: ReadonlySet<string>, dependents: readonly number[]): Set<number> {
		const affected = new Set(dependents);
		if (paths.length > 0) {
			const placeholders = paths.map(() => "?").join(",");
			for (const row of this.db
				.prepare(`SELECT id FROM files WHERE path IN (${placeholders})`)
				.all(...paths) as Row[])
				affected.add(Number(row.id));
		}
		if (names.size > 0) {
			const values = [...names];
			const placeholders = values.map(() => "?").join(",");
			for (const row of this.db
				.prepare(
					`SELECT DISTINCT file_id FROM refs WHERE name IN (${placeholders}) OR receiver IN (${placeholders})`,
				)
				.all(...values, ...values) as Row[])
				affected.add(Number(row.file_id));
			for (const row of this.db
				.prepare(
					`SELECT DISTINCT file_id FROM imports
					 WHERE imported_name IN (${placeholders}) OR local_name IN (${placeholders})`,
				)
				.all(...values, ...values) as Row[])
				affected.add(Number(row.file_id));
		}
		return affected;
	}

	replaceOccurrences(occurrences: Iterable<OccurrenceRecord>): void {
		// A normal sync rewrites only the resolver's own rows. Ingested SCIP rows remain unless their
		// target declaration was removed or renamed, in which case the symbol FK cascade removes them.
		this.db.exec(`DELETE FROM occurrences WHERE provenance != '${SCIP_PROVENANCE}'`);
		this.insertOccurrences(occurrences);
		this.suppressShadowedByScip();
	}

	replaceOccurrencesForFiles(fileIds: ReadonlySet<number>, occurrences: Iterable<OccurrenceRecord>): void {
		// Delete only this rebuild's non-SCIP rows in the affected files; unaffected files' occurrences
		// (incl. inheritance edges) and all SCIP rows are untouched. `occurrences` is already scoped to
		// these files; insertOccurrences drops any row whose file/symbol id is unknown, so it is safe.
		if (fileIds.size > 0) {
			const ids = [...fileIds].join(",");
			this.db.exec(`DELETE FROM occurrences WHERE provenance != '${SCIP_PROVENANCE}' AND file_id IN (${ids})`);
		}
		this.insertOccurrences(occurrences);
		this.suppressShadowedByScip();
	}

	capturePreSync(paths: readonly string[]): PreSyncCapture {
		const dependents: number[] = [];
		const names = new Set<string>();
		const inheritance = new Map<string, string[]>();
		const resolutionFacts = new Map<string, string[]>();
		if (paths.length === 0) return { dependents, names: [], inheritance: new Map(), resolutionFacts: new Map() };
		const placeholders = paths.map(() => "?").join(",");
		for (const row of this.db
			.prepare(
				`SELECT DISTINCT o.file_id AS file_id FROM occurrences o
					JOIN symbols s ON s.id = o.symbol_id JOIN files f ON f.id = s.file_id
					WHERE f.path IN (${placeholders})`,
			)
			.all(...paths) as Row[]) {
			dependents.push(Number(row.file_id));
		}
		for (const row of this.db
			.prepare(
				`SELECT f.path AS path, s.moniker, s.name, s.kind, s.exported, s.export_name, s.owner_type,
					s.is_static, s.is_abstract, s.visibility, s.param_count, s.variadic FROM symbols s
					JOIN files f ON f.id = s.file_id WHERE f.path IN (${placeholders})`,
			)
			.all(...paths) as Row[]) {
			names.add(String(row.name));
			if (row.export_name !== null) names.add(String(row.export_name));
			pushToMap(
				resolutionFacts,
				String(row.path),
				`symbol|${String(row.moniker)}|${String(row.kind)}|${Number(row.exported)}|${String(row.export_name ?? "")}|${String(row.owner_type ?? "")}|${Number(row.is_static)}|${Number(row.is_abstract)}|${String(row.visibility ?? "")}|${String(row.param_count ?? "")}|${Number(row.variadic)}`,
			);
		}
		for (const row of this.db
			.prepare(
				`SELECT f.path AS path, i.source, i.kind, i.imported_name, i.local_name, i.is_static
				 FROM imports i JOIN files f ON f.id = i.file_id WHERE f.path IN (${placeholders})`,
			)
			.all(...paths) as Row[]) {
			pushToMap(
				resolutionFacts,
				String(row.path),
				`import|${String(row.source)}|${String(row.kind)}|${String(row.imported_name ?? "")}|${String(row.local_name ?? "")}|${Number(row.is_static)}`,
			);
		}
		for (const row of this.db
			.prepare(
				`SELECT i.imported_name AS imported_name, i.local_name AS local_name FROM imports i
					JOIN files f ON f.id = i.file_id
					WHERE f.path IN (${placeholders}) AND i.kind IN ('reexport','reexport-star')`,
			)
			.all(...paths) as Row[]) {
			if (row.imported_name !== null) names.add(String(row.imported_name));
			if (row.local_name !== null) names.add(String(row.local_name));
		}
		for (const row of this.db
			.prepare(
				`SELECT f.path AS path, r.role AS role, r.name AS name, r.enclosing AS enclosing FROM refs r
					JOIN files f ON f.id = r.file_id
					WHERE f.path IN (${placeholders}) AND r.role IN ${INHERITANCE_ROLES_SQL}`,
			)
			.all(...paths) as Row[]) {
			pushToMap(
				inheritance,
				String(row.path),
				`${String(row.role)}|${String(row.name)}|${String(row.enclosing ?? "")}`,
			);
		}
		return {
			dependents,
			names: [...names],
			inheritance: new Map([...inheritance].map(([path, edges]) => [path, edges.sort().join("\n")])),
			resolutionFacts: new Map([...resolutionFacts].map(([path, facts]) => [path, facts.sort().join("\n")])),
		};
	}

	reexportImportedNames(): Set<string> {
		const names = new Set<string>();
		for (const row of this.db
			.prepare(
				"SELECT DISTINCT imported_name AS name FROM imports WHERE kind IN ('reexport','reexport-star') AND imported_name IS NOT NULL",
			)
			.all() as Row[]) {
			names.add(String(row.name));
		}
		return names;
	}

	replaceIngestedOccurrences(occurrences: OccurrenceRecord[]): void {
		this.db.exec(`DELETE FROM occurrences WHERE provenance = '${SCIP_PROVENANCE}'`);
		this.insertOccurrences(occurrences);
		this.suppressShadowedByScip();
	}

	/**
	 * Prefer an ingested SCIP target binding at each source location it covers. Resolver-produced
	 * call/reference occurrences at that exact location are removed so queries return one target.
	 * Matching by file and range leaves uncovered locations and their recall-first candidates intact.
	 */
	private suppressShadowedByScip(): void {
		// Common case: no ingested SCIP rows exist, so nothing can be shadowed. Skip the
		// location-matching delete entirely — otherwise it scans every occurrence on each sync.
		if (
			this.db.prepare(`SELECT 1 FROM occurrences WHERE provenance = ? LIMIT 1`).get(SCIP_PROVENANCE) === undefined
		) {
			return;
		}
		// Shadow only target-binding edges. SCIP occurrences use `reference` because SCIP has no general
		// call role, and graph queries intentionally treat `call` and `reference` alike. Preserve
		// parser-derived `extends`/`implements` edges, which remain the hierarchy source.
		this.db.exec(
			`DELETE FROM occurrences WHERE provenance != '${SCIP_PROVENANCE}' AND role IN ('call', 'reference') AND EXISTS (
				SELECT 1 FROM occurrences s WHERE s.provenance = '${SCIP_PROVENANCE}'
					AND s.file_id = occurrences.file_id AND s.s_line = occurrences.s_line
					AND s.s_col = occurrences.s_col AND s.e_line = occurrences.e_line AND s.e_col = occurrences.e_col)`,
		);
	}

	private insertOccurrences(occurrences: Iterable<OccurrenceRecord>): void {
		const fileIdByPath = new Map<string, number>();
		for (const row of this.db.prepare("SELECT id, path FROM files").iterate() as Iterable<Row>) {
			fileIdByPath.set(String(row.path), Number(row.id));
		}
		// Resolve target/enclosing monikers to symbol ids once. A target whose symbol no longer
		// exists is dropped (it was previously an inert row that never joined to a symbol anyway).
		const symbolIdByMoniker = new Map<string, number>();
		for (const row of this.db.prepare("SELECT id, moniker FROM symbols").iterate() as Iterable<Row>) {
			symbolIdByMoniker.set(String(row.moniker), Number(row.id));
		}
		const insert = this.db.prepare(
			`INSERT INTO occurrences (symbol_id, file_id, s_line, s_col, e_line, e_col, role, enclosing_id, provenance, confidence)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		for (const occ of occurrences) {
			const fileId = fileIdByPath.get(occ.file);
			if (fileId === undefined) continue;
			const symbolId = symbolIdByMoniker.get(occ.symbol);
			if (symbolId === undefined) continue;
			const enclosingId = occ.enclosing ? (symbolIdByMoniker.get(occ.enclosing) ?? null) : null;
			const [sl, sc, el, ec] = occ.range;
			insert.run(symbolId, fileId, sl, sc, el, ec, occ.role, enclosingId, occ.provenance, occ.confidence);
		}
	}

	search(query: string, limit: number): SymbolHit[] {
		const tokens = (query.match(/[A-Za-z0-9_]+/g) ?? []).filter((token) => token.length >= 2).slice(0, 8);
		if (tokens.length === 0) return [];
		const match = tokens.map((token) => `"${token.toLowerCase()}"*`).join(" OR ");
		// Pull a wider candidate pool than requested so the JS re-rank (exact/subsequence) has room to
		// promote the right hit above the raw bm25 order before slicing back to `limit`.
		const pool = Math.max(limit * 4, 40);
		const rows = this.ftsSearch(match, pool);
		// A single token FTS-tokenizes to a PREFIX term, so an infix like "OpenStor" against
		// "MustOpenStorage" matches nothing. Fall back to a bounded name-subsequence scan then.
		if (rows.length < limit && tokens.length === 1) {
			const seen = new Set(rows.map((row) => String(row.moniker)));
			for (const row of this.subsequenceScan(tokens[0] as string, pool)) {
				if (!seen.has(String(row.moniker))) rows.push(row);
			}
		}
		return rankSearch(rows, query).slice(0, limit).map(symbolHit);
	}

	/** FTS match weighted name ≫ path ≫ kind (sym_fts column order is name, kind, path). */
	private ftsSearch(match: string, limit: number): Row[] {
		try {
			return this.db
				.prepare(
					`SELECT ${SEARCH_COLUMNS}, bm25(sym_fts, 10.0, 1.0, 3.0) AS score
					FROM sym_fts WHERE sym_fts MATCH ? ORDER BY score LIMIT ?`,
				)
				.all(match, limit) as Row[];
		} catch {
			return [];
		}
	}

	/**
	 * Bounded name-subsequence scan for an infix query FTS can't prefix-match. `score` is a positive
	 * sentinel so these rows sort after any real (negative) bm25 hit within the same rank tier.
	 * This O(rows) LIKE scan is gated on empty/short FTS and a single token; add a trigram index only
	 * if a big-repo bench shows it hurts.
	 */
	private subsequenceScan(token: string, limit: number): Row[] {
		// Escape LIKE metachars in the token so a literal `_`/`%` is not treated as a wildcard; the
		// interleaved `%`s are the intended subsequence gaps.
		const chars = [...token.toLowerCase()].map((c) => c.replace(/[\\%_]/g, "\\$&"));
		const like = `%${chars.join("%")}%`;
		return this.db
			.prepare(`SELECT ${SEARCH_COLUMNS}, 1.0 AS score FROM sym_fts WHERE lower(name) LIKE ? ESCAPE '\\' LIMIT ?`)
			.all(like, limit) as Row[];
	}

	definitions(name: string, limit: number): SymbolHit[] {
		const rows = this.db
			.prepare(
				`SELECT s.moniker, s.name, s.kind, f.path, s.s_line, s.s_col, s.e_line, s.e_col, s.exported, s.owner_type,
					s.is_static, s.is_abstract, s.visibility
				FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.name = ? ORDER BY s.exported DESC, f.path LIMIT ?`,
			)
			.all(name, limit) as Row[];
		return rows.map(symbolHit);
	}

	definitionByMoniker(moniker: string): SymbolHit | undefined {
		const rows = this.db
			.prepare(
				`SELECT s.moniker, s.name, s.kind, f.path, s.s_line, s.s_col, s.e_line, s.e_col, s.exported, s.owner_type,
					s.is_static, s.is_abstract, s.visibility
				FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.moniker = ? LIMIT 1`,
			)
			.all(moniker) as Row[];
		const row = rows[0];
		return row ? symbolHit(row) : undefined;
	}

	hasDefinitionInLanguage(name: string, language: string, kind?: string): boolean {
		const row = (
			kind
				? this.db.prepare(
						`SELECT 1 AS found FROM symbols s
						JOIN files f ON f.id = s.file_id
						WHERE s.name = ? AND f.lang = ? AND s.kind = ? LIMIT 1`,
					)
				: this.db.prepare(
						`SELECT 1 AS found FROM symbols s
						JOIN files f ON f.id = s.file_id
						WHERE s.name = ? AND f.lang = ? LIMIT 1`,
					)
		).get(...(kind ? [name, language, kind] : [name, language])) as Row | undefined;
		return row !== undefined;
	}

	fanoutRisk(name: string): { definitions: number; sites: number } | undefined {
		const definitions = Number(
			(this.db.prepare("SELECT COUNT(*) AS n FROM symbols WHERE name = ?").get(name) as Row).n,
		);
		if (definitions <= MAX_NAME_FANOUT) return undefined;
		const sites = Number((this.db.prepare("SELECT COUNT(*) AS n FROM refs WHERE name = ?").get(name) as Row).n);
		return sites > 0 ? { definitions, sites } : undefined;
	}

	explore(sel: { name: string } | { moniker: string }): ExplorationResult {
		// Rows kept per caller/callee/hierarchy section before the omission trailer.
		const k = 15;
		// A generous cap so the depth-1/2 counts are meaningful; the fair-share traversal still caps
		// rows, so these are "reached within cap" summary counts, not exact totals.
		const IMPACT_CAP = 200;
		const byMoniker = "moniker" in sel ? this.definitionByMoniker(sel.moniker) : undefined;
		const candidates = "moniker" in sel ? (byMoniker ? [byMoniker] : []) : this.definitions(sel.name, k);
		const resolved = candidates.length === 1 ? candidates[0] : undefined;
		if (!resolved?.moniker) {
			return {
				candidates,
				ambiguous: candidates.length > 1,
				callers: [],
				callees: [],
				implementers: [],
				supertypes: [],
				callerTotal: 0,
				calleeTotal: 0,
				impactByDepth: { 1: 0, 2: 0 },
			};
		}
		const m = resolved.moniker;
		const impact = this.impactByMoniker(m, 2, IMPACT_CAP);
		return {
			candidates,
			ambiguous: false,
			resolved,
			callers: this.callersByMoniker(m, k),
			callees: this.calleesByMoniker(m, k),
			// Hierarchy is name-scoped (no by-moniker inheritance helpers); inheritance names are near-
			// unique, so this is acceptable and disclosed rather than implied moniker-precise.
			implementers: this.implementers(resolved.name, k),
			supertypes: this.supertypes(resolved.name, k),
			callerTotal: this.countByMoniker("symbol_id", m),
			calleeTotal: this.countByMoniker("enclosing_id", m),
			impactByDepth: {
				1: impact.filter((h) => h.depth === 1).length,
				2: impact.filter((h) => h.depth === 2).length,
			},
		};
	}

	/** Incoming edges to `name` (callers, or implementers): target is `name`, result is the enclosing site. */
	private incoming(matchSql: string, value: string, rolesSql: string, limit: number): OccurrenceHit[] {
		const rows = this.db
			.prepare(
				`SELECT target.name AS name, COALESCE(caller.name, '(top level)') AS enclosing,
					f.path, occ.s_line, occ.s_col, occ.e_line, occ.e_col, occ.role, occ.provenance, occ.confidence
				FROM occurrences occ
				JOIN symbols target ON target.id = occ.symbol_id
				LEFT JOIN symbols caller ON caller.id = occ.enclosing_id
				JOIN files f ON f.id = occ.file_id
				WHERE ${matchSql} AND occ.role IN ${rolesSql}
				${OCCURRENCE_ORDER} LIMIT ?`,
			)
			.all(value, limit) as Row[];
		return rows.map(occurrenceHit);
	}

	/** Outgoing edges from the matched enclosing site (callees, or supertypes); result is the target. */
	private outgoing(matchSql: string, value: string, rolesSql: string, limit: number): OccurrenceHit[] {
		const rows = this.db
			.prepare(
				`SELECT target.name AS name, caller.name AS enclosing,
					f.path, occ.s_line, occ.s_col, occ.e_line, occ.e_col, occ.role, occ.provenance, occ.confidence
				FROM occurrences occ
				JOIN symbols caller ON caller.id = occ.enclosing_id
				JOIN symbols target ON target.id = occ.symbol_id
				JOIN files f ON f.id = occ.file_id
				WHERE ${matchSql} AND occ.role IN ${rolesSql}
				${OCCURRENCE_ORDER} LIMIT ?`,
			)
			.all(value, limit) as Row[];
		return rows.map(occurrenceHit);
	}

	/** All occurrences (any role) whose target matches `matchSql` (a name or moniker selector). */
	private targeting(matchSql: string, value: string, limit: number): OccurrenceHit[] {
		const rows = this.db
			.prepare(
				`SELECT target.name AS name, COALESCE(caller.name, '(top level)') AS enclosing,
					f.path, occ.s_line, occ.s_col, occ.e_line, occ.e_col, occ.role, occ.provenance, occ.confidence
				FROM occurrences occ
				JOIN symbols target ON target.id = occ.symbol_id
				LEFT JOIN symbols caller ON caller.id = occ.enclosing_id
				JOIN files f ON f.id = occ.file_id
				WHERE ${matchSql}
				${OCCURRENCE_ORDER} LIMIT ?`,
			)
			.all(value, limit) as Row[];
		return rows.map(occurrenceHit);
	}

	callers(name: string, limit: number): OccurrenceHit[] {
		return this.incoming("target.name = ?", name, CALL_ROLES, limit);
	}
	callersByMoniker(moniker: string, limit: number): OccurrenceHit[] {
		return this.incoming("target.moniker = ?", moniker, CALL_ROLES, limit);
	}

	callees(name: string, limit: number): OccurrenceHit[] {
		return this.outgoing("caller.name = ?", name, CALL_ROLES, limit);
	}
	calleesByMoniker(moniker: string, limit: number): OccurrenceHit[] {
		return this.outgoing("caller.moniker = ?", moniker, CALL_ROLES, limit);
	}

	implementers(name: string, limit: number): OccurrenceHit[] {
		return this.incoming("target.name = ?", name, INHERITANCE_ROLES_SQL, limit);
	}

	supertypes(name: string, limit: number): OccurrenceHit[] {
		return this.outgoing("caller.name = ?", name, INHERITANCE_ROLES_SQL, limit);
	}

	references(name: string, limit: number): OccurrenceHit[] {
		return this.targeting("target.name = ?", name, limit);
	}
	referencesByMoniker(moniker: string, limit: number): OccurrenceHit[] {
		return this.targeting("target.moniker = ?", moniker, limit);
	}

	impact(name: string, depth: number, limit: number): OccurrenceHit[] {
		const seedMonikers = (this.db.prepare("SELECT moniker FROM symbols WHERE name = ?").all(name) as Row[]).map(
			(row) => String(row.moniker),
		);
		return this.impactFromMonikers(seedMonikers, depth, limit);
	}

	impactByMoniker(moniker: string, depth: number, limit: number): OccurrenceHit[] {
		return this.impactFromMonikers([moniker], depth, limit);
	}

	/**
	 * Reverse-call closure from one or more seed symbols, breadth-first to `depth`. Each frontier
	 * branch gets a fair share of the remaining budget so one hot caller cannot starve its siblings
	 * or the deeper levels; call sites are aggregated per enclosing symbol (one row, `sites: N`).
	 */
	private impactFromMonikers(seedMonikers: string[], depth: number, limit: number): OccurrenceHit[] {
		// One row per enclosing symbol (GROUP BY enclosing_id). MAX(confidence) drives the single
		// aggregate so the bare columns come from the highest-confidence call site. All top-level
		// references (enclosing_id IS NULL) collapse into one `(top level)` row — a deliberate lossy
		// collapse; per-site top-level rows are not worth the noise here.
		const stmt = this.db.prepare(
			`SELECT target.name AS name, COALESCE(caller.name, '(top level)') AS enclosing,
				f.path, occ.s_line, occ.s_col, occ.e_line, occ.e_col, occ.role, occ.provenance,
				MAX(occ.confidence) AS confidence, caller.moniker AS caller_moniker, COUNT(*) AS sites
			FROM occurrences occ
			JOIN symbols target ON target.id = occ.symbol_id
			LEFT JOIN symbols caller ON caller.id = occ.enclosing_id
			JOIN files f ON f.id = occ.file_id
			WHERE target.moniker = ? AND occ.role IN ${CALL_ROLES} AND occ.confidence >= ?
			GROUP BY occ.enclosing_id
			ORDER BY confidence DESC, f.path, occ.s_line, occ.s_col LIMIT ?`,
		);
		const visitedMonikers = new Set(seedMonikers);
		const visitedEnclosing = new Set<string>();
		const results: OccurrenceHit[] = [];
		let frontier = seedMonikers;
		for (let level = 1; level <= depth && frontier.length > 0 && results.length < limit; level++) {
			const remaining = limit - results.length;
			// Divide the remaining budget evenly across frontier branches. Math.ceil plus the
			// final limit slice still fills the budget.
			const share = Math.max(1, Math.ceil(remaining / frontier.length));
			const levelHits: OccurrenceHit[] = [];
			const next: string[] = [];
			for (const moniker of frontier) {
				const rows = stmt.all(moniker, MIN_IMPACT_CONFIDENCE, share) as Row[];
				for (const row of rows) {
					const enclosingKey = row.caller_moniker === null ? TOP_LEVEL : String(row.caller_moniker);
					if (visitedEnclosing.has(enclosingKey)) continue;
					visitedEnclosing.add(enclosingKey);
					levelHits.push({ ...occurrenceHit(row), depth: level, sites: Number(row.sites) });
					if (enclosingKey !== TOP_LEVEL && !visitedMonikers.has(enclosingKey)) {
						visitedMonikers.add(enclosingKey);
						next.push(enclosingKey);
					}
				}
			}
			levelHits.sort(
				(a, b) =>
					b.confidence - a.confidence ||
					a.file.localeCompare(b.file) ||
					a.range[0] - b.range[0] ||
					a.range[1] - b.range[1],
			);
			for (const hit of levelHits) {
				if (results.length >= limit) break;
				results.push(hit);
			}
			frontier = next;
		}
		return results;
	}

	files(pattern: string | undefined, limit: number): string[] {
		const rows = pattern
			? (this.db
					.prepare("SELECT path FROM files WHERE path LIKE ? ORDER BY path LIMIT ?")
					.all(`%${pattern.replaceAll("*", "%")}%`, limit) as Row[])
			: (this.db.prepare("SELECT path FROM files ORDER BY path LIMIT ?").all(limit) as Row[]);
		return rows.map((row) => String(row.path));
	}

	hasSymbols(): boolean {
		const row = this.db.prepare("SELECT EXISTS(SELECT 1 FROM symbols) AS present").get() as Row;
		return Number(row.present) === 1;
	}

	status(): IndexStatus {
		const count = (table: string): number => {
			const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as Row;
			return Number(row.n ?? 0);
		};
		return {
			root: this.root,
			files: count("files"),
			symbols: count("symbols"),
			occurrences: count("occurrences"),
			truncated: this.getMeta("file_cap_reached") === "1",
			lastSyncAt: this.getMeta("last_sync_at"),
		};
	}

	isReady(): boolean {
		const row = this.db.prepare("SELECT COUNT(*) AS n FROM symbols").get() as Row;
		return Number(row.n ?? 0) > 0;
	}

	diagnoseEmpty(name: string): EmptyReason {
		const defs = Number((this.db.prepare("SELECT COUNT(*) AS n FROM symbols WHERE name = ?").get(name) as Row).n);
		if (defs === 0) return { kind: "no-symbol" };
		const bound = Number(
			(
				this.db
					.prepare("SELECT COUNT(*) AS n FROM occurrences o JOIN symbols s ON s.id = o.symbol_id WHERE s.name = ?")
					.get(name) as Row
			).n,
		);
		const sites = Number((this.db.prepare("SELECT COUNT(*) AS n FROM refs WHERE name = ?").get(name) as Row).n);
		// Above-cap names with raw sites and no stored edges carry a fan-out risk. Some sites may
		// instead be local bindings, so the public diagnostic deliberately says "may be suppressed".
		if (defs > MAX_NAME_FANOUT && bound === 0 && sites > 0) return { kind: "suppressed", definitions: defs, sites };
		return { kind: "no-edges", definitions: defs };
	}

	/** Count caller (symbol_id) or callee (enclosing_id) occurrences for one symbol moniker. */
	private countByMoniker(column: "symbol_id" | "enclosing_id", moniker: string): number {
		const row = this.db
			.prepare(
				`SELECT COUNT(*) AS n FROM occurrences
				WHERE ${column} = (SELECT id FROM symbols WHERE moniker = ?) AND role IN ${CALL_ROLES}`,
			)
			.get(moniker) as Row;
		return Number(row.n ?? 0);
	}
}

/** Open a cache database, rebuilding it only for SQLite's explicit corrupt/not-a-database errors. */
export function openCacheStore(root: string, dbPath: string): SqliteStore {
	try {
		return new SqliteStore(root, dbPath);
	} catch (error) {
		if (!isCorruptDatabase(error)) throw error;
		for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) rmSync(path, { force: true });
		return new SqliteStore(root, dbPath);
	}
}

function isCorruptDatabase(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const sqlite = error as { errcode?: unknown; errstr?: unknown };
	return (
		sqlite.errcode === 11 ||
		sqlite.errcode === 26 ||
		sqlite.errstr === "database disk image is malformed" ||
		sqlite.errstr === "file is not a database"
	);
}

interface SnapScope {
	parentIdx: number | null;
	range: Range;
}

const SNAPSHOT_SYMBOL_COLUMNS = `moniker, file_id, name, kind, exported, export_name, owner_type,
	s_line, s_col, e_line, e_col, name_s_line, name_s_col, name_e_line, name_e_col,
	is_static, is_abstract, visibility, param_count, variadic`;

function snapshotSymbol(row: Row): SnapshotSymbol {
	return {
		moniker: String(row.moniker),
		fileId: Number(row.file_id),
		name: String(row.name),
		kind: String(row.kind),
		exported: Number(row.exported) === 1,
		...(row.export_name === null ? {} : { exportedAs: String(row.export_name) }),
		...(row.owner_type === null ? {} : { ownerType: String(row.owner_type) }),
		range: [Number(row.s_line), Number(row.s_col), Number(row.e_line), Number(row.e_col)],
		nameRange: [Number(row.name_s_line), Number(row.name_s_col), Number(row.name_e_line), Number(row.name_e_col)],
		...(Number(row.is_static) === 1 ? { isStatic: true } : {}),
		...(Number(row.is_abstract) === 1 ? { isAbstract: true } : {}),
		...(row.visibility ? { visibility: String(row.visibility) as SnapshotSymbol["visibility"] } : {}),
		...(row.param_count === null ? {} : { paramCount: Number(row.param_count) }),
		...(Number(row.variadic) === 1 ? { variadic: true } : {}),
	};
}

function parsedImport(row: Row): ParsedImport {
	return {
		source: String(row.source),
		kind: String(row.kind) as ParsedImport["kind"],
		imported: row.imported_name === null ? undefined : String(row.imported_name),
		local: row.local_name === null ? undefined : String(row.local_name),
		...(Number(row.is_static) === 1 ? { isStatic: true } : {}),
	};
}

class SqliteSnapshot implements ResolveSnapshot {
	readonly references: SnapshotReference[];
	private readonly byName: Map<string, SnapshotSymbol[]>;
	private readonly exportedByFile: Map<number, SnapshotSymbol[]>;
	private readonly importsByFileId: Map<number, ParsedImport[]>;
	private readonly pathByFile: Map<number, string>;
	private readonly fileByPath: Map<string, number>;
	private readonly scopesByFile: Map<number, SnapScope[]>;
	private readonly defsByFileScope: Map<string, Array<{ moniker: string | null }>>;
	private readonly symbolsByFile: Map<number, SnapshotSymbol[]>;
	private readonly symbolsByFileAndName: Map<string, SnapshotSymbol[]>;
	private readonly byMoniker: Map<string, SnapshotSymbol>;
	private readonly layout: ProjectLayout;
	private readonly db: DatabaseSync;
	private readonly lazyCatalog: boolean;
	private _dirIndex?: { byDir: Map<string, number[]> };
	private _basenameIndex?: Map<string, number[]>;

	private constructor(
		references: SnapshotReference[],
		byName: Map<string, SnapshotSymbol[]>,
		exportedByFile: Map<number, SnapshotSymbol[]>,
		importsByFileId: Map<number, ParsedImport[]>,
		pathByFile: Map<number, string>,
		fileByPath: Map<string, number>,
		scopesByFile: Map<number, SnapScope[]>,
		defsByFileScope: Map<string, Array<{ moniker: string | null }>>,
		symbolsByFile: Map<number, SnapshotSymbol[]>,
		layout: ProjectLayout,
		db: DatabaseSync,
		lazyCatalog: boolean,
	) {
		this.references = references;
		this.byName = byName;
		this.exportedByFile = exportedByFile;
		this.importsByFileId = importsByFileId;
		this.pathByFile = pathByFile;
		this.fileByPath = fileByPath;
		this.scopesByFile = scopesByFile;
		this.defsByFileScope = defsByFileScope;
		this.symbolsByFile = symbolsByFile;
		this.symbolsByFileAndName = new Map();
		for (const [fileId, symbols] of symbolsByFile)
			for (const symbol of symbols) pushToMap(this.symbolsByFileAndName, `${fileId}:${symbol.name}`, symbol);
		this.byMoniker = new Map();
		for (const symbols of symbolsByFile.values())
			for (const symbol of symbols) this.byMoniker.set(symbol.moniker, symbol);
		this.layout = layout;
		this.db = db;
		this.lazyCatalog = lazyCatalog;
	}

	projectLayout(): ProjectLayout {
		return this.layout;
	}

	static load(db: DatabaseSync, referenceFileIds?: ReadonlySet<number>): SqliteSnapshot {
		const strings = new Map<string, string>();
		const intern = (value: unknown): string => {
			const text = String(value);
			const existing = strings.get(text);
			if (existing !== undefined) return existing;
			strings.set(text, text);
			return text;
		};
		const pathByFile = new Map<number, string>();
		const fileByPath = new Map<string, number>();
		for (const row of db.prepare("SELECT id, path FROM files").iterate() as Iterable<Row>) {
			const path = intern(row.path);
			pathByFile.set(Number(row.id), path);
			fileByPath.set(path, Number(row.id));
		}
		const byName = new Map<string, SnapshotSymbol[]>();
		const exportedByFile = new Map<number, SnapshotSymbol[]>();
		const symbolsByFile = new Map<number, SnapshotSymbol[]>();
		if (referenceFileIds === undefined) {
			for (const row of db
				.prepare(`SELECT ${SNAPSHOT_SYMBOL_COLUMNS} FROM symbols ORDER BY id`)
				.iterate() as Iterable<Row>) {
				const symbol = snapshotSymbol(row);
				pushToMap(byName, symbol.name, symbol);
				pushToMap(symbolsByFile, symbol.fileId, symbol);
				if (symbol.exported) pushToMap(exportedByFile, symbol.fileId, symbol);
			}
		}
		const importsByFileId = new Map<number, ParsedImport[]>();
		if (referenceFileIds === undefined) {
			for (const row of db
				.prepare("SELECT file_id, source, kind, imported_name, local_name, is_static FROM imports")
				.iterate() as Iterable<Row>) {
				pushToMap(importsByFileId, Number(row.file_id), parsedImport(row));
			}
		}
		const referenceFilter = referenceFileIds === undefined ? "" : scopedReferenceFilter(referenceFileIds);
		const references: SnapshotReference[] = [];
		for (const row of db
			.prepare(
				`SELECT r.id, r.file_id, r.name, r.role, r.receiver, r.enclosing, r.arg_count, r.s_line, r.s_col, r.e_line, r.e_col
				FROM refs r ${referenceFilter} ORDER BY r.id`,
			)
			.iterate() as Iterable<Row>) {
			const fileId = Number(row.file_id);
			references.push({
				id: Number(row.id),
				fileId,
				path: pathByFile.get(fileId) ?? "",
				name: intern(row.name),
				role: intern(row.role) as SnapshotReference["role"],
				receiver: row.receiver === null ? undefined : intern(row.receiver),
				enclosing: row.enclosing === null ? undefined : intern(row.enclosing),
				...(row.arg_count === null ? {} : { argCount: Number(row.arg_count) }),
				range: [Number(row.s_line), Number(row.s_col), Number(row.e_line), Number(row.e_col)],
			});
		}
		const loadedReferenceFileIds = new Set(references.map((ref) => ref.fileId));
		const scopeFilter = referenceFileIds === undefined ? "" : idFilter(loadedReferenceFileIds);
		const scopesByFile = new Map<number, SnapScope[]>();
		for (const row of db
			.prepare(`SELECT file_id, idx, parent_idx, s_line, s_col, e_line, e_col FROM scopes ${scopeFilter}`)
			.iterate() as Iterable<Row>) {
			const fileId = Number(row.file_id);
			let list = scopesByFile.get(fileId);
			if (!list) {
				list = [];
				scopesByFile.set(fileId, list);
			}
			list[Number(row.idx)] = {
				parentIdx: row.parent_idx === null ? null : Number(row.parent_idx),
				range: [Number(row.s_line), Number(row.s_col), Number(row.e_line), Number(row.e_col)],
			};
		}
		const defsByFileScope = new Map<string, Array<{ moniker: string | null }>>();
		for (const row of db
			.prepare(`SELECT file_id, scope_idx, name, symbol_moniker FROM scope_defs ${scopeFilter}`)
			.iterate() as Iterable<Row>) {
			const key = `${Number(row.file_id)}:${Number(row.scope_idx)}:${String(row.name)}`;
			pushToMap(defsByFileScope, key, { moniker: row.symbol_moniker === null ? null : String(row.symbol_moniker) });
		}
		const layoutRow = db.prepare("SELECT value FROM meta WHERE key = 'project_layout'").get() as Row | undefined;
		const layout = parseLayout(layoutRow?.value);
		assignReferenceScopes(references, scopesByFile);
		return new SqliteSnapshot(
			references,
			byName,
			exportedByFile,
			importsByFileId,
			pathByFile,
			fileByPath,
			scopesByFile,
			defsByFileScope,
			symbolsByFile,
			layout,
			db,
			referenceFileIds !== undefined,
		);
	}

	scopeBinding(fileId: number, name: string, line: number, col: number, scopeIdx?: number): ScopeBinding {
		const scopes = this.scopesByFile.get(fileId);
		if (!scopes || scopes.length === 0) return { bound: false };
		let idx: number | null = scopeIdx ?? innermostScopeIdx(scopes, line, col);
		while (idx !== null) {
			const defs = this.defsByFileScope.get(`${fileId}:${idx}:${name}`);
			if (defs && defs.length > 0) {
				const symbol = defs.find((def) => def.moniker !== null);
				return symbol ? { bound: true, moniker: symbol.moniker as string } : { bound: true };
			}
			idx = scopes[idx]?.parentIdx ?? null;
		}
		return { bound: false };
	}

	symbolsByName(name: string): readonly SnapshotSymbol[] {
		if (this.lazyCatalog && !this.byName.has(name)) {
			this.byName.set(name, this.loadSymbols("name = ?", name));
		}
		return this.byName.get(name) ?? [];
	}

	symbolByMoniker(moniker: string): SnapshotSymbol | undefined {
		if (this.lazyCatalog && !this.byMoniker.has(moniker)) {
			const symbol = this.loadSymbols("moniker = ?", moniker)[0];
			if (symbol) this.byMoniker.set(moniker, symbol);
		}
		return this.byMoniker.get(moniker);
	}

	fileIdByPath(path: string): number | undefined {
		return this.fileByPath.get(path);
	}

	symbolsInFileNamed(fileId: number, name: string): readonly SnapshotSymbol[] {
		const key = `${fileId}:${name}`;
		if (this.lazyCatalog && !this.symbolsByFileAndName.has(key))
			this.symbolsByFileAndName.set(key, this.loadSymbols("file_id = ? AND name = ?", fileId, name));
		return this.symbolsByFileAndName.get(key) ?? [];
	}

	dirOf(fileId: number): string {
		return dirOfPath(this.pathByFile.get(fileId) ?? "");
	}

	fileIdsInDir(dir: string): readonly number[] {
		return this.dirIndex().byDir.get(dir) ?? [];
	}

	hasDir(dir: string): boolean {
		return this.dirIndex().byDir.has(dir);
	}

	filesEndingWith(suffix: string): readonly number[] {
		const base = suffix.split("/").at(-1) ?? suffix;
		const out: number[] = [];
		for (const fileId of this.basenameIndex().get(base) ?? []) {
			const path = this.pathByFile.get(fileId);
			if (path && (path === suffix || path.endsWith(`/${suffix}`))) out.push(fileId);
		}
		return out;
	}

	private dirIndex(): { byDir: Map<string, number[]> } {
		if (!this._dirIndex) {
			const byDir = new Map<string, number[]>();
			for (const [fileId, path] of this.pathByFile) pushToMap(byDir, dirOfPath(path), fileId);
			this._dirIndex = { byDir };
		}
		return this._dirIndex;
	}

	private basenameIndex(): Map<string, number[]> {
		if (!this._basenameIndex) {
			const index = new Map<string, number[]>();
			for (const [fileId, path] of this.pathByFile) pushToMap(index, path.split("/").at(-1) ?? path, fileId);
			this._basenameIndex = index;
		}
		return this._basenameIndex;
	}

	symbolAt(path: string, line: number, col: number): string | undefined {
		const fileId = this.fileByPath.get(path);
		if (fileId === undefined) return undefined;
		this.ensureSymbolsByFile(fileId);
		let best: SnapshotSymbol | undefined;
		let bestSpan = Number.POSITIVE_INFINITY;
		for (const symbol of this.symbolsByFile.get(fileId) ?? []) {
			const [sl, sc, el, ec] = symbol.range;
			if (line < sl || line > el) continue;
			if (line === sl && col < sc) continue;
			if (line === el && col > ec) continue;
			const span = (el - sl) * 100_000 + (ec - sc);
			if (span < bestSpan) {
				bestSpan = span;
				best = symbol;
			}
		}
		return best?.moniker;
	}

	symbolAtName(path: string, line: number, col: number): string | undefined {
		const fileId = this.fileByPath.get(path);
		if (fileId === undefined) return undefined;
		this.ensureSymbolsByFile(fileId);
		for (const symbol of this.symbolsByFile.get(fileId) ?? []) {
			if (symbol.nameRange[0] === line && symbol.nameRange[1] === col) return symbol.moniker;
		}
		return undefined;
	}

	exportedSymbols(fileId: number): readonly SnapshotSymbol[] {
		if (this.lazyCatalog && !this.exportedByFile.has(fileId))
			this.exportedByFile.set(fileId, this.loadSymbols("file_id = ? AND exported = 1", fileId));
		return this.exportedByFile.get(fileId) ?? [];
	}

	importsInFile(fileId: number): readonly ParsedImport[] {
		if (this.lazyCatalog && !this.importsByFileId.has(fileId)) {
			const imports: ParsedImport[] = [];
			for (const row of this.db
				.prepare("SELECT source, kind, imported_name, local_name, is_static FROM imports WHERE file_id = ?")
				.iterate(fileId) as Iterable<Row>)
				imports.push(parsedImport(row));
			this.importsByFileId.set(fileId, imports);
		}
		return this.importsByFileId.get(fileId) ?? [];
	}

	pathByFileId(fileId: number): string | undefined {
		return this.pathByFile.get(fileId);
	}

	private loadSymbols(where: string, ...params: (string | number)[]): SnapshotSymbol[] {
		const symbols: SnapshotSymbol[] = [];
		for (const row of this.db
			.prepare(`SELECT ${SNAPSHOT_SYMBOL_COLUMNS} FROM symbols WHERE ${where} ORDER BY id`)
			.iterate(...params) as Iterable<Row>)
			symbols.push(snapshotSymbol(row));
		return symbols;
	}

	private ensureSymbolsByFile(fileId: number): void {
		if (this.lazyCatalog && !this.symbolsByFile.has(fileId))
			this.symbolsByFile.set(fileId, this.loadSymbols("file_id = ?", fileId));
	}
}

/** Parse the persisted project layout; degrade to an empty layout on missing/corrupt JSON. */
function parseLayout(value: unknown): ProjectLayout {
	if (value === undefined || value === null) return EMPTY_LAYOUT;
	try {
		return JSON.parse(String(value)) as ProjectLayout;
	} catch {
		return EMPTY_LAYOUT;
	}
}

/** Import-cycle view: files, imports, and project layout only—never the symbol/reference catalog. */
class SqliteImportSnapshot implements ImportSnapshot {
	private readonly fileByPath: Map<string, number>;
	private readonly importsByFileId: Map<number, ParsedImport[]>;
	private readonly layout: ProjectLayout;

	private constructor(
		fileByPath: Map<string, number>,
		importsByFileId: Map<number, ParsedImport[]>,
		layout: ProjectLayout,
	) {
		this.fileByPath = fileByPath;
		this.importsByFileId = importsByFileId;
		this.layout = layout;
	}

	static load(db: DatabaseSync): SqliteImportSnapshot {
		const fileByPath = new Map<string, number>();
		for (const row of db.prepare("SELECT id, path FROM files").iterate() as Iterable<Row>)
			fileByPath.set(String(row.path), Number(row.id));

		const importsByFileId = new Map<number, ParsedImport[]>();
		for (const row of db
			.prepare("SELECT file_id, source, kind, imported_name, local_name, is_static FROM imports")
			.iterate() as Iterable<Row>)
			pushToMap(importsByFileId, Number(row.file_id), parsedImport(row));

		const layoutRow = db.prepare("SELECT value FROM meta WHERE key = 'project_layout'").get() as Row | undefined;
		return new SqliteImportSnapshot(fileByPath, importsByFileId, parseLayout(layoutRow?.value));
	}

	importsInFile(fileId: number): readonly ParsedImport[] {
		return this.importsByFileId.get(fileId) ?? [];
	}

	fileIdByPath(path: string): number | undefined {
		return this.fileByPath.get(path);
	}

	projectLayout(): ProjectLayout {
		return this.layout;
	}
}

function scopedReferenceFilter(fileIds: ReadonlySet<number>): string {
	const ids = [...fileIds].filter(Number.isSafeInteger);
	const affected = ids.length === 0 ? "0" : `r.file_id IN (${ids.join(",")})`;
	return `WHERE (${affected}) OR r.role IN ${INHERITANCE_ROLES_SQL}`;
}

function idFilter(fileIds: ReadonlySet<number>): string {
	const ids = [...fileIds].filter(Number.isSafeInteger);
	return ids.length === 0 ? "WHERE 0" : `WHERE file_id IN (${ids.join(",")})`;
}

/** Repo-relative POSIX directory of a path; "" for files at the repo root. */
function dirOfPath(path: string): string {
	const slash = path.lastIndexOf("/");
	return slash === -1 ? "" : path.slice(0, slash);
}

function pushToMap<K, V>(map: Map<K, V[]>, key: K, value: V): void {
	const existing = map.get(key);
	if (existing) existing.push(value);
	else map.set(key, [value]);
}

/** Index of the tightest scope containing (line,col); falls back to the file root (0). */
function innermostScopeIdx(scopes: SnapScope[], line: number, col: number): number {
	let best = 0;
	let bestSpan = Number.POSITIVE_INFINITY;
	for (let i = 0; i < scopes.length; i++) {
		const scope = scopes[i];
		if (!scope) continue;
		const [sl, sc, el, ec] = scope.range;
		if (line < sl || line > el) continue;
		if (line === sl && col < sc) continue;
		if (line === el && col > ec) continue;
		const span = (el - sl) * 10_000 + (ec - sc);
		if (span < bestSpan) {
			bestSpan = span;
			best = i;
		}
	}
	return best;
}

/**
 * Assign each reference its innermost scope with one position-ordered sweep per file. Parser scopes
 * are AST scopes and therefore nested; the active stack makes this O((scopes + refs) log n) for the
 * initial sorts and O(1) during provider resolution. Synthetic snapshots without `scopeIdx` retain
 * the defensive scan in `scopeBinding`.
 */
function assignReferenceScopes(references: SnapshotReference[], scopesByFile: Map<number, SnapScope[]>): void {
	const refsByFile = new Map<number, SnapshotReference[]>();
	for (const ref of references) pushToMap(refsByFile, ref.fileId, ref);
	for (const [fileId, refs] of refsByFile) {
		const scopes = scopesByFile.get(fileId);
		if (!scopes || scopes.length === 0) continue;
		const orderedScopes = scopes
			.map((scope, idx) => ({ scope, idx }))
			.filter((entry) => entry.scope !== undefined)
			.sort(
				(a, b) =>
					comparePosition(a.scope.range, b.scope.range) || compareEndDescending(a.scope.range, b.scope.range),
			);
		const orderedRefs = [...refs].sort((a, b) => comparePosition(a.range, b.range));
		const active: Array<{ scope: SnapScope; idx: number }> = [];
		let next = 0;
		for (const ref of orderedRefs) {
			while (next < orderedScopes.length && startsAtOrBefore(orderedScopes[next]!.scope.range, ref.range)) {
				active.push(orderedScopes[next]!);
				next++;
			}
			while (active.length > 0 && !containsPosition(active[active.length - 1]!.scope.range, ref.range)) active.pop();
			ref.scopeIdx = active[active.length - 1]?.idx ?? 0;
		}
	}
}

function comparePosition(a: Range, b: Range): number {
	return a[0] - b[0] || a[1] - b[1];
}

function compareEndDescending(a: Range, b: Range): number {
	return b[2] - a[2] || b[3] - a[3];
}

function startsAtOrBefore(scope: Range, position: Range): boolean {
	return scope[0] < position[0] || (scope[0] === position[0] && scope[1] <= position[1]);
}

function containsPosition(scope: Range, position: Range): boolean {
	return position[0] < scope[2] || (position[0] === scope[2] && position[1] <= scope[3]);
}

function fileMeta(row: Row): FileMeta {
	return {
		id: Number(row.id),
		path: String(row.path),
		lang: String(row.lang),
		mtimeMs: Number(row.mtime_ms),
		size: Number(row.size),
		...(row.hash === null || row.hash === undefined ? {} : { hash: String(row.hash) }),
	};
}

/** Re-rank search candidates: exact name first, then subsequence name matches, then bm25 order. */
function rankSearch(rows: Row[], query: string): Row[] {
	const q = query.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
	const tier = (row: Row): number => {
		const name = String(row.name).toLowerCase();
		if (name === q) return 0;
		return isSubsequence(q, name) ? 1 : 2;
	};
	return rows
		.map((row, i) => ({ row, i, tier: tier(row), score: Number(row.score) }))
		.sort((a, b) => a.tier - b.tier || a.score - b.score || a.i - b.i)
		.map((entry) => entry.row);
}

/** Whether `needle`'s chars appear in order within `haystack` (covers camelCase-hump matches). */
function isSubsequence(needle: string, haystack: string): boolean {
	if (needle.length === 0) return false;
	let i = 0;
	for (const ch of haystack) {
		if (ch === needle[i]) i++;
		if (i === needle.length) return true;
	}
	return false;
}

function symbolHit(row: Row): SymbolHit {
	return {
		name: String(row.name),
		kind: String(row.kind),
		file: String(row.path),
		range: [Number(row.s_line), Number(row.s_col), Number(row.e_line), Number(row.e_col)],
		...(row.moniker ? { moniker: String(row.moniker) } : {}),
		exported: Number(row.exported) === 1,
		...(row.owner_type === null || row.owner_type === undefined ? {} : { ownerType: String(row.owner_type) }),
		...(Number(row.is_static) === 1 ? { isStatic: true } : {}),
		...(Number(row.is_abstract) === 1 ? { isAbstract: true } : {}),
		...(row.visibility ? { visibility: String(row.visibility) as SymbolHit["visibility"] } : {}),
	};
}

function occurrenceHit(row: Row): OccurrenceHit {
	return {
		name: String(row.name),
		enclosing: String(row.enclosing),
		file: String(row.path),
		range: [Number(row.s_line), Number(row.s_col), Number(row.e_line), Number(row.e_col)],
		role: String(row.role) as OccurrenceHit["role"],
		provenance: String(row.provenance),
		confidence: Number(row.confidence),
	};
}
