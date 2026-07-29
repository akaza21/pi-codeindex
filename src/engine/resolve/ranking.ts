/**
 * Candidate weighting from free signals. A reference may bind to several
 * candidates within a bounded fan-out; each receives a heuristic ranking score.
 *
 *   - precise bindings (same-file, import) keep high confidence per candidate
 *   - ambiguous name-only matches share confidence equally (1/N) so a 10-way match is
 *     visibly low-confidence rather than falsely certain
 */

import type { ResolvedTarget } from "../ports.ts";

/** Resolutions that bind to a specific declaration (not a bare same-name guess). */
export const PRECISE_RESOLUTIONS: ReadonlySet<string> = new Set([
	"same-file",
	"import",
	"package",
	"scoped",
	"typed",
	"scip",
	"lsp",
]);

interface WeightedTarget extends ResolvedTarget {
	confidence: number;
}

/**
 * Cap on name-only fan-out. A reference that binds to nothing precise but matches more than this
 * many same-named declarations is intractably ambiguous: there is no signal to choose among them,
 * each would carry confidence ~1/N, and a 1/N guess is not actionable. Beyond the cap we drop them
 * entirely rather than emit a long confident-looking tail. Precise bindings
 * and tractable ambiguity (≤ cap) are unaffected.
 */
export const MAX_NAME_FANOUT = 8;

export function weighTargets(targets: ResolvedTarget[]): WeightedTarget[] {
	if (targets.length === 0) return [];
	const precise = targets.filter((candidate) => PRECISE_RESOLUTIONS.has(candidate.resolution));
	if (precise.length > 0) {
		// Drop noisy name-only fallbacks once a precise binding exists. A SINGLE precise
		// binding keeps full confidence; multiple precise candidates (e.g. a wildcard import
		// or duplicate source layout) split confidence by fan-out — several "precise" targets
		// must never each read as fully certain.
		const n = precise.length;
		return precise.map((candidate) => ({
			...candidate,
			confidence: n === 1 ? candidate.confidence : candidate.confidence / n,
		}));
	}
	// Ambiguous name-only matches: split the candidate's own (already-low) confidence by
	// fan-out. A lone name guess stays at its base (e.g. 0.5), never 1.0 — it is still a
	// guess, not a resolved binding. Beyond MAX_NAME_FANOUT the match is intractably ambiguous
	// (pure noise) — drop it.
	if (targets.length > MAX_NAME_FANOUT) return [];
	return targets.map((candidate) => ({ ...candidate, confidence: candidate.confidence / targets.length }));
}
