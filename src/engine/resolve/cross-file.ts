/**
 * Per-language cross-file binders (the compiler-free slice).
 *
 * Each binder answers one focused question for its language: *"given this reference
 * and the repo index, which definition symbols in OTHER files does it bind to?"* It
 * composes only the generic index primitives on `ResolveSnapshot` (file/dir/symbol
 * lookups) — no SQL, no AST, no other language's rules. TS/JS keep their own binder in
 * the syntactic resolver (re-exports + relative paths); this module covers Go, Python,
 * Java, whose module systems the syntactic resolver didn't previously understand.
 *
 * Recall-first: a binder returns candidates (often one). The pipeline weights multiple
 * candidates; an empty result means "I can't bind this — defer to same-file/name."
 */

import type { ResolvedTarget, ResolveSnapshot, SnapshotReference, SnapshotSymbol } from "../ports.ts";

/** Per-candidate base confidence by how the binding was found. */
const CONFIDENCE: Record<string, number> = { import: 0.9, package: 0.85 };

type Binder = (ref: SnapshotReference, snap: ResolveSnapshot) => ResolvedTarget[];

const BINDERS: Record<string, Binder> = {
	go: bindGo,
	python: bindPython,
	java: bindJava,
};

export function bindCrossFile(langId: string, ref: SnapshotReference, snap: ResolveSnapshot): ResolvedTarget[] {
	return BINDERS[langId]?.(ref, snap) ?? [];
}

// `pkg.Symbol` → the imported package's directory, exported `Symbol`. A bare call →
// a sibling file in the same directory (same Go package, no import needed).

function bindGo(ref: SnapshotReference, snap: ResolveSnapshot): ResolvedTarget[] {
	if (ref.receiver) {
		const imp = snap.importsInFile(ref.fileId).find((i) => i.kind === "namespace" && i.local === ref.receiver);
		if (!imp) return [];
		const dir = resolvePackageDir(snap, imp.source);
		if (dir === undefined) return [];
		// Cross-package: only exported (capitalized) symbols are visible.
		return targets(exported(symbolsInDir(snap, dir, ref.name)), "import");
	}
	// Bare call: same-package siblings (any visibility), then dot-imported packages.
	const dir = snap.dirOf(ref.fileId);
	const siblings = symbolsInDir(snap, dir, ref.name).filter((symbol) => symbol.fileId !== ref.fileId);
	if (siblings.length > 0) return targets(siblings, "package");
	const dotImported: SnapshotSymbol[] = [];
	for (const imp of snap.importsInFile(ref.fileId)) {
		if (imp.kind !== "wildcard") continue;
		const dir2 = resolvePackageDir(snap, imp.source);
		if (dir2 !== undefined) dotImported.push(...exported(symbolsInDir(snap, dir2, ref.name)));
	}
	return targets(dotImported, "import");
}

function exported(symbols: SnapshotSymbol[]): SnapshotSymbol[] {
	return symbols.filter((symbol) => symbol.exported);
}

/**
 * Go import path → indexed directory. Prefer an exact mapping via the go.mod module
 * prefix; otherwise fall back to the longest path suffix that is an indexed directory.
 */
function resolvePackageDir(snap: ResolveSnapshot, importPath: string): string | undefined {
	const module = snap.projectLayout().goModule;
	if (module && (importPath === module || importPath.startsWith(`${module}/`))) {
		const dir = importPath === module ? "" : importPath.slice(module.length + 1);
		if (dir === "" || snap.hasDir(dir)) return dir;
	}
	const segments = importPath.split("/").filter(Boolean);
	for (let take = segments.length; take >= 1; take--) {
		const candidate = segments.slice(-take).join("/");
		if (snap.hasDir(candidate)) return candidate;
	}
	return undefined;
}

// `pkg.mod.fn()` via `import pkg.mod as alias` (namespace) → the module file, `fn`.
// `fn()` via `from pkg.mod import fn` (named) → the module file, the imported name.

