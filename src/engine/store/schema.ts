/**
 * SCIP-shaped SQLite schema. `symbols` carry stable monikers; resolved
 * `occurrences` reference symbols by integer id (`symbol_id`/`enclosing_id` → `symbols.id`),
 * not by repeating the long moniker string on every row — this keeps the occurrences table and
 * its indexes small (millions of rows on a large repo) and makes the agent-facing joins
 * integer-keyed. `refs`/`imports` hold the raw per-file facts
 * the resolver consumes to (re)build occurrences. `scopes`/`scope_defs` hold the
 * per-file scope graph. `sym_fts` backs symbol search.
 *
 * Bump INDEX_FORMAT_VERSION on any incompatible schema change; the store drops and
 * rebuilds rather than migrating in place.
 */

export const INDEX_FORMAT_VERSION = "13";

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS files (
	id INTEGER PRIMARY KEY,
	path TEXT NOT NULL UNIQUE,
	lang TEXT NOT NULL,
	mtime_ms REAL NOT NULL,
	size INTEGER NOT NULL,
	hash TEXT
);

CREATE TABLE IF NOT EXISTS symbols (
	id INTEGER PRIMARY KEY,
	moniker TEXT NOT NULL UNIQUE,
	file_id INTEGER NOT NULL,
	name TEXT NOT NULL,
	kind TEXT NOT NULL,
	s_line INTEGER NOT NULL, s_col INTEGER NOT NULL, e_line INTEGER NOT NULL, e_col INTEGER NOT NULL,
	-- Range of the declared name token alone (the s_*/e_* range above covers the whole declaration).
	name_s_line INTEGER NOT NULL, name_s_col INTEGER NOT NULL, name_e_line INTEGER NOT NULL, name_e_col INTEGER NOT NULL,
	exported INTEGER NOT NULL DEFAULT 0,
	export_name TEXT,
	owner_type TEXT,
	-- Member metadata. is_static/is_abstract carry the domain {true, unknown}: a 1 means the
	-- modifier was seen, a 0 means "unknown" (the extractors never assert an explicit false).
	-- Readers must not treat 0 as authoritative "instance/concrete"; the row mappers expose it
	-- as true|undefined. visibility is nullable (null = unknown).
	is_static INTEGER NOT NULL DEFAULT 0,
	is_abstract INTEGER NOT NULL DEFAULT 0,
	visibility TEXT,
	-- Arity: param_count is NULL when the symbol is not a callable / has no parameter list.
	param_count INTEGER,
	variadic INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS refs (
	id INTEGER PRIMARY KEY,
	file_id INTEGER NOT NULL,
	name TEXT NOT NULL,
	role TEXT NOT NULL,
	s_line INTEGER NOT NULL, s_col INTEGER NOT NULL, e_line INTEGER NOT NULL, e_col INTEGER NOT NULL,
	receiver TEXT,
	enclosing TEXT,
	-- Argument count at a call site; NULL when the reference is not a call.
	arg_count INTEGER
);

CREATE TABLE IF NOT EXISTS imports (
	id INTEGER PRIMARY KEY,
	file_id INTEGER NOT NULL,
	source TEXT NOT NULL,
	kind TEXT NOT NULL,
	imported_name TEXT,
	local_name TEXT,
	is_static INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS occurrences (
	id INTEGER PRIMARY KEY,
	-- Target symbol and enclosing-site symbol as integer FKs into symbols(id). enclosing_id is
	-- NULL for a top-level reference. Storing ids (not moniker strings) is what keeps this table
	-- and its indexes small at millions of rows. ON DELETE CASCADE (with PRAGMA foreign_keys=ON) is
	-- the integrity guard: when a symbol is deleted its occurrences go too, so a freed rowid reused
	-- by a later symbol can never silently rebind a stale occurrence to it.
	symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
	file_id INTEGER NOT NULL,
	s_line INTEGER NOT NULL, s_col INTEGER NOT NULL, e_line INTEGER NOT NULL, e_col INTEGER NOT NULL,
	role TEXT NOT NULL,
	enclosing_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
	provenance TEXT NOT NULL,
	confidence REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS scopes (
	id INTEGER PRIMARY KEY,
	file_id INTEGER NOT NULL,
	idx INTEGER NOT NULL,
	parent_idx INTEGER,
	s_line INTEGER NOT NULL, s_col INTEGER NOT NULL, e_line INTEGER NOT NULL, e_col INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS scope_defs (
	id INTEGER PRIMARY KEY,
	file_id INTEGER NOT NULL,
	scope_idx INTEGER NOT NULL,
	name TEXT NOT NULL,
	symbol_moniker TEXT
);

CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_refs_file ON refs(file_id);
CREATE INDEX IF NOT EXISTS idx_refs_name ON refs(name);
CREATE INDEX IF NOT EXISTS idx_refs_receiver ON refs(receiver) WHERE receiver IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_imports_file ON imports(file_id);
CREATE INDEX IF NOT EXISTS idx_imports_imported ON imports(imported_name) WHERE imported_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_imports_local ON imports(local_name) WHERE local_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_occ_symbol ON occurrences(symbol_id);
CREATE INDEX IF NOT EXISTS idx_occ_enclosing ON occurrences(enclosing_id);
-- Supports the location-keyed EXISTS in suppressShadowedByScip (drop heuristic rows a SCIP
-- occurrence covers). PARTIAL on scip rows only: that EXISTS filters provenance='scip', and the
-- common case (no SCIP ingested) then carries an empty index instead of one row per occurrence.
CREATE INDEX IF NOT EXISTS idx_occ_loc ON occurrences(file_id, s_line, s_col, e_line, e_col)
	WHERE provenance = 'scip';
CREATE INDEX IF NOT EXISTS idx_scopes_file ON scopes(file_id);
CREATE INDEX IF NOT EXISTS idx_scope_defs_file ON scope_defs(file_id, name);

CREATE VIRTUAL TABLE IF NOT EXISTS sym_fts USING fts5(
	name, kind, path, s_line UNINDEXED, s_col UNINDEXED, e_line UNINDEXED, e_col UNINDEXED,
	exported UNINDEXED, owner_type UNINDEXED, file_id UNINDEXED
);
`;

export const DROP_SQL = `
DROP TABLE IF EXISTS occurrences;
DROP TABLE IF EXISTS scope_defs;
DROP TABLE IF EXISTS scopes;
DROP TABLE IF EXISTS imports;
DROP TABLE IF EXISTS refs;
DROP TABLE IF EXISTS symbols;
DROP TABLE IF EXISTS sym_fts;
DROP TABLE IF EXISTS files;
`;
