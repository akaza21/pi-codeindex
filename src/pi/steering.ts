/** Adds concise, advisory tool-selection guidance when the workspace has an index. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ResolveWorkspace } from "./tools.ts";

/** System-prompt note: the navigation tools exist and when to prefer them over text search. */
const NAVIGATION_GUIDANCE = [
	"This workspace has a live code index (pi-codeindex). Use codeindex_* for indexed symbol navigation:",
	"- codeindex_search / codeindex_def: find a symbol by name / jump to its definition",
	"- codeindex_explore: inspect a symbol's definition, source, callers, callees, inheritance, and reverse-call reach",
	"- codeindex_refs / codeindex_callers / codeindex_callees: usages and call relationships",
	"- codeindex_implementers / codeindex_supertypes: explicit inheritance edges",
	"- codeindex_impact: direct and transitive callers of a symbol",
	"- codeindex_match: find code by AST shape (a tree-sitter query) when text search is too blunt",
	"Resolution scores are heuristic evidence, not probabilities. Unique/module-scoped symbols are the strongest case.",
	"High-fan-out names can be suppressed, and Go structural interface satisfaction is not computed.",
	"Use grep/find immediately for literal text, comments, filenames, or when a result reports suppression or unsupported semantics.",
	"An empty or low-score index result is not proof that no source relationship exists.",
].join("\n");

export function registerSteering(pi: ExtensionAPI, resolveWorkspace: ResolveWorkspace): void {
	pi.on("before_agent_start", (event, ctx) => {
		if (!resolveWorkspace(ctx.cwd).hasIndexedSymbols()) return undefined;
		return { systemPrompt: `${event.systemPrompt}\n\n${NAVIGATION_GUIDANCE}` };
	});
}
