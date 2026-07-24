/**
 * Tool registrations. Ships `codeindex_*` tools. Reads are non-blocking: they serve
 * whatever is indexed now and warm in the background,
 * appending a notice while a sync is still populating the index.
 *
 * Workspace mode: queries fan out across the discovered repos; multi-repo output is
 * prefixed with `[repo]` and a `repo=<name>` filter narrows to one. A single enclosing
 * repo behaves exactly like before (no prefixes).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, type TSchema, Type } from "typebox";
import { readRepoFile } from "../engine/adapters/repo-path.ts";
import type {
	EmptyReason,
	ExplorationResult,
	ImportCycle,
	OccurrenceHit,
	Store,
	StructuralHit,
	SymbolHit,
} from "../engine/index.ts";
import { importCycles, languageIds, NodeFileSystem, structuralSearch, TreeSitterParser } from "../engine/index.ts";
import { DEFAULT_EXPLORE_BUDGET, MAX_EXPLORE_BUDGET, MAX_IMPACT_DEPTH, MAX_QUERY_RESULTS } from "../limits.ts";
import type { IndexManager } from "./manager.ts";
import type { WorkspaceManager, WorkspaceRepo } from "./workspace.ts";

export type ResolveWorkspace = (cwd: string) => WorkspaceManager;

const nonEmpty = (description: string) => Type.String({ minLength: 1, description });
const boundedInt = (description: string, maximum: number) => Type.Integer({ minimum: 1, maximum, description });
const REPO_FILTER = Type.Optional(nonEmpty("Restrict to a repo name/path (workspace mode)"));
const targetName = nonEmpty("Exact symbol name (or pass `moniker` to target one declaration)");
const targetMoniker = nonEmpty(
	"Moniker from a prior def/search result, to target exactly that declaration within a repo",
);

const symbolParams = Type.Object({
	query: nonEmpty("Symbol name or search text"),
	limit: Type.Optional(boundedInt("Maximum results (default 15)", MAX_QUERY_RESULTS)),
	repo: REPO_FILTER,
});
const nameParams = Type.Object({
	name: nonEmpty("Exact symbol name"),
	limit: Type.Optional(boundedInt("Maximum results (default 20)", MAX_QUERY_RESULTS)),
	repo: REPO_FILTER,
});
const impactParams = Type.Union([
	Type.Object({
		name: targetName,
		depth: Type.Optional(boundedInt("Reverse-call traversal depth (default 2)", MAX_IMPACT_DEPTH)),
		limit: Type.Optional(boundedInt("Maximum results (default 30)", MAX_QUERY_RESULTS)),
		repo: REPO_FILTER,
	}),
	Type.Object({
		moniker: targetMoniker,
		depth: Type.Optional(boundedInt("Reverse-call traversal depth (default 2)", MAX_IMPACT_DEPTH)),
		limit: Type.Optional(boundedInt("Maximum results (default 30)", MAX_QUERY_RESULTS)),
		repo: REPO_FILTER,
	}),
]);
/** Target one symbol by name OR by a `moniker` copied from a prior result (disambiguation). */
const targetParams = Type.Union([
	Type.Object({
		name: targetName,
		limit: Type.Optional(boundedInt("Maximum results (default 20)", MAX_QUERY_RESULTS)),
		repo: REPO_FILTER,
	}),
	Type.Object({
		moniker: targetMoniker,
		limit: Type.Optional(boundedInt("Maximum results (default 20)", MAX_QUERY_RESULTS)),
		repo: REPO_FILTER,
	}),
]);
const filesParams = Type.Object({
	pattern: Type.Optional(nonEmpty("Substring/glob-ish filter on path")),
	limit: Type.Optional(boundedInt("Maximum results (default 100)", MAX_QUERY_RESULTS)),
	repo: REPO_FILTER,
});
const exploreParams = Type.Union([
	Type.Object({
		name: targetName,
		budget: Type.Optional(boundedInt("Approx max output size in characters (default 6000)", MAX_EXPLORE_BUDGET)),
		repo: REPO_FILTER,
	}),
	Type.Object({
		moniker: targetMoniker,
		budget: Type.Optional(boundedInt("Approx max output size in characters (default 6000)", MAX_EXPLORE_BUDGET)),
		repo: REPO_FILTER,
	}),
]);
const matchParams = Type.Object({
	pattern: nonEmpty(
		'A tree-sitter query (S-expression) capturing at least one node, e.g. (function_declaration name: (identifier) @name), or (catch_clause body: (statement_block . "}")) @empty. The query language cannot express "a node WITHOUT a child of type X".',
	),
	lang: Type.Union(languageIds.map((id) => Type.Literal(id)) as unknown as [TSchema, ...TSchema[]], {
		description: `Language: ${languageIds.join(" | ")}`,
	}),
	path: Type.Optional(nonEmpty("Restrict to files whose path contains this substring")),
	limit: Type.Optional(boundedInt("Maximum results (default 100)", MAX_QUERY_RESULTS)),
	repo: REPO_FILTER,
});

