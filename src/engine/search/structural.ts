/**
 * Structural search: find code by AST *shape* (a raw tree-sitter query), as opposed to text
 * search (characters) or symbol resolution (named entities). It reuses the parser's grammar +
 * query engine; it is NOT served from the symbol store, which holds resolved symbols, not shapes.
 *
 * Read-only and exact: results are not ranked and carry no confidence/provenance (that vocabulary
 * belongs to resolution, where ambiguity is real). One call targets one language. Scope is bounded
 * — a search wider than `maxFiles` is refused rather than walking an unbounded set on the hot path.
 *
 * Candidate files come from the index (language-tagged), but each is matched against its CURRENT
 * on-disk contents, not the last-indexed snapshot — so an exact search never reports stale hits.
 *
 * The raw tree-sitter query language cannot express "a node WITHOUT a child of type X"; such
 * absence patterns are handled by the caller post-filtering on the returned `captures`.
 */

import { join } from "node:path";
import type { FileSystem, Parser, Range, Store, StructuralCapture } from "../ports.ts";

export interface StructuralSearchDeps {
	store: Store;
	fs: FileSystem;
	parser: Parser;
	/** Absolute repo root; repo-relative file paths resolve against it to read content. */
	root: string;
}

export interface StructuralSearchInput {
	lang: string;
	/** A raw tree-sitter query; must capture at least one node. */
	pattern: string;
	/** Substring filter on the repo-relative path. */
	path?: string;
	/** Max hits returned (default 100). */
	limit?: number;
	/** Refuse the search if more than this many candidate files are in scope (default 2000). */
	maxFiles?: number;
	/** Optional caller cancellation. */
	signal?: AbortSignal;
}

export interface StructuralHit {
	file: string;
	range: Range;
	captures: StructuralCapture[];
}

const DEFAULT_LIMIT = 100;
const DEFAULT_MAX_FILES = 2000;

export async function structuralSearch(
	deps: StructuralSearchDeps,
	input: StructuralSearchInput,
): Promise<StructuralHit[]> {
	input.signal?.throwIfAborted();
	const limit = input.limit ?? DEFAULT_LIMIT;
	const maxFiles = input.maxFiles ?? DEFAULT_MAX_FILES;
	const candidates = deps.store
		.allFiles()
		.filter((file) => file.lang === input.lang && (input.path === undefined || file.path.includes(input.path)))
		.map((file) => file.path)
		.sort();
	if (candidates.length > maxFiles) {
		throw new Error(
			`structural search scope too broad: ${candidates.length} ${input.lang} files exceed the ${maxFiles}-file cap; narrow with a path filter.`,
		);
	}

	// Compile (and validate) the query before scanning, so a malformed or captureless query fails
	// loudly even when the scope happens to be empty.
	const query = await deps.parser.structuralQuery(input.lang, input.pattern);
	try {
		const hits: StructuralHit[] = [];
		for (const file of candidates) {
			input.signal?.throwIfAborted();
			const source = deps.fs.readFile(join(deps.root, file));
			if (source === undefined) continue;
			for (const match of query.match(source)) {
				input.signal?.throwIfAborted();
				// Checked before pushing so `limit` is an exact cap (and `limit <= 0` yields none).
				if (hits.length >= limit) return hits;
				hits.push({ file, range: match.range, captures: match.captures });
			}
		}
		return hits;
	} finally {
		query.free();
	}
}
