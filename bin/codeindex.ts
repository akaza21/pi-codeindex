#!/usr/bin/env node
/** Standalone `codeindex` CLI: index a repo and run queries without pi (pure engine, no pi imports). */

import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { readRepoFile } from "../src/engine/adapters/repo-path.ts";
import {
	defaultDbPath,
	type ExplorationResult,
	exportScip,
	importCycles,
	ingestScip,
	NodeFileSystem,
	type OccurrenceHit,
	openIndex,
	type Store,
	type StructuralHit,
	type SymbolHit,
	scipAvailable,
	structuralSearch,
	TreeSitterParser,
} from "../src/engine/index.ts";
import {
	DEFAULT_EXPLORE_BUDGET,
	MAX_EXPLORE_BUDGET,
	MAX_IMPACT_DEPTH,
	MAX_INDEX_FILE_LIMIT,
	MAX_QUERY_RESULTS,
} from "../src/limits.ts";

const USAGE = `codeindex — layered code index (standalone)

Usage:
  codeindex sync [dir]
  codeindex status [dir]
  codeindex search   <query>  [dir]
  codeindex def      <name>   [dir]
  codeindex callers  <name>   [dir]
  codeindex callees  <name>   [dir]
  codeindex refs     <name>   [dir]
  codeindex implementers <name> [dir]
  codeindex supertypes   <name> [dir]
  codeindex impact   <name>   [dir] [--depth N]
  codeindex explore  <name>   [dir] [--budget N]   definition, source, relationships, and impact
  codeindex match    <query>  [dir] --lang L [--path P]   find code by AST shape (tree-sitter query)
  codeindex files    [pattern] [dir]   list indexed file paths (pattern = path substring filter)
  codeindex scip     [out.scip] [dir]   export a SCIP index (needs optional protobufjs)
  codeindex scip-import <in.scip> [dir] ingest a SCIP index (replaces all prior ingested facts)
  codeindex cycles   [dir]              list circular import dependencies (TS/JS)

Flags:
  -h, --help  show this help
  -v, --version  show the installed package version
  --typed     enable TypeScript type-aware resolution (default file cap 500)
  --max-files N  source-file cap (default 20000; typed default 500; max 100000)
  --limit N   max results (max 500)   --depth N   impact traversal depth (max 10)
  --moniker M (callers/callees/refs/impact) target one declaration via an [id: …] from def/search
  --lang L    (match) language of the query   --path P   (match) restrict to paths containing P
  --verify    (status) walk the repo and report changed/new/deleted counts vs the index
  --budget N  (explore) approx max output chars (default 6000; max 50000)

Reads serve whatever is indexed; run \`sync\` first (or after edits).`;

interface Args {
	command: string;
	positional: string[];
	depth: number;
	limit: number;
	budget: number;
	typed: boolean;
	maxFiles?: number;
	verify: boolean;
	moniker?: string;
	lang?: string;
	path?: string;
}

/** Parse a positive-integer flag value; a missing or non-numeric value is a hard error. */
function intArg(flag: string, raw: string | undefined, maximum: number): number {
	if (raw === undefined || raw.startsWith("--")) {
		console.error(`${flag} requires a positive integer value`);
		process.exit(1);
	}
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 1) {
		console.error(`${flag} expects a positive integer, got "${raw}"`);
		process.exit(1);
	}
	if (value > maximum) {
		console.error(`${flag} must not exceed ${maximum.toLocaleString("en-US")}, got "${raw}"`);
		process.exit(1);
	}
	return value;
}