type ExploreParams = Static<typeof exploreParams>;
type SymbolParams = Static<typeof symbolParams>;
type NameParams = Static<typeof nameParams>;
type ImpactParams = Static<typeof impactParams>;
type TargetParams = Static<typeof targetParams>;
type FilesParams = Static<typeof filesParams>;
type MatchParams = Omit<Static<typeof matchParams>, "lang"> & { lang: string };

interface RepoFilter {
	repo?: string;
}

function symbolLine(hit: SymbolHit): string {
	const mods = [hit.visibility, hit.isStatic ? "static" : undefined, hit.isAbstract ? "abstract" : undefined]
		.filter(Boolean)
		.join(" ");
	const prefix = mods ? `${mods} ` : "";
	const owner = hit.ownerType ? `${hit.ownerType}.` : "";
	const id = hit.moniker ? `  [id: ${hit.moniker}]` : "";
	return `${prefix}${hit.kind} ${owner}${hit.name}  ${hit.file}:${hit.range[0]}${hit.exported ? "  (exported)" : ""}${id}`;
}

/** Impact-only proximity label: depth 1 = a direct caller, deeper = reached transitively. */
function impactLabel(depth: number | undefined): string {
	if (depth === undefined) return "";
	return depth === 1 ? "direct " : `transitive (depth ${depth}) `;
}

function occurrenceLine(hit: OccurrenceHit, render: (h: OccurrenceHit) => string): string {
	const sites = hit.sites && hit.sites > 1 ? `  (sites: ${hit.sites})` : "";
	return `${impactLabel(hit.depth)}${render(hit)}  ${hit.file}:${hit.range[0]}  [${hit.provenance}, ${hit.confidence.toFixed(2)}]${sites}`;
}

function emptyMessage(reason: EmptyReason, name: string): string {
	switch (reason.kind) {
		case "no-symbol":
			return `no symbol named "${name}" (not indexed — run codeindex_sync if it is new)`;
		case "no-edges":
			return `"${name}" is indexed (${reason.definitions} definition(s)) but has no matching edges`;
		case "suppressed":
			return `0 bound; ~${reason.sites} site(s) suppressed (${reason.definitions}-way ambiguous name "${name}") — pass moniker to target one declaration`;
	}
}

