/**
 * Inheritance-aware member binding. When a member call's receiver type is known
 * (`this`/`self` → the enclosing class), a member that isn't declared on that class can
 * still be resolved by walking up its supertypes. This is a *fallback* used only when
 * the regular providers found nothing precise: an exact (type-checked) binding always
 * wins, and a member on the receiver's own class is already resolved precisely by
 * same-file/import binding.
 *
 * Candidates are ranked by inheritance distance (nearer wins); equal-distance hits are
 * kept as several candidates rather than a silent pick, and confidence never climbs into
 * "certain" — this stays a structural guess, not a typed fact.
 */

import type { ResolveSnapshot, SnapshotSymbol } from "../ports.ts";

/** subtype moniker → its direct base/interface monikers, in declared order. */
export type Hierarchy = Map<string, string[]>;

export function addSupertype(hierarchy: Hierarchy, subtype: string, base: string): void {
	const bases = hierarchy.get(subtype);
	if (bases) {
		if (!bases.includes(base)) bases.push(base);
	} else {
		hierarchy.set(subtype, [base]);
	}
}

/** Breadth-first supertype walk from `root` (distance 0); cycle-safe, declared order kept. */
export function supertypeChain(hierarchy: Hierarchy, root: string): Array<{ moniker: string; distance: number }> {
	const chain = [{ moniker: root, distance: 0 }];
	const seen = new Set([root]);
	let frontier = [root];
	for (let distance = 1; frontier.length > 0; distance++) {
		const next: string[] = [];
		for (const node of frontier) {
			for (const base of hierarchy.get(node) ?? []) {
				if (seen.has(base)) continue;
				seen.add(base);
				next.push(base);
				chain.push({ moniker: base, distance });
			}
		}
		frontier = next;
	}
	return chain;
}

const CLASS_KINDS = new Set(["class", "interface", "abstract_class", "struct", "trait", "type", "module", "enum"]);

/** Confidence for an inherited member at `distance` hops; decays with distance, never certain. */
function distanceConfidence(distance: number): number {
	return Math.max(0.5, 0.85 - 0.1 * (distance - 1));
}

/**
 * Resolve a `this`/`self` member reference to members inherited from supertypes.
 * Returns ranked candidates, or `[]` when the receiver type or a matching member is
 * unknown (the caller then keeps the providers' own result — never a confident guess).
 */
export function bindInheritedMember(
	ref: { name: string; receiver?: string; enclosing?: string },
	snapshot: ResolveSnapshot,
	hierarchy: Hierarchy,
): Array<{ moniker: string; confidence: number }> {
	// The receiver's owner type is only known for `this`/`self` (the enclosing class).
	// Constructor/variable/qualified receivers need real type inference and are not guessed.
	if ((ref.receiver !== "this" && ref.receiver !== "self") || !ref.enclosing) return [];
	const enclosingMethod = snapshot.symbolByMoniker(ref.enclosing);
	if (!enclosingMethod?.ownerType) return [];
	const klass = pickClass(snapshot.symbolsInFileNamed(enclosingMethod.fileId, enclosingMethod.ownerType));
	if (!klass) return [];

	// Eligible members per inheritance distance, skipping the receiver's own class (distance 0
	// — already bound precisely by the regular providers). An instance receiver cannot dispatch
	// a `static` member, so those are excluded; declaration-only members (interface signatures
	// / abstract methods) are flagged so a concrete implementation can outrank them.
	const candidates: Array<{ moniker: string; distance: number; declarationOnly: boolean }> = [];
	for (const { moniker, distance } of supertypeChain(hierarchy, klass.moniker)) {
		if (distance === 0) continue;
		const owningClass = snapshot.symbolByMoniker(moniker);
		if (!owningClass) continue;
		const ownerIsInterface = owningClass.kind === "interface";
		for (const member of snapshot.symbolsInFileNamed(owningClass.fileId, ref.name)) {
			if (member.ownerType !== owningClass.name || member.isStatic === true) continue;
			candidates.push({
				moniker: member.moniker,
				distance,
				declarationOnly: member.isAbstract === true || ownerIsInterface,
			});
		}
	}
	if (candidates.length === 0) return [];

	// Prefer a concrete implementation; when only declarations exist (e.g. a diamond of
	// interface signatures) keep them, but never above the bare name-guess ceiling.
	const hasConcrete = candidates.some((candidate) => !candidate.declarationOnly);
	const kept = hasConcrete ? candidates.filter((candidate) => !candidate.declarationOnly) : candidates;

	const perDistance = new Map<number, string[]>();
	for (const candidate of kept) {
		const monikers = perDistance.get(candidate.distance);
		if (monikers) {
			if (!monikers.includes(candidate.moniker)) monikers.push(candidate.moniker);
		} else {
			perDistance.set(candidate.distance, [candidate.moniker]);
		}
	}

	// Only the NEAREST distance with surviving candidates is a real dispatch target — a nearer
	// override shadows farther definitions of the same member. Equal-distance ties (e.g. a diamond)
	// fan out and split confidence; farther distances are dropped, not emitted as extra candidates.
	const nearest = [...perDistance.keys()].sort((a, b) => a - b)[0];
	if (nearest === undefined) return [];
	const monikers = perDistance.get(nearest) ?? [];
	const base = hasConcrete ? distanceConfidence(nearest) : Math.min(distanceConfidence(nearest), 0.5);
	const confidence = monikers.length > 1 ? base / monikers.length : base;
	return monikers.map((moniker) => ({ moniker, confidence }));
}

/** Prefer a class/interface-like declaration for the owner name; fall back to the first. */
function pickClass(candidates: readonly SnapshotSymbol[]): SnapshotSymbol | undefined {
	return candidates.find((symbol) => CLASS_KINDS.has(symbol.kind)) ?? candidates[0];
}
