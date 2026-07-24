/**
 * Resolution pipeline. Runs in two phases so the type hierarchy is available before
 * member calls are resolved:
 *
 *   1. Resolve `extends`/`implements` references (and emit them), building a subtype →
 *      supertype map from the precise results.
 *   2. Resolve everything else. For a `this`/`self` member call that no provider could
 *      bind precisely, fall back to walking the enclosing class's supertypes (an
 *      inherited member is a structural answer, ranked by distance, never "certain").
 *
 * Within a phase each reference takes the FIRST provider (high tier → low) that returns
 * candidates — tiers are not merged. A single high-confidence target is emitted as-is;
 * multiple candidates are confidence-weighted so an ambiguous result is never reported
 * as certain. Higher provenance overwrites lower for the same range at the store.
 */

import { INHERITANCE_ROLES, type OccurrenceRecord, type Provenance } from "../model/types.ts";
import { LOCAL_BINDING, type ResolvedTarget, type ResolverProvider, type ResolveSnapshot } from "../ports.ts";
import { addSupertype, bindInheritedMember, type Hierarchy } from "./hierarchy.ts";
import { PRECISE_RESOLUTIONS, weighTargets } from "./ranking.ts";

const HIGH_CONFIDENCE = 0.9;

/**
 * `affected`, when given, scopes emission to references in those file ids (an incremental
 * re-resolve). Pass 1 still resolves EVERY inheritance edge so the type hierarchy stays complete
 * (an affected member may inherit from a base whose `extends` lives in an unaffected file); only
 * emission is scoped. Undefined = resolve and emit everything (a full rebuild).
 */
export function resolveOccurrences(
	snapshot: ResolveSnapshot,
	providers: ResolverProvider[],
	affected?: ReadonlySet<number>,
): OccurrenceRecord[] {
	return [...iterateOccurrences(snapshot, providers, affected)];
}

/**
 * Stream resolved occurrences in deterministic pipeline order. Full-repository sync uses this
 * iterator so large graphs are persisted row-by-row instead of being retained twice in memory.
 */
export function* iterateOccurrences(
	snapshot: ResolveSnapshot,
	providers: ResolverProvider[],
	affected?: ReadonlySet<number>,
): Generator<OccurrenceRecord> {
	const ordered = [...providers].filter((provider) => provider.available(snapshot)).sort((a, b) => b.tier - a.tier);

	const occurrence = (
		ref: SnapshotRef,
		moniker: string,
		provenance: Provenance,
		confidence: number,
	): OccurrenceRecord => ({
		symbol: moniker,
		file: ref.path,
		range: ref.range,
		role: ref.role,
		...(ref.enclosing ? { enclosing: ref.enclosing } : {}),
		provenance,
		confidence,
	});

	const resolve = (ref: SnapshotRef): { provenance: Provenance; targets: ResolvedTarget[] } | undefined => {
		for (const provider of ordered) {
			if (!providerApplies(provider, ref)) continue;
			const targets = provider.resolve(ref, snapshot);
			if (targets.length > 0) return { provenance: provider.provenance, targets };
		}
		return undefined;
	};

	const emit = function* (
		ref: SnapshotRef,
		provenance: Provenance,
		targets: ResolvedTarget[],
	): Generator<OccurrenceRecord> {
		const single = targets.length === 1 && targets[0] !== undefined && targets[0].confidence >= HIGH_CONFIDENCE;
		for (const candidate of single ? targets : weighTargets(targets)) {
			// Terminal local suppression: the provider claimed the ref but there is no symbol
			// edge to emit (a param/local). Nothing is pushed; lower tiers never ran.
			if (candidate.moniker === LOCAL_BINDING) continue;
			yield occurrence(ref, candidate.moniker, provenance, candidate.confidence);
		}
	};

	// First pass: resolve inheritance edges, emit them, and build the supertype map from precise results.
	const hierarchy: Hierarchy = new Map();
	for (const ref of snapshot.references) {
		if (!isInheritance(ref.role)) continue;
		const result = resolve(ref);
		if (!result) continue;
		if (affected === undefined || affected.has(ref.fileId)) yield* emit(ref, result.provenance, result.targets);
		if (ref.enclosing) {
			for (const target of result.targets) {
				if (PRECISE_RESOLUTIONS.has(target.resolution)) addSupertype(hierarchy, ref.enclosing, target.moniker);
			}
		}
	}

	// Second pass: resolve every other reference, with an inherited-member fallback for this/self calls.
	for (const ref of snapshot.references) {
		if (isInheritance(ref.role)) continue;
		if (affected !== undefined && !affected.has(ref.fileId)) continue;
		const result = resolve(ref);
		const precise = result?.targets.some((target) => PRECISE_RESOLUTIONS.has(target.resolution)) ?? false;
		if (!precise && (ref.receiver === "this" || ref.receiver === "self")) {
			const inherited = bindInheritedMember(ref, snapshot, hierarchy);
			if (inherited.length > 0) {
				for (const candidate of inherited)
					yield occurrence(ref, candidate.moniker, "syntactic", candidate.confidence);
				continue;
			}
		}
		if (result) yield* emit(ref, result.provenance, result.targets);
	}
}

type SnapshotRef = ResolveSnapshot["references"][number];

function isInheritance(role: SnapshotRef["role"]): boolean {
	return (INHERITANCE_ROLES as readonly string[]).includes(role);
}

/** Whether a provider handles a reference's file, by extension (its declared language set, or `*`). */
function providerApplies(provider: ResolverProvider, ref: { path: string }): boolean {
	if (provider.languages === "*") return true;
	const dot = ref.path.lastIndexOf(".");
	const ext = dot === -1 ? "" : ref.path.slice(dot);
	return provider.languages.has(ext);
}
