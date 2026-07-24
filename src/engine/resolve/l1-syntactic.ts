/**
 * Syntactic resolver. Binds a reference to candidate definition
 * symbols using only syntactic facts, in priority order:
 *
 *   1. import-bound  — the name/namespace is imported; follow the module + re-exports
 *   2. same-file     — a definition of the name lives in the same file
 *   3. name          — any same-name definition elsewhere (recall fallback, ambiguous)
 *
 * Ambiguity weighting: same-name matches are kept and split confidence equally WHILE the ambiguity
 * stays tractable; an intractably wide name-only set (more than the ranking fan-out cap) is dropped
 * later by `weighTargets`, since a 1/N guess is not actionable. Import/same-file matches stay precise.
 */

import { ECMASCRIPT, resolveTsModule } from "../imports/ts-modules.ts";
import type { Provenance } from "../model/types.ts";
import { languageForFile } from "../parser/languages.ts";
import type { ResolvedTarget, ResolverProvider, ResolveSnapshot, SnapshotReference, SnapshotSymbol } from "../ports.ts";
import { bindCrossFile } from "./cross-file.ts";
import { MAX_NAME_FANOUT } from "./ranking.ts";

export class SyntacticResolver implements ResolverProvider {
	readonly tier = 1 as const;
	readonly provenance: Provenance = "syntactic";
	readonly languages = "*" as const;

	available(): boolean {
		return true;
	}

	resolve(ref: SnapshotReference, snapshot: ResolveSnapshot): ResolvedTarget[] {
		const lang = languageForFile(ref.path);
		// Cross-file: TS/JS use module/re-export resolution; other languages use their
		// own focused binder (Go packages, Python modules, Java packages).
		const crossFile =
			lang && ECMASCRIPT.has(lang) ? this.resolveImported(ref, snapshot) : bindCrossFile(lang ?? "", ref, snapshot);
		if (crossFile.length > 0) return crossFile;

		const byName = snapshot.symbolsByName(ref.name);

		// Unqualified call (`m()`): a same-file definition is the precise target.
		if (!ref.receiver) {
			const sameFile = byName.filter((symbol) => symbol.fileId === ref.fileId);
			if (sameFile.length > 0) return sameFile.map((symbol) => target(symbol, "same-file", 1));
		}

		// `this.m()`/`self.m()`: bind ONLY to the enclosing owner type's own member — never another
		// same-named member in the file. If the owner declares no such member, defer (return nothing) so
		// the pipeline's inherited-member fallback resolves it against the supertypes. This is what keeps
		// `this.m()` from confidently binding to an unrelated class's `m`.
		if (ref.receiver === "this" || ref.receiver === "self") {
			const owner = ref.enclosing ? snapshot.symbolByMoniker(ref.enclosing)?.ownerType : undefined;
			if (!owner) return [];
			return byName
				.filter((symbol) => symbol.fileId === ref.fileId && symbol.ownerType === owner)
				.map((symbol) => target(symbol, "same-file", 1));
		}

		// Other receiver (`obj.m()`, `C::m()`) or an unqualified call with no same-file def: same-name
		// candidates in compatible-language files, kept as guesses (the receiver's TYPE, not the file,
		// picks the real target, so never a confident bind). A reference in a `.rb` file must not bind to
		// a same-named symbol in a `.js`/`.go`/… file. Down-weight any whose declared arity can't accept
		// this call's arg count; the ranking layer may later drop an intractably wide set (MAX_NAME_FANOUT).
		const candidates: ResolvedTarget[] = [];
		for (const symbol of byName) {
			if (!compatibleLanguage(lang, languageForFile(snapshot.pathByFileId(symbol.fileId) ?? ""))) continue;
			// Every candidate in this fallback is name-only. The ranking layer will discard the whole
			// set above its ambiguity cap, so stop at the ninth instead of materializing thousands of
			// doomed targets for common names such as `get` or `dispose`.
			if (candidates.length === MAX_NAME_FANOUT) return [];
			candidates.push(target(symbol, "name", arityIncompatible(lang, ref, symbol) ? 0.25 : 0.5));
		}
		return candidates;
	}

	private resolveImported(ref: SnapshotReference, snapshot: ResolveSnapshot): ResolvedTarget[] {
		const imports = snapshot.importsInFile(ref.fileId);
		const matches = imports.filter((item) =>
			ref.receiver
				? item.kind === "namespace" && item.local === ref.receiver
				: (item.kind === "named" || item.kind === "default") && item.local === ref.name,
		);
		const targets: SnapshotSymbol[] = [];
		for (const item of matches) {
			const targetFileId = resolveTsModule(snapshot, ref.path, item.source);
			if (targetFileId === undefined) continue;
			const importedName = ref.receiver ? ref.name : (item.imported ?? ref.name);
			targets.push(...resolveExport(snapshot, targetFileId, importedName, new Set()));
		}
		return dedupe(targets).map((symbol) => target(symbol, "import", 0.9));
	}
}

function resolveExport(
	snapshot: ResolveSnapshot,
	fileId: number,
	name: string,
	visited: Set<string>,
): SnapshotSymbol[] {
	const key = `${fileId}:${name}`;
	if (visited.has(key)) return [];
	visited.add(key);
	const direct = snapshot
		.exportedSymbols(fileId)
		.filter((symbol) => symbol.name === name || symbol.exportedAs === name);
	if (direct.length > 0) return [...direct];
	const fromPath = snapshot.pathByFileId(fileId);
	if (!fromPath) return [];
	const resolved: SnapshotSymbol[] = [];
	for (const item of snapshot.importsInFile(fileId)) {
		if (item.kind !== "reexport" && item.kind !== "reexport-star") continue;
		if (item.kind === "reexport" && item.local !== name) continue;
		const targetFileId = resolveTsModule(snapshot, fromPath, item.source);
		if (targetFileId === undefined) continue;
		resolved.push(...resolveExport(snapshot, targetFileId, item.imported ?? name, visited));
	}
	return dedupe(resolved);
}

/**
 * A candidate is arity-incompatible only when the call passes MORE arguments than a
 * non-variadic callable declares, AND the language rejects extra positional arguments.
 * JS/TS ignore extra args (`f(1,2)` for `f(a)` is legal), so they are exempt. "Too few"
 * is left compatible (optional/default params) and missing counts are unknown — so the
 * signal only fires on a genuine mismatch and never demotes a real target.
 */
function arityIncompatible(lang: string | undefined, ref: SnapshotReference, symbol: SnapshotSymbol): boolean {
	if (!lang || ECMASCRIPT.has(lang)) return false;
	return (
		ref.argCount !== undefined &&
		symbol.paramCount !== undefined &&
		!symbol.variadic &&
		ref.argCount > symbol.paramCount
	);
}

/**
 * Whether a reference's language and a candidate symbol's language can resolve to each other.
 * Same language always; the ECMAScript family (TS/TSX/JS) is mutually compatible (a `.ts` file
 * legitimately references a `.js` symbol). Everything else must match exactly.
 */
function compatibleLanguage(refLang: string | undefined, candidateLang: string | undefined): boolean {
	if (refLang === undefined || candidateLang === undefined) return false;
	if (refLang === candidateLang) return true;
	return ECMASCRIPT.has(refLang) && ECMASCRIPT.has(candidateLang);
}

function target(symbol: SnapshotSymbol, resolution: string, confidence: number): ResolvedTarget {
	return { moniker: symbol.moniker, resolution, confidence };
}

function dedupe(symbols: SnapshotSymbol[]): SnapshotSymbol[] {
	return [...new Map(symbols.map((symbol) => [symbol.moniker, symbol])).values()];
}