function parseArgs(argv: string[]): Args {
	const positional: string[] = [];
	let depth = 2;
	let limit = 20;
	let budget = DEFAULT_EXPLORE_BUDGET;
	let typed = false;
	let maxFiles: number | undefined;
	let verify = false;
	const strValues: Record<string, string> = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--depth") depth = intArg("--depth", argv[++i], MAX_IMPACT_DEPTH);
		else if (arg === "--limit") limit = intArg("--limit", argv[++i], MAX_QUERY_RESULTS);
		else if (arg === "--budget") budget = intArg("--budget", argv[++i], MAX_EXPLORE_BUDGET);
		else if (arg === "--max-files") maxFiles = intArg("--max-files", argv[++i], MAX_INDEX_FILE_LIMIT);
		else if (arg === "--typed") typed = true;
		else if (arg === "--verify") verify = true;
		else if (arg === "--moniker" || arg === "--lang" || arg === "--path") {
			const value = argv[++i];
			if (value === undefined || value.startsWith("--")) {
				console.error(`${arg} requires a value`);
				process.exit(1);
			}
			strValues[arg.slice(2)] = value;
		} else if (arg?.startsWith("--")) {
			console.error(`unknown flag: ${arg}`);
			process.exit(1);
		} else if (arg !== undefined) positional.push(arg);
	}
	const { moniker, lang, path } = strValues;
	return {
		command: positional.shift() ?? "",
		positional,
		depth,
		limit,
		budget,
		typed,
		...(maxFiles === undefined ? {} : { maxFiles }),
		verify,
		...(moniker ? { moniker } : {}),
		...(lang ? { lang } : {}),
		...(path ? { path } : {}),
	};
}

/** Trailing arg is the repo root only if it's an existing directory; else it's part of the query. */
// Commands whose sole/trailing positional is the repo dir (no query of their own): a lone existing
// dir is consumed as the root, not as a query/pattern. `files` (optional path filter) and any
// `--moniker` query join this rule at the call site, since neither needs a positional name.
const DIR_ONLY_COMMANDS = new Set(["sync", "cycles", "scip", "scip-import", "status"]);

