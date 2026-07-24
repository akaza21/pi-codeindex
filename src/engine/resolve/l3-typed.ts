/**
 * Typed resolver. Uses the in-process TypeScript compiler to
 * resolve a reference to its *type-correct* definition — closing the precision gap
 * the syntactic and scope-graph resolvers can't: method dispatch on a typed receiver (`a.run()` → the right class's
 * `run`), overloads, aliased/re-exported imports, and inheritance.
 *
 * For each reference it asks the LanguageService for the definition position, then
 * maps that position back to an indexed symbol's moniker. Definitions that land
 * outside the index (node_modules `.d.ts`, lib) yield no target, so the typed resolver
 * simply defers to the scope-graph/syntactic resolvers there. TS/JS only, because this
 * package embeds only the TypeScript compiler;
 * other languages need an external provider (an LSP server or a precomputed SCIP index).
 */

import { extname, relative } from "node:path";
import type { Provenance } from "../model/types.ts";
import type { ResolvedTarget, ResolverProvider, ResolveSnapshot, SnapshotReference } from "../ports.ts";
import { TsTypeService } from "./ts-service.ts";

const TYPED_EXTENSIONS = new Set([".ts", ".mts", ".cts", ".tsx", ".js", ".mjs", ".cjs", ".jsx"]);

export class TypedResolver implements ResolverProvider {
	readonly tier = 3 as const;
	readonly provenance: Provenance = "typed";
	readonly languages: ReadonlySet<string> = TYPED_EXTENSIONS;
	private readonly root: string;
	private readonly service: TsTypeService;
	private lastSnapshot?: ResolveSnapshot;

	constructor(root: string, service = new TsTypeService(root)) {
		this.root = root;
		this.service = service;
	}

	available(snapshot: ResolveSnapshot): boolean {
		if (!this.service.isAvailable()) return false;
		// A store snapshot is immutable and unique per rebuild. Recreate the language service
		// for each new snapshot so edits and removed roots cannot retain stale compiler data.
		if (this.lastSnapshot !== snapshot) {
			this.lastSnapshot = snapshot;
			const roots = new Set<string>();
			for (const ref of snapshot.references) {
				if (this.languages.has(extname(ref.path))) roots.add(`${this.root}/${ref.path}`);
			}
			this.service.reset(roots);
		}
		return true;
	}

	resolve(ref: SnapshotReference, snapshot: ResolveSnapshot): ResolvedTarget[] {
		const absFile = `${this.root}/${ref.path}`;
		const targets: ResolvedTarget[] = [];
		const seen = new Set<string>();
		for (const def of this.service.definitions(absFile, ref.range[0], ref.range[1])) {
			const rel = relative(this.root, def.file).replaceAll("\\", "/");
			const moniker = snapshot.symbolAt(rel, def.line, def.col);
			if (moniker && !seen.has(moniker)) {
				seen.add(moniker);
				targets.push({ moniker, resolution: "typed", confidence: 1 });
			}
		}
		return targets;
	}
}
