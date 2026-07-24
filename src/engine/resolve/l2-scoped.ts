/**
 * Scope-graph resolver. Binds a reference to a
 * declaration using the per-file scope graph: walk from the reference's innermost
 * scope outward and take the nearest scope that declares the name. This is precise
 * intra-file name resolution that respects nesting and shadowing — it picks the *one*
 * correct same-name definition where the syntactic resolver's same-file match would return all
 * of them at 1/N confidence.
 *
 * Scope (languages with `locals.scm`): TS/TSX/JS/Ruby shipped + Python/Go/Java vendored. Behaviour:
 *  - binds to a tracked same-file symbol  → one target, confidence 1.0, "scoped" (wins)
 *  - binds to a local (param/var) or free → returns nothing; the syntactic resolver handles import/name
 *
 * Scope edges are file-local. Imported and global names return no result here and
 * continue to the syntactic resolver's cross-file binders.
 */

import type { Provenance } from "../model/types.ts";
import { scopedExtensions } from "../parser/languages.ts";
import {
	LOCAL_BINDING,
	type ResolvedTarget,
	type ResolverProvider,
	type ResolveSnapshot,
	type SnapshotReference,
} from "../ports.ts";

export class ScopedResolver implements ResolverProvider {
	readonly tier = 2 as const;
	readonly provenance: Provenance = "scoped";
	readonly languages: ReadonlySet<string> = new Set(scopedExtensions());

	available(): boolean {
		return true;
	}

	resolve(ref: SnapshotReference, snapshot: ResolveSnapshot): ResolvedTarget[] {
		// Lexical scope binds UNQUALIFIED names only. Any receiver-qualified ref — `pkg.f()`, `obj.m()`,
		// `Class.m()`, and also `this.m()`/`self.m()` — is a member/cross-file/typed concern whose target
		// is decided by the receiver's type, not the local scope chain, so defer it. (A `this.m` bound
		// here by bare name could pick an unrelated same-name method at `scoped 1.0`.)
		if (ref.receiver) return [];
		const binding = snapshot.scopeBinding(ref.fileId, ref.name, ref.range[0], ref.range[1], ref.scopeIdx);
		if (binding.moniker) return [{ moniker: binding.moniker, resolution: "scoped", confidence: 1 }];
		// A bare name bound to a local (param/var) is terminal: suppress any lower-tier (false) edge.
		if (binding.bound) return [{ moniker: LOCAL_BINDING, resolution: "local", confidence: 1 }];
		// Free (imported/global) name: defer to the syntactic resolver.
		return [];
	}
}
