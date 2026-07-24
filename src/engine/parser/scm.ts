/**
 * Helpers for working with borrowed tree-sitter `tags.scm` queries.
 *
 * `splitPatterns` breaks a query into its top-level S-expression patterns so a single
 * unsupported pattern (grammar version drift, an unknown predicate) can be skipped
 * without losing the rest of the language — the resilience the built-in index gets
 * from compiling tiny patterns individually.
 */

/**
 * Split a `.scm` query string into top-level patterns by tracking paren depth while
 * ignoring comments and string/regex literals. Each returned chunk is one compilable
 * pattern (its predicates included).
 */
export function splitPatterns(query: string): string[] {
	const patterns: string[] = [];
	let depth = 0;
	let start = -1;
	let inString = false;
	let inComment = false;
	for (let i = 0; i < query.length; i++) {
		const ch = query[i];
		if (inComment) {
			if (ch === "\n") inComment = false;
			continue;
		}
		if (inString) {
			if (ch === "\\") {
				i++;
			} else if (ch === '"') {
				inString = false;
			}
			continue;
		}
		if (ch === ";") {
			inComment = true;
			continue;
		}
		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === "(" || ch === "[") {
			if (depth === 0) start = i;
			depth++;
		} else if (ch === ")" || ch === "]") {
			depth--;
			if (depth === 0 && start >= 0) {
				patterns.push(query.slice(start, i + 1));
				start = -1;
			}
		}
	}
	return patterns;
}

/** Role + kind decoded from a tags.scm capture name like "definition.function" or "reference.call". */
interface TagCapture {
	bucket: "definition" | "reference";
	kind: string;
}

export function parseTagCapture(captureName: string): TagCapture | undefined {
	if (captureName === "definition" || captureName.startsWith("definition.")) {
		return { bucket: "definition", kind: captureName.slice("definition.".length) || "symbol" };
	}
	if (captureName === "reference" || captureName.startsWith("reference.")) {
		return { bucket: "reference", kind: captureName.slice("reference.".length) || "ref" };
	}
	return undefined;
}
