/**
 * Adds tool-selection guidance when the workspace has an index. An eligible broad grep
 * for an exact indexed symbol is blocked once with matching symbol locations; an exact
 * retry proceeds. Literal, regex, path, and filename searches are never redirected.
 */

import { resolve } from "node:path";
import type { ExtensionAPI, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import type { ResolveWorkspace } from "./tools.ts";

/** System-prompt note: the navigation tools exist and when to prefer them over text search. */
const NAVIGATION_GUIDANCE = [
	"This workspace has a live code index (pi-codeindex). To navigate code, prefer the codeindex_* tools over text search:",
	"- codeindex_search / codeindex_def: find a symbol by name / jump to its definition",
	"- codeindex_explore: inspect a symbol's definition, source, callers, callees, inheritance, and reverse-call reach",
	"- codeindex_refs / codeindex_callers / codeindex_callees: usages and call relationships",
	"- codeindex_implementers / codeindex_supertypes: inheritance edges",
	"- codeindex_impact: direct and transitive callers of a symbol",
	"- codeindex_match: find code by AST shape (a tree-sitter query) when text search is too blunt",
	"Results carry a confidence and how they were resolved; prefer higher-confidence, precisely-resolved hits. Use",
	"grep/find for literal text, comments, or filenames the index does not track (or if a lookup returns nothing).",
].join("\n");

export function registerSteering(pi: ExtensionAPI, resolveWorkspace: ResolveWorkspace): void {
	pi.on("before_agent_start", (event, ctx) => {
		if (!resolveWorkspace(ctx.cwd).hasIndexedSymbols()) return undefined;
		return { systemPrompt: `${event.systemPrompt}\n\n${NAVIGATION_GUIDANCE}` };
	});

	// Remembers calls already nudged so a deliberate retry runs. Bounded so a long session can't grow
	// it without limit — evicting the oldest at worst causes one redundant nudge.
	const nudged = new Set<string>();
	const NUDGE_MEMORY = 512;
	pi.on("tool_call", (event, ctx): ToolCallEventResult | undefined => {
		if (event.toolName !== "grep" && event.toolName !== "find") return undefined;
		const query = routableQuery(event.toolName, event.input);
		if (!query) return undefined;
		const key = `${resolve(ctx.cwd)}:${event.toolName}:${JSON.stringify(Object.entries(event.input).sort(([a], [b]) => a.localeCompare(b)))}`;
		if (nudged.has(key)) return undefined; // deliberate retry: let it run.

		const tokens = new Set(query.toLowerCase().split(/\s+/).filter(Boolean));
		const hits: string[] = [];
		try {
			const ws = resolveWorkspace(ctx.cwd);
			for (const repo of ws.repos()) {
				const store = ws.managerFor(repo.path).readyStore();
				if (!store) continue;
				for (const hit of store.search(query, 6)) {
					if (!tokens.has(hit.name.toLowerCase())) continue;
					hits.push(`- ${hit.kind} ${hit.name} ${hit.file}:${hit.range[0]}`);
				}
				if (hits.length >= 12) break;
			}
		} catch {
			return undefined;
		}
		if (hits.length === 0) return undefined;

		if (nudged.size >= NUDGE_MEMORY) nudged.delete(nudged.values().next().value as string);
		nudged.add(key);
		return {
			block: true,
			reason:
				`The code index already has matches for "${query}":\n${hits.join("\n")}\n\n` +
				"Read the most relevant file directly, or use a codeindex_* tool (search/def/callers/impact) for " +
				"precise results. If you still need the raw text search, re-run this exact call and it will execute.",
		};
	});
}

/** Extract a routable symbol-ish query from a broad exploration call; undefined = pass through. */
export function routableQuery(toolName: string, input: Record<string, unknown>): string | undefined {
	const str = (key: string): string | undefined => {
		const value = input[key];
		return typeof value === "string" && value.trim() ? value.trim() : undefined;
	};
	if (toolName === "grep") {
		if (input.literal === true || str("path") || str("glob")) return undefined;
		const pattern = str("pattern");
		if (!pattern) return undefined;
		// Literal multi-word, path-like, or filename-like searches pass through; symbol-shaped route.
		if (/[\s/]/.test(pattern) || /\.[A-Za-z0-9]+$/.test(pattern)) return undefined;
		const cleaned = pattern.replaceAll(/[^A-Za-z0-9_]/g, " ").trim();
		if (cleaned.length < 4) return undefined;
		// Regex-heavy patterns are deliberate; pass through.
		if ((pattern.match(/[.*+?()[\]{}|\\^$]/g)?.length ?? 0) > 2) return undefined;
		return cleaned;
	}
	return undefined; // `find` is filename-glob search, never symbol routing.
}