/** Replace an empty by-name result with an explanation (not-found / unused / fan-out-suppressed). */
function diagnoseIfEmpty(store: Store, sel: { name: string } | { moniker: string }, lines: string[]): string[] {
	if (lines.length > 0 || "moniker" in sel) return lines;
	return [emptyMessage(store.diagnoseEmpty(sel.name), sel.name)];
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();
const clip = (text: string, max = 80): string => (text.length > max ? `${text.slice(0, max)}\u2026` : text);

function matchLine(hit: StructuralHit): string {
	const captures = hit.captures.map((c) => `${c.name}=${clip(oneLine(c.text))}`).join("  ");
	return `${hit.file}:${hit.range[0]}  ${captures}`;
}

const BODY_LINES = 12;

/**
 * Budget-ordered exploration rendering: definition + body head (source, which the store can't slice),
 * then callers, callees, hierarchy, and an impact summary. Each list appends only while the char
 * budget holds and always discloses how many rows it omitted. The budget is a char count, not
 * a token estimate; use a tokenizer only if char/token skew matters.
 */
function renderExploration(
	d: ExplorationResult,
	budget: number,
	sel: { name: string } | { moniker: string },
	readSource: (rel: string) => string | undefined,
): string[] {
	if (d.candidates.length === 0) {
		return ["name" in sel ? `no symbol named "${sel.name}"` : `no declaration matches moniker "${sel.moniker}"`];
	}
	const out: string[] = [];
	let used = 0;
	const add = (s: string): boolean => {
		if (used + s.length + 1 > budget) return false;
		out.push(s);
		used += s.length + 1;
		return true;
	};
	const force = (s: string): void => {
		out.push(s);
		used += s.length + 1;
	};

	if (!d.resolved) {
		force(`${d.candidates.length} candidates — pass a moniker to target one:`);
		for (const c of d.candidates) if (!add(symbolLine(c))) break;
		return out;
	}

	const r = d.resolved;
	force(symbolLine(r));
	// Body head: the declaration's first lines (ranges are 1-based); the store holds no source text.
	const source = readSource(r.file);
	if (source !== undefined) {
		const all = source.split("\n");
		const start = r.range[0] - 1;
		const last = Math.min(r.range[2] - 1, start + BODY_LINES - 1);
		for (const line of all.slice(start, last + 1)) if (!add(line)) break;
		if (last < r.range[2] - 1) add(`… (+${r.range[2] - 1 - last} more body lines)`);
	}

	const followup = (tool: string): string =>
		"name" in sel ? `${tool} name=${sel.name}` : `${tool} moniker=${sel.moniker}`;
	const section = (
		title: string,
		hits: OccurrenceHit[],
		total: number,
		render: (h: OccurrenceHit) => string,
		follow?: string,
	): void => {
		if (hits.length === 0) return;
		if (!add(`${title} (${total}):`)) return;
		let shown = 0;
		for (const h of hits) {
			if (!add(`  ${occurrenceLine(h, render)}`)) break;
			shown++;
		}
		if (total > shown) force(`  +${total - shown} more ${title}${follow ? ` — ${follow} for all` : ""}`);
	};

	section("callers", d.callers, d.callerTotal, (h) => `${h.enclosing} → ${h.name}`, followup("codeindex_callers"));
	section("callees", d.callees, d.calleeTotal, (h) => `${h.enclosing} → ${h.name}`, followup("codeindex_callees"));
	section("implementers", d.implementers, d.implementers.length, (h) => `${h.enclosing} ${h.role} ${h.name}`);
	section("supertypes", d.supertypes, d.supertypes.length, (h) => `${h.enclosing} ${h.role} ${h.name}`);
	add(`impact: direct ${d.impactByDepth[1]}, transitive(≤2) ${d.impactByDepth[2]}`);
	return out;
}

function formatCycles(cycles: ImportCycle[]): string[] {
	if (cycles.length === 0) return ["(no import cycles)"];
	return cycles.map((cycle) => `cycle group (${cycle.files.length} files): ${cycle.files.join(", ")}`);
}

/** Resolve a by-target query selector, requiring exactly one of `name` / `moniker`. */
function targetSelector(p: { name?: string; moniker?: string }): { moniker: string } | { name: string } | undefined {
	if (p.moniker && !p.name) return { moniker: p.moniker };
	if (p.name && !p.moniker) return { name: p.name };
	return undefined;
}

const targetError = "provide exactly one of `name` or `moniker`";

function toResult(lines: string[], details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text: lines.length > 0 ? lines.join("\n") : "(no results)" }], details };
}

