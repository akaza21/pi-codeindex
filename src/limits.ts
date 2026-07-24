/**
 * Public resource limits shared by the pi adapter, standalone CLI, and indexing engine.
 *
 * Defaults optimize normal interactive use. Ceilings prevent accidental model/tool input or a
 * mistyped CLI/environment value from turning a bounded local query into an unbounded traversal.
 */
export const DEFAULT_INDEX_FILE_LIMIT = 20_000;
/** Typed resolution rebuilds a TypeScript program for every index snapshot. */
export const DEFAULT_TYPED_INDEX_FILE_LIMIT = 500;
export const MAX_INDEX_FILE_LIMIT = 100_000;

export const MAX_QUERY_RESULTS = 500;
export const MAX_IMPACT_DEPTH = 10;

export const DEFAULT_EXPLORE_BUDGET = 6_000;
export const MAX_EXPLORE_BUDGET = 50_000;

/** Heavy repository syncs allowed at once within one pi workspace. */
export const MAX_CONCURRENT_REPO_SYNCS = 2;
export const MAX_CONCURRENT_TYPED_REPO_SYNCS = 1;

/** Validate a programmatic index cap at the engine boundary. */
export function validateIndexFileLimit(value: number): number {
	if (!Number.isInteger(value) || value < 1 || value > MAX_INDEX_FILE_LIMIT) {
		throw new RangeError(
			`maxFiles must be a positive integer no greater than ${MAX_INDEX_FILE_LIMIT.toLocaleString("en-US")}`,
		);
	}
	return value;
}

/** Apply the lower safe default for typed mode while honoring an explicit validated override. */
export function effectiveIndexFileLimit(typed: boolean, configured?: number): number {
	if (configured !== undefined) return validateIndexFileLimit(configured);
	return typed ? DEFAULT_TYPED_INDEX_FILE_LIMIT : DEFAULT_INDEX_FILE_LIMIT;
}