function rootFrom(positional: string[], lonePositionalIsRoot: boolean): { root: string; rest: string[] } {
	const rest = [...positional];
	const last = rest.at(-1);
	// Treat a trailing existing directory as the repo root — but for a query command with a single
	// positional never consume it (so `search src` searches for "src" even when ./src exists; pass a
	// dir as a second arg, e.g. `search src ./repo`).
	if (last !== undefined && isDirectory(resolve(last)) && (lonePositionalIsRoot || rest.length >= 2)) {
		return { root: resolve(rest.pop() as string), rest };
	}
	return { root: process.cwd(), rest };
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function symbolText(hit: SymbolHit): string {
	const mods = [hit.visibility, hit.isStatic ? "static" : undefined, hit.isAbstract ? "abstract" : undefined]
		.filter(Boolean)
		.join(" ");
	const prefix = mods ? `${mods} ` : "";
	const owner = hit.ownerType ? `${hit.ownerType}.` : "";
	return `${prefix}${hit.kind} ${owner}${hit.name}  ${hit.file}:${hit.range[0]}${hit.exported ? "  (exported)" : ""}${hit.moniker ? `  [id: ${hit.moniker}]` : ""}`;
}

function printSymbols(hits: SymbolHit[]): void {
	for (const hit of hits) console.log(symbolText(hit));
}

function occurrenceText(hit: OccurrenceHit, arrow: (h: OccurrenceHit) => string): string {
	// Impact rows carry a hop depth: 1 = a direct caller, deeper = reached transitively.
	const label = hit.depth === undefined ? "" : hit.depth === 1 ? "direct " : `transitive (depth ${hit.depth}) `;
	const sites = hit.sites && hit.sites > 1 ? `  (sites: ${hit.sites})` : "";
	return `${label}${arrow(hit)}  ${hit.file}:${hit.range[0]}  [${hit.provenance}, ${hit.confidence.toFixed(2)}]${sites}`;
}

function printOccurrences(hits: OccurrenceHit[], arrow: (h: OccurrenceHit) => string): void {
	for (const hit of hits) console.log(occurrenceText(hit, arrow));
}

function readSource(root: string, rel: string): string | undefined {
	return readRepoFile(root, rel);
}

const EXPLORE_BODY_LINES = 12;

/** Print an exploration result within the requested output budget. */
function printExploration(
	d: ExplorationResult,
	budget: number,
	sel: { name: string } | { moniker: string },
	root: string,
): void {
	if (d.candidates.length === 0) {
		console.log("name" in sel ? `no symbol named "${sel.name}"` : `no declaration matches moniker "${sel.moniker}"`);
		return;
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
		force(`${d.candidates.length} candidates — pass a moniker to inspect one declaration:`);
		for (const c of d.candidates) if (!add(symbolText(c))) break;
	} else {
		const r = d.resolved;
		force(symbolText(r));
		const source = readSource(root, r.file);
		if (source !== undefined) {
			const all = source.split("\n");
			const start = r.range[0] - 1;
			const last = Math.min(r.range[2] - 1, start + EXPLORE_BODY_LINES - 1);
			for (const line of all.slice(start, last + 1)) if (!add(line)) break;
			if (last < r.range[2] - 1) add(`… (+${r.range[2] - 1 - last} more body lines)`);
		}
		const followup = (cmd: string): string =>
			"name" in sel ? `${cmd} ${sel.name}` : `${cmd} --moniker ${sel.moniker}`;
		const section = (
			title: string,
			hits: OccurrenceHit[],
			total: number,
			arrow: (h: OccurrenceHit) => string,
			follow?: string,
		): void => {
			if (hits.length === 0) return;
			if (!add(`${title} (${total}):`)) return;
			let shown = 0;
			for (const h of hits) {
				if (!add(`  ${occurrenceText(h, arrow)}`)) break;
				shown++;
			}
			if (total > shown) force(`  +${total - shown} more ${title}${follow ? ` — ${follow}` : ""}`);
		};
		section("callers", d.callers, d.callerTotal, (h) => `${h.enclosing} → ${h.name}`, followup("callers"));
		section("callees", d.callees, d.calleeTotal, (h) => `${h.enclosing} → ${h.name}`, followup("callees"));
		section("implementers", d.implementers, d.implementers.length, (h) => `${h.enclosing} ${h.role} ${h.name}`);
		section("supertypes", d.supertypes, d.supertypes.length, (h) => `${h.enclosing} ${h.role} ${h.name}`);
		add(`impact: direct ${d.impactByDepth[1]}, transitive(≤2) ${d.impactByDepth[2]}`);
	}
	for (const line of out) console.log(line);
}

/** Explain a zero-result by-name query without treating index absence as proof of source absence. */
function diagnose(store: Store, name: string): void {
	const r = store.diagnoseEmpty(name);
	if (r.kind === "no-symbol") console.log(`no symbol named "${name}"`);
	else if (r.kind === "suppressed")
		console.log(
			`No stored edges for "${name}". It has ${r.definitions} declarations and ${r.sites} parsed site(s); ` +
				"ambiguous name-only sites may have been suppressed. A moniker cannot recover edges that were not stored; " +
				"use source search, typed resolution, or SCIP.",
		);
	else console.log(`"${name}" is indexed (${r.definitions} definition(s)) but has no matching edges`);
}

function printFanoutRisk(store: Store, t: { name: string } | { moniker: string }): void {
	const name = "name" in t ? t.name : store.definitionByMoniker(t.moniker)?.name;
	if (!name) return;
	const risk = store.fanoutRisk(name);
	if (!risk) return;
	console.log(
		`"${name}" has ${risk.definitions} declarations and ${risk.sites} parsed site(s). ` +
			"Name-only resolution is capped at this fan-out, so additional ambiguous sites may be absent; " +
			"use source search, typed resolution, or SCIP when completeness matters.",
	);
}

/** Explain an empty target query without treating incomplete index evidence as proof of absence. */
function diagnoseTarget(store: Store, t: { name: string } | { moniker: string }, incoming = false): void {
	if ("name" in t) diagnose(store, t.name);
	else {
		const definition = store.definitionByMoniker(t.moniker);
		if (!definition) {
			console.log(`no indexed declaration matches moniker "${t.moniker}"`);
			return;
		}
		if (incoming) {
			const reason = store.diagnoseEmpty(definition.name);
			if (reason.kind === "suppressed") {
				diagnose(store, definition.name);
				return;
			}
		}
		console.log(
			`no matching stored edges for moniker "${t.moniker}". ` +
				"Empty index output is not proof that no source relationship exists.",
		);
	}
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();
const clip = (text: string, max = 80): string => (text.length > max ? `${text.slice(0, max)}…` : text);

function printMatches(hits: StructuralHit[]): void {
	for (const hit of hits) {
		const captures = hit.captures.map((c) => `${c.name}=${clip(oneLine(c.text))}`).join("  ");
		console.log(`${hit.file}:${hit.range[0]}  ${captures}`);
	}
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	if (argv.length === 0 || argv.includes("-h") || argv.includes("--help") || argv[0] === "help") {
		console.log(USAGE);
		return;
	}
	if (argv.includes("-v") || argv.includes("--version") || argv[0] === "version") {
		const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
			version?: unknown;
		};
		if (typeof manifest.version !== "string") throw new Error("package version is missing");
		console.log(manifest.version);
		return;
	}
	const args = parseArgs(argv);
	const lonePositionalIsRoot =
		DIR_ONLY_COMMANDS.has(args.command) || args.command === "files" || args.moniker !== undefined;
	const { root, rest } = rootFrom(args.positional, lonePositionalIsRoot);
	const { store, indexer } = openIndex({
		root,
		dbPath: defaultDbPath(root),
		typed: args.typed,
		...(args.maxFiles === undefined ? {} : { maxFiles: args.maxFiles }),
	});
	try {
		await run(args, rest, root, store, indexer);
	} finally {
		store.close();
	}
}

async function run(
	args: Args,
	rest: string[],
	root: string,
	store: Store,
	indexer: {
		sync: () => Promise<import("../src/engine/index.ts").SyncResult>;
		verify: () => Promise<{ changed: number; new: number; deleted: number }>;
	},
): Promise<void> {
	const query = rest[0];
	const ensureQuery = (): string => {
		if (!query) throw new Error(`${args.command} requires an argument`);
		return query;
	};
	/** A by-target query selector: a `--moniker` or a positional name, but not both. */
	const target = (): { moniker: string } | { name: string } => {
		if (args.moniker && query) throw new Error("pass either a name or --moniker, not both");
		return args.moniker ? { moniker: args.moniker } : { name: ensureQuery() };
	};

	switch (args.command) {
		case "sync": {
			const result = await indexer.sync();
			console.log(
				`synced ${root}: ${result.indexedFiles} reindexed, ${result.removedFiles} removed, ` +
					`${result.totalFiles} files / ${result.symbols} symbols${result.truncated ? " (file cap reached)" : ""} (${result.durationMs}ms)`,
			);
			return;
		}
		case "status": {
			const status = store.status();
			console.log(JSON.stringify(args.verify ? { ...status, ...(await indexer.verify()) } : status, null, 2));
			return;
		}
		case "search": {
			const hits = store.search(ensureQuery(), args.limit);
			printSymbols(hits);
			if (hits.length === 0) console.log("(no results)");
			return;
		}
		case "def": {
			const name = ensureQuery();
			const hits = store.definitions(name, args.limit);
			printSymbols(hits);
			if (hits.length === 0) diagnose(store, name);
			return;
		}
		case "callers": {
			const t = target();
			const hits =
				"moniker" in t ? store.callersByMoniker(t.moniker, args.limit) : store.callers(t.name, args.limit);
			printOccurrences(hits, (h) => `${h.enclosing} → ${h.name}`);
			if (hits.length === 0) diagnoseTarget(store, t, true);
			else printFanoutRisk(store, t);
			return;
		}
		case "callees": {
			const t = target();
			const hits =
				"moniker" in t ? store.calleesByMoniker(t.moniker, args.limit) : store.callees(t.name, args.limit);
			printOccurrences(hits, (h) => `${h.enclosing} → ${h.name}`);
			if (hits.length === 0) diagnoseTarget(store, t);
			return;
		}
		case "refs": {
			const t = target();
			const hits =
				"moniker" in t ? store.referencesByMoniker(t.moniker, args.limit) : store.references(t.name, args.limit);
			printOccurrences(hits, (h) => `${h.name} (in ${h.enclosing})`);
			if (hits.length === 0) diagnoseTarget(store, t, true);
			else printFanoutRisk(store, t);
			return;
		}
		case "implementers": {
			const name = ensureQuery();
			const hits = store.implementers(name, args.limit);
			printOccurrences(hits, (h) => `${h.enclosing} ${h.role} ${h.name}`);
			if (store.hasDefinitionInLanguage(name, "go", "interface")) {
				console.log(
					"Go uses structural interface satisfaction, which this index does not compute. " +
						"Results above contain only stored explicit hierarchy edges; use gopls, SCIP, or source search for complete Go implementers.",
				);
			} else if (hits.length === 0) diagnose(store, name);
			return;
		}
		case "supertypes": {
			const name = ensureQuery();
			const hits = store.supertypes(name, args.limit);
			printOccurrences(hits, (h) => `${h.enclosing} ${h.role} ${h.name}`);
			if (
				store.hasDefinitionInLanguage(name, "go", "interface") ||
				store.hasDefinitionInLanguage(name, "go", "type")
			) {
				console.log(
					"Go type/interface embedding and structural satisfaction are not computed. " +
						"Results above contain only stored explicit hierarchy edges; use gopls, SCIP, or source inspection for complete Go relationships.",
				);
			} else if (hits.length === 0) diagnose(store, name);
			return;
		}
		case "impact": {
			const t = target();
			const hits =
				"moniker" in t
					? store.impactByMoniker(t.moniker, args.depth, args.limit)
					: store.impact(t.name, args.depth, args.limit);
			printOccurrences(hits, (h) => `${h.enclosing} → ${h.name}`);
			if (hits.length === 0) diagnoseTarget(store, t, true);
			else printFanoutRisk(store, t);
			return;
		}
		case "explore": {
			const t = target();
			const result = store.explore(t);
			printExploration(result, args.budget, t, root);
			const subjectName = "name" in t ? t.name : result.resolved?.name;
			if (subjectName) {
				const reason = store.diagnoseEmpty(subjectName);
				if (reason.kind === "suppressed") diagnose(store, subjectName);
				else printFanoutRisk(store, { name: subjectName });
			}
			return;
		}
		case "match": {
			const pattern = ensureQuery();
			if (!args.lang) throw new Error("match requires --lang <language>");
			const hits = await structuralSearch(
				{ store, fs: new NodeFileSystem(root), parser: new TreeSitterParser(), root },
				{ lang: args.lang, pattern, ...(args.path ? { path: args.path } : {}), limit: args.limit },
			);
			printMatches(hits);
			if (hits.length === 0) console.log("(no results)");
			return;
		}
		case "files": {
			const paths = store.files(query, args.limit);
			for (const path of paths) console.log(path);
			if (paths.length === 0) console.log("(no results)");
			return;
		}
		case "cycles": {
			await indexer.sync();
			const cycles = importCycles(store.snapshot(), store.allFiles());
			if (cycles.length === 0) console.log("(no import cycles)");
			for (const cycle of cycles)
				console.log(`cycle group (${cycle.files.length} files): ${cycle.files.join(", ")}`);
			return;
		}
		case "scip": {
			if (!scipAvailable()) {
				throw new Error(
					"SCIP export needs the optional 'protobufjs' dependency — install it with `npm i protobufjs`.",
				);
			}
			await indexer.sync();
			const out = query ?? "index.scip";
			const bytes = exportScip(store, { projectRoot: root, repo: basename(root) });
			writeFileSync(out, bytes);
			console.log(`wrote ${out}: ${bytes.length} bytes, ${store.status().symbols} symbols`);
			return;
		}
		case "scip-import": {
			if (!scipAvailable()) {
				throw new Error(
					"SCIP ingest needs the optional 'protobufjs' dependency — install it with `npm i protobufjs`.",
				);
			}
			if (!query) throw new Error("scip-import requires a <file.scip> argument");
			let bytes: Uint8Array;
			try {
				bytes = readFileSync(query);
			} catch (error) {
				throw new Error(`cannot read ${query}: ${(error as Error).message}`);
			}
			await indexer.sync();
			const occurrences = ingestScip(store.snapshot(), bytes, {
				readSource: (relativePath) => readSource(root, relativePath),
			});
			store.replaceIngestedOccurrences(occurrences);
			console.log(`ingested ${occurrences.length} scip occurrences from ${query}`);
			return;
		}
		default:
			console.error(`Unknown command: ${args.command}\n`);
			console.log(USAGE);
			process.exitCode = 1;
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