interface RepoScanEntry {
	manager: IndexManager;
	repo: WorkspaceRepo;
	/** `[repo] ` in multi-repo mode, empty for a single repo. */
	tag: string;
	/** A warming/indexing notice when the index is not ready yet. */
	notice?: string;
}

/**
 * The matching repos to query, each warmed if needed, with its tag + readiness notice, plus a
 * trailer for repos dropped by the fan-out cap. Shared by every fan-out tool (sync and async).
 */
function repoScan(ws: WorkspaceManager, filter: string | undefined): { entries: RepoScanEntry[]; trailer?: string } {
	const multi = ws.multi(filter);
	const entries: RepoScanEntry[] = [];
	for (const repo of ws.repos(filter)) {
		const manager = ws.managerFor(repo.path);
		const ready = manager.isReady();
		if (!ready) ws.warmRepo(repo.path);
		let notice: string | undefined;
		if (!ready || manager.isSyncing()) {
			notice = manager.isSyncing()
				? "(indexing in progress — results may be partial; re-run shortly)"
				: "(index warming up in the background; re-run shortly)";
		}
		entries.push({ manager, repo, tag: multi ? `[${repo.name}] ` : "", notice });
	}
	const dropped = ws.droppedRepos(filter);
	const trailer =
		dropped > 0 ? `(+${dropped} more workspace repos not searched; pass repo=<name> to target one)` : undefined;
	return { entries, trailer };
}

/** Warn when the index hasn't synced in a while; age-only (no walk on the read path). */
const STALE_AFTER_MS = 15 * 60 * 1000;
function stalenessHint(store: Store): string | undefined {
	const lastSyncAt = store.status().lastSyncAt;
	if (!lastSyncAt) return undefined;
	const ageMs = Date.now() - Date.parse(lastSyncAt);
	if (!(ageMs > STALE_AFTER_MS)) return undefined;
	const min = Math.round(ageMs / 60000);
	const age = min < 60 ? `${min}m` : min < 1440 ? `${Math.round(min / 60)}h` : `${Math.round(min / 1440)}d`;
	return `index synced ${age} ago — codeindex_sync if results look stale`;
}

/** Run `perRepo` against every matching repo's store, non-blocking, with repo tags + notices. */
function fanOut(
	ws: WorkspaceManager,
	filter: string | undefined,
	perRepo: (store: Store) => string[],
	signal?: AbortSignal,
): string[] {
	signal?.throwIfAborted();
	const { entries, trailer } = repoScan(ws, filter);
	if (entries.length === 0)
		return [filter ? `No repository matches repo="${filter}".` : "No repositories found for this workspace."];
	const lines: string[] = [];
	for (const { manager, tag, notice } of entries) {
		signal?.throwIfAborted();
		const store = manager.getStore();
		if (notice) lines.push(`${tag}${notice}`);
		for (const line of perRepo(store)) lines.push(`${tag}${line}`);
		// A warming/indexing notice already implies freshness is in flux — don't also warn stale.
		if (!notice) {
			const stale = stalenessHint(store);
			if (stale) lines.push(`${tag}${stale}`);
		}
	}
	if (trailer) lines.push(trailer);
	return lines;
}