function bindPython(ref: SnapshotReference, snap: ResolveSnapshot): ResolvedTarget[] {
	const imports = snap.importsInFile(ref.fileId);
	if (ref.receiver) {
		// `import pkg.mod as m; m.fn()` — m is the module itself.
		const ns = imports.find((i) => i.kind === "namespace" && (i.local === ref.receiver || i.source === ref.receiver));
		if (ns) return targets(symbolsInModule(snap, ref.path, ns.source, ref.name), "import");
		// `from pkg import mod; mod.fn()` / `from . import mod; mod.fn()` — mod is a submodule.
		const named = imports.find((i) => i.kind === "named" && i.local === ref.receiver);
		if (named) {
			const submodule = joinModule(named.source, named.imported ?? ref.receiver);
			return targets(symbolsInModule(snap, ref.path, submodule, ref.name), "import");
		}
		return [];
	}
	// `from pkg.mod import fn; fn()` — bare name bound by a from-import.
	const imp = imports.find((i) => i.kind === "named" && i.local === ref.name);
	if (!imp) return [];
	return targets(symbolsInModule(snap, ref.path, imp.source, imp.imported ?? ref.name), "import");
}

/** Join a Python module path with a submodule, preserving relative-import leading dots. */
function joinModule(source: string, name: string): string {
	return /^\.+$/.test(source) ? `${source}${name}` : `${source}.${name}`;
}

function symbolsInModule(snap: ResolveSnapshot, fromPath: string, source: string, name: string): SnapshotSymbol[] {
	const out: SnapshotSymbol[] = [];
	for (const fileId of pythonModuleFiles(snap, fromPath, source)) out.push(...snap.symbolsInFileNamed(fileId, name));
	return out;
}

function pythonModuleFiles(snap: ResolveSnapshot, fromPath: string, source: string): number[] {
	const candidates = pythonModuleCandidates(fromPath, source);
	const ids = new Set<number>();
	for (const candidate of candidates) {
		const exact = snap.fileIdByPath(candidate);
		if (exact !== undefined) ids.add(exact);
	}
	if (ids.size === 0) {
		// src/ layout etc.: match by path suffix.
		for (const candidate of candidates) for (const id of snap.filesEndingWith(candidate)) ids.add(id);
	}
	return [...ids];
}

function pythonModuleCandidates(fromPath: string, source: string): string[] {
	if (source.startsWith(".")) {
		const dots = (source.match(/^\.+/)?.[0] ?? ".").length;
		const rest = source.slice(dots).replace(/\./g, "/");
		let base = parentDir(fromPath);
		for (let up = 1; up < dots; up++) base = parentDir(base);
		// `from . import x`: x is a symbol in the package's `__init__.py` (search it here) or a submodule
		// (resolved via the receiver path). Return the package init so a bare `x()` binds to a function
		// defined in `__init__.py`.
		if (!rest) return [base ? `${base}/__init__.py` : "__init__.py"];
		const stem = base ? `${base}/${rest}` : rest;
		return [`${stem}.py`, `${stem}/__init__.py`];
	}
	const rest = source.replace(/\./g, "/");
	return [`${rest}.py`, `${rest}/__init__.py`];
}

// `Class.member()` / type refs via `import a.b.Class`; `member()` via `import static
// a.b.Class.member`; bare names via same-package sibling classes.

