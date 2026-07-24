/**
 * Project layout: the per-repo config that changes how import specifiers map to files.
 * Read once from the repo's config files (via the FileSystem port, so it stays pure and
 * testable) and consulted by the cross-file binders before their path heuristics.
 *
 * Today it carries TypeScript `baseUrl`/`paths` aliases and the Go module prefix. The
 * tsconfig reader strips comments + trailing commas and parses the common shape; it does
 * NOT follow `extends` or apply full TS module-resolution rules, so a project relying on
 * `extends` misses those aliases and falls back to the relative/heuristic path.
 */

import { join } from "node:path";
import type { FileSystem } from "../ports.ts";

/** A tsconfig `paths` entry, with the trailing `*` stripped from prefix and targets. */
interface TsPathAlias {
	/** e.g. "@app/" for `"@app/*"`, or the exact key for a non-wildcard alias. */
	prefix: string;
	wildcard: boolean;
	/** Repo-relative target stems, e.g. ["src/app/"] for `["src/app/*"]`. */
	targets: string[];
}

export interface ProjectLayout {
	/** Repo-relative baseUrl for bare TS/JS imports ("" = repo root, undefined = none). */
	tsBaseUrl?: string;
	tsPaths: TsPathAlias[];
	/** Go module path from `go.mod` (e.g. "github.com/me/mod"); "" if absent. */
	goModule: string;
}

export const EMPTY_LAYOUT: ProjectLayout = { tsPaths: [], goModule: "" };

export function buildProjectLayout(fs: FileSystem, root: string): ProjectLayout {
	return {
		...readTsConfig(fs, join(root, "tsconfig.json")),
		goModule: readGoModule(fs, join(root, "go.mod")),
	};
}

/** Repo-relative path stems (no extension) an alias/baseUrl maps a bare import to. */
export function applyTsLayout(layout: ProjectLayout, source: string): string[] {
	const stems: string[] = [];
	for (const alias of layout.tsPaths) {
		if (alias.wildcard && source.startsWith(alias.prefix)) {
			const rest = source.slice(alias.prefix.length);
			for (const target of alias.targets) stems.push(rest ? `${target}/${rest}` : target);
		} else if (!alias.wildcard && source === alias.prefix) {
			stems.push(...alias.targets);
		}
	}
	if (stems.length === 0 && layout.tsBaseUrl !== undefined) {
		stems.push(layout.tsBaseUrl ? `${layout.tsBaseUrl}/${source}` : source);
	}
	return stems.map((stem) => stem.replace(/\/+$/, ""));
}

function readTsConfig(fs: FileSystem, path: string): Pick<ProjectLayout, "tsBaseUrl" | "tsPaths"> {
	const text = fs.readFile(path);
	if (text === undefined) return { tsPaths: [] };
	let config: { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } };
	try {
		config = JSON.parse(stripJsonc(text));
	} catch {
		return { tsPaths: [] };
	}
	const options = config.compilerOptions ?? {};
	const baseUrl = typeof options.baseUrl === "string" ? normalizeDir(options.baseUrl) : undefined;
	const tsPaths: TsPathAlias[] = [];
	for (const [key, targets] of Object.entries(options.paths ?? {})) {
		// Ignore malformed entries (a `paths` value must be an array of strings).
		if (!Array.isArray(targets) || !targets.every((t) => typeof t === "string")) continue;
		const wildcard = key.endsWith("*");
		tsPaths.push({
			prefix: wildcard ? key.slice(0, -1) : key,
			wildcard,
			targets: targets.map((t) => normalizeBase(baseUrl, wildcard ? t.replace(/\*$/, "") : t)),
		});
	}
	return baseUrl === undefined ? { tsPaths } : { tsBaseUrl: baseUrl, tsPaths };
}

function readGoModule(fs: FileSystem, path: string): string {
	const text = fs.readFile(path);
	if (text === undefined) return "";
	return /^\s*module\s+(\S+)/m.exec(text)?.[1] ?? "";
}

/** tsconfig allows `//` and `/* *\/` comments and trailing commas; strip them for JSON.parse. */
function stripJsonc(text: string): string {
	return text
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/(^|[^:])\/\/.*$/gm, "$1")
		.replace(/,(\s*[}\]])/g, "$1");
}

/** tsconfig dirs are relative to the config file (repo root here); normalize "." / "./x" → "x". */
function normalizeDir(dir: string): string {
	const cleaned = dir.replace(/^\.\//, "").replace(/\/+$/, "");
	return cleaned === "." ? "" : cleaned;
}

function normalizeBase(baseUrl: string | undefined, target: string): string {
	const stem = normalizeDir(target);
	return baseUrl ? `${baseUrl}/${stem}` : stem;
}