export function registerTools(pi: ExtensionAPI, resolveWorkspace: ResolveWorkspace): void {
	const parser = new TreeSitterParser();
	const read = <P extends RepoFilter>(
		name: string,
		label: string,
		description: string,
		guideline: string,
		parameters: TSchema,
		query: (store: Store, params: P) => string[],
	): void => {
		pi.registerTool({
			name,
			label,
			description,
			promptSnippet: description,
			promptGuidelines: [guideline],
			parameters,
			async execute(_id, params: P, signal, _onUpdate, ctx) {
				return toResult(fanOut(resolveWorkspace(ctx.cwd), params.repo, (store) => query(store, params), signal));
			},
		});
	};

	read<SymbolParams>(
		"codeindex_search",
		"Code index: search",
		"Search indexed symbols (functions, classes, methods, types) by name/text.",
		"Use codeindex_search to locate a symbol by name; use grep/find for literal text and filenames.",
		symbolParams,
		(store, p) => store.search(p.query, p.limit ?? 15).map(symbolLine),
	);
	read<NameParams>(
		"codeindex_def",
		"Code index: definitions",
		"List definition sites for an exact symbol name (with file:line and export status).",
		"Use codeindex_def to locate exact declaration sites.",
		nameParams,
		(store, p) => diagnoseIfEmpty(store, { name: p.name }, store.definitions(p.name, p.limit ?? 20).map(symbolLine)),
	);
	read<TargetParams>(
		"codeindex_callers",
		"Code index: callers",
		"List call/reference sites that target a symbol (who calls it), with confidence. Pass `moniker` (from a def/search result) to target one specific declaration.",
		"Use codeindex_callers to inspect incoming calls; pass moniker to disambiguate same-named declarations.",
		targetParams,
		(store, p) => {
			const t = targetSelector(p);
			if (!t) return [targetError];
			const hits =
				"moniker" in t ? store.callersByMoniker(t.moniker, p.limit ?? 20) : store.callers(t.name, p.limit ?? 20);
			return diagnoseIfEmpty(
				store,
				t,
				hits.map((h) => occurrenceLine(h, (x) => `${x.enclosing} → ${x.name}`)),
			);
		},
	);
	read<TargetParams>(
		"codeindex_callees",
		"Code index: callees",
		"List the calls a symbol makes (what it calls), with confidence. Pass `moniker` to target one specific declaration.",
		"Use codeindex_callees to see what a function depends on; pass moniker to disambiguate.",
		targetParams,
		(store, p) => {
			const t = targetSelector(p);
			if (!t) return [targetError];
			const hits =
				"moniker" in t ? store.calleesByMoniker(t.moniker, p.limit ?? 20) : store.callees(t.name, p.limit ?? 20);
			return diagnoseIfEmpty(
				store,
				t,
				hits.map((h) => occurrenceLine(h, (x) => `${x.enclosing} → ${x.name}`)),
			);
		},
	);
	read<TargetParams>(
		"codeindex_refs",
		"Code index: references",
		"List all occurrences (calls and references) that bind to a symbol. Pass `moniker` to target one specific declaration.",
		"Use codeindex_refs for a complete usage list of a symbol; pass moniker to disambiguate.",
		targetParams,
		(store, p) => {
			const t = targetSelector(p);
			if (!t) return [targetError];
			const hits =
				"moniker" in t
					? store.referencesByMoniker(t.moniker, p.limit ?? 20)
					: store.references(t.name, p.limit ?? 20);
			return diagnoseIfEmpty(
				store,
				t,
				hits.map((h) => occurrenceLine(h, (x) => `${x.name} (in ${x.enclosing})`)),
			);
		},
	);
	read<NameParams>(
		"codeindex_implementers",
		"Code index: implementers",
		"List types that extend or implement a class/interface (incoming inheritance edges).",
		"Use codeindex_implementers to find subclasses and implementers of a type.",
		nameParams,
		(store, p) =>
			store
				.implementers(p.name, p.limit ?? 20)
				.map((h) => occurrenceLine(h, (x) => `${x.enclosing} ${x.role} ${x.name}`)),
	);
	read<NameParams>(
		"codeindex_supertypes",
		"Code index: supertypes",
		"List the classes/interfaces a type extends or implements (outgoing inheritance edges).",
		"Use codeindex_supertypes to see what a type inherits from.",
		nameParams,
		(store, p) =>
			store
				.supertypes(p.name, p.limit ?? 20)
				.map((h) => occurrenceLine(h, (x) => `${x.enclosing} ${x.role} ${x.name}`)),
	);
	read<ImpactParams>(
		"codeindex_impact",
		"Code index: impact",
		"Reverse-call closure (who calls this, transitively) — the callers that reach a symbol, not a prediction of what a specific edit breaks. Each row is labelled direct/transitive by hop depth.",
		"Use codeindex_impact to inspect direct and transitive callers of a symbol.",
		impactParams,
		(store, p) => {
			const t = targetSelector(p);
			if (!t) return [targetError];
			const hits =
				"moniker" in t
					? store.impactByMoniker(t.moniker, p.depth ?? 2, p.limit ?? 30)
					: store.impact(t.name, p.depth ?? 2, p.limit ?? 30);
			return diagnoseIfEmpty(
				store,
				t,
				hits.map((h) => occurrenceLine(h, (x) => `${x.enclosing} → ${x.name}`)),
			);
		},
	);
	read<FilesParams>(
		"codeindex_files",
		"Code index: files",
		"List indexed files, optionally filtered by a path substring.",
		"Use codeindex_files to see which files are indexed.",
		filesParams,
		(store, p) => store.files(p.pattern, p.limit ?? 100),
	);

	pi.registerTool({
		name: "codeindex_explore",
		label: "Code index: explore",
		description:
			"Show a symbol's definition, source head, callers, callees, inheritance edges, and reverse-call reach. Pass repo with a moniker in multi-repo workspaces.",
		promptSnippet: "Inspect a symbol's definition, source, callers, callees, inheritance, and reverse-call reach.",
		promptGuidelines: [
			"Use codeindex_explore for a combined symbol overview; pass moniker to select one same-named declaration, and raise budget for more source detail.",
		],
		parameters: exploreParams,
		async execute(_id, params: ExploreParams, signal, _onUpdate, ctx) {
			signal?.throwIfAborted();
			const sel = targetSelector(params);
			if (!sel) return toResult([targetError]);
			const ws = resolveWorkspace(ctx.cwd);
			const { entries, trailer } = repoScan(ws, params.repo);
			if (entries.length === 0)
				return toResult([
					params.repo
						? `No repository matches repo="${params.repo}".`
						: "No repositories found for this workspace.",
				]);
			const lines: string[] = [];
			for (const { manager, repo, tag, notice } of entries) {
				signal?.throwIfAborted();
				if (notice) lines.push(`${tag}${notice}`);
				const result = manager.getStore().explore(sel);
				for (const line of renderExploration(result, params.budget ?? DEFAULT_EXPLORE_BUDGET, sel, (rel) =>
					readRepoFile(repo.path, rel),
				)) {
					lines.push(`${tag}${line}`);
				}
			}
			if (trailer) lines.push(trailer);
			return toResult(lines);
		},
	});

	pi.registerTool({
		name: "codeindex_match",
		label: "Code index: structural match",
		description:
			"Find code by AST shape using a tree-sitter query, such as empty catch blocks or a specific call form.",
		promptSnippet: "Find code by AST shape via a tree-sitter query (structural search).",
		promptGuidelines: [
			"Use codeindex_match when text search is insufficient; provide a valid tree-sitter query for the target language with at least one capture.",
		],
		parameters: matchParams,
		async execute(_id, params: MatchParams, signal, _onUpdate, ctx) {
			signal?.throwIfAborted();
			const ws = resolveWorkspace(ctx.cwd);
			const { entries, trailer } = repoScan(ws, params.repo);
			if (entries.length === 0)
				return toResult([
					params.repo
						? `No repository matches repo="${params.repo}".`
						: "No repositories found for this workspace.",
				]);
			const lines: string[] = [];
			for (const { manager, repo, tag, notice } of entries) {
				signal?.throwIfAborted();
				if (notice) lines.push(`${tag}${notice}`);
				try {
					const fs = new NodeFileSystem(repo.path);
					const hits = await structuralSearch(
						{ store: manager.getStore(), fs, parser, root: repo.path },
						{
							lang: params.lang,
							pattern: params.pattern,
							...(params.path ? { path: params.path } : {}),
							...(params.limit === undefined ? {} : { limit: params.limit }),
							signal,
						},
					);
					for (const hit of hits) lines.push(`${tag}${matchLine(hit)}`);
				} catch (error) {
					lines.push(`${tag}${(error as Error).message}`);
				}
			}
			if (trailer) lines.push(trailer);
			return toResult(lines);
		},
	});

	pi.registerTool({
		name: "codeindex_cycles",
		label: "Code index: import cycles",
		description:
			"List circular import dependencies between TS/JS files (each result is a group of files that import each other transitively).",
		promptSnippet: "Find circular import dependencies between TS/JS files.",
		promptGuidelines: ["Use codeindex_cycles to find circular TS/JS import dependencies."],
		parameters: Type.Object({ repo: REPO_FILTER }),
		async execute(_id, params: RepoFilter, signal, _onUpdate, ctx) {
			const ws = resolveWorkspace(ctx.cwd);
			return toResult(
				fanOut(
					ws,
					params.repo,
					(store) => formatCycles(importCycles(store.importSnapshot(), store.allFiles())),
					signal,
				),
			);
		},
	});

	pi.registerTool({
		name: "codeindex_status",
		label: "Code index: status",
		description: "Index status per repo (counts, last sync, watcher state, and background errors).",
		parameters: Type.Object({ repo: REPO_FILTER }),
		async execute(_id, params: RepoFilter, signal, _onUpdate, ctx) {
			signal?.throwIfAborted();
			const ws = resolveWorkspace(ctx.cwd);
			const { entries, trailer } = repoScan(ws, params.repo);
			if (entries.length === 0)
				return toResult([
					params.repo
						? `No repository matches repo="${params.repo}".`
						: "No repositories found for this workspace.",
				]);
			const lines: string[] = [];
			for (const { manager, tag, notice } of entries) {
				signal?.throwIfAborted();
				if (notice) lines.push(`${tag}${notice}`);
				lines.push(`${tag}${JSON.stringify({ ...manager.getStore().status(), runtime: manager.diagnostics() })}`);
			}
			if (trailer) lines.push(trailer);
			return toResult(lines);
		},
	});

	pi.registerTool({
		name: "codeindex_sync",
		label: "Code index: sync",
		description: "Force a full (re)index of the workspace repo(s) and report counts. Blocks until done.",
		parameters: Type.Object({ repo: REPO_FILTER }),
		async execute(_id, params: RepoFilter, signal, _onUpdate, ctx) {
			signal?.throwIfAborted();
			const ws = resolveWorkspace(ctx.cwd);
			const repos = ws.repos(params.repo);
			const multi = ws.multi(params.repo);
			if (repos.length === 0)
				return toResult([
					params.repo
						? `No repository matches repo="${params.repo}".`
						: "No repositories found for this workspace.",
				]);
			const lines = (await ws.syncRepos(params.repo, signal)).map(({ repo, result }) => {
				const tag = multi ? `[${repo.name}] ` : "";
				return (
					`${tag}synced: ${result.indexedFiles} reindexed, ${result.removedFiles} removed, ` +
					`${result.totalFiles} files / ${result.symbols} symbols${result.truncated ? " (file cap reached)" : ""} (${result.durationMs}ms)`
				);
			});
			// Surface repos the fan-out cap skipped, like every other multi-repo tool (never silent).
			const dropped = ws.droppedRepos(params.repo);
			if (dropped > 0) lines.push(`(+${dropped} more workspace repos not synced; pass repo=<name> to target one)`);
			return toResult(lines);
		},
	});
}