function bindJava(ref: SnapshotReference, snap: ResolveSnapshot): ResolvedTarget[] {
	const imports = snap.importsInFile(ref.fileId);
	if (ref.receiver) {
		// `Class.member()` — Class is a normal (non-static) imported class in package `source`.
		const named = imports.find((i) => i.kind === "named" && !i.isStatic && i.local === ref.receiver);
		if (named) return targets(symbolsInClass(snap, `${named.source}.${ref.receiver}`, ref.name), "import");
		const wild = imports.find((i) => i.kind === "wildcard");
		if (wild) {
			const viaWild = symbolsInClass(snap, `${wild.source}.${ref.receiver}`, ref.name);
			if (viaWild.length > 0) return targets(viaWild, "import");
		}
		// Same-package class: `Class.member()` where Class is a sibling file, no import.
		const dir = snap.dirOf(ref.fileId);
		const siblingFile = snap.fileIdByPath(dir ? `${dir}/${ref.receiver}.java` : `${ref.receiver}.java`);
		if (siblingFile !== undefined) return targets([...snap.symbolsInFileNamed(siblingFile, ref.name)], "package");
		return [];
	}
	// `member()` via `import static a.b.C.member` — source is the class FQN.
	const staticImport = imports.find((i) => i.kind === "named" && i.isStatic && i.local === ref.name);
	if (staticImport) {
		const viaStatic = symbolsInClass(snap, staticImport.source, ref.name);
		if (viaStatic.length > 0) return targets(viaStatic, "import");
	}
	// `member()` via `import static a.b.C.*` — any static-wildcard class may declare it.
	for (const wild of imports) {
		if (wild.kind !== "wildcard" || !wild.isStatic) continue;
		const viaWild = symbolsInClass(snap, wild.source, ref.name);
		if (viaWild.length > 0) return targets(viaWild, "import");
	}
	// `new C()` / type ref where C is a normal imported class in package `source`.
	const classImport = imports.find((i) => i.kind === "named" && !i.isStatic && i.local === ref.name);
	if (classImport) {
		const viaClass = symbolsInClass(snap, `${classImport.source}.${ref.name}`, ref.name);
		if (viaClass.length > 0) return targets(viaClass, "import");
	}
	// `new C()` / type ref where C comes from a (non-static) wildcard package import `import a.b.*`.
	for (const wild of imports) {
		if (wild.kind !== "wildcard" || wild.isStatic) continue;
		const viaWild = symbolsInClass(snap, `${wild.source}.${ref.name}`, ref.name);
		if (viaWild.length > 0) return targets(viaWild, "import");
	}
	// Same-package sibling classes/members.
	const dir = snap.dirOf(ref.fileId);
	const siblings = snap
		.fileIdsInDir(dir)
		.filter((fileId) => fileId !== ref.fileId)
		.flatMap((fileId) => [...snap.symbolsInFileNamed(fileId, ref.name)]);
	return targets(siblings, "package");
}

function symbolsInClass(snap: ResolveSnapshot, classFqn: string, name: string): SnapshotSymbol[] {
	const path = `${classFqn.replace(/\./g, "/")}.java`;
	const ids = new Set<number>();
	const exact = snap.fileIdByPath(path);
	if (exact !== undefined) ids.add(exact);
	if (ids.size === 0) for (const id of snap.filesEndingWith(path)) ids.add(id);
	const out: SnapshotSymbol[] = [];
	for (const id of ids) out.push(...snap.symbolsInFileNamed(id, name));
	return out;
}

function symbolsInDir(snap: ResolveSnapshot, dir: string, name: string): SnapshotSymbol[] {
	const out: SnapshotSymbol[] = [];
	for (const fileId of snap.fileIdsInDir(dir)) out.push(...snap.symbolsInFileNamed(fileId, name));
	return out;
}

function targets(symbols: SnapshotSymbol[], resolution: "import" | "package"): ResolvedTarget[] {
	const seen = new Set<string>();
	const out: ResolvedTarget[] = [];
	for (const symbol of symbols) {
		if (seen.has(symbol.moniker)) continue;
		seen.add(symbol.moniker);
		out.push({ moniker: symbol.moniker, resolution, confidence: CONFIDENCE[resolution] ?? 0.5 });
	}
	return out;
}

function parentDir(path: string): string {
	const slash = path.lastIndexOf("/");
	return slash === -1 ? "" : path.slice(0, slash);
}
