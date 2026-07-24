/**
 * Import-cycle detection: circular import dependencies between TS/JS files, at file granularity.
 *
 * Scope is TS/JS because ECMAScript modules map cleanly one-to-one to files (and circular ES
 * imports are the classic, painful case). Other languages import packages/modules (directories),
 * a coarser unit that is a separate concern. Each file becomes a node; an edge A→B means A imports
 * a module that resolves to indexed file B. A cycle group is a strongly-connected component of size
 * ≥ 2 (its files are mutually reachable, so they import each other transitively) — or a single file
 * that imports itself. Reported as the set of files in the group; break the cycle anywhere within.
 *
 * Uses the same module→file resolution as the resolver (config-aware: tsconfig paths/baseUrl), so a
 * cycle here is a cycle the index actually believes in.
 */

import type { FileMeta, ImportSnapshot } from "../ports.ts";
import { ECMASCRIPT, resolveTsModule } from "./ts-modules.ts";

export interface ImportCycle {
	/** Repo-relative paths of the files in the cycle group, sorted. */
	files: string[];
}

export function importCycles(snapshot: ImportSnapshot, files: readonly FileMeta[]): ImportCycle[] {
	const byId = new Map<number, FileMeta>();
	for (const file of files) {
		if (ECMASCRIPT.has(file.lang)) byId.set(file.id, file);
	}

	// File-level import graph over TS/JS files only: A → B when A imports a module resolving to B.
	const adjacency = new Map<number, number[]>();
	for (const file of byId.values()) {
		const targets = new Set<number>();
		for (const imp of snapshot.importsInFile(file.id)) {
			const targetId = resolveTsModule(snapshot, file.path, imp.source);
			if (targetId !== undefined && byId.has(targetId)) targets.add(targetId);
		}
		adjacency.set(
			file.id,
			[...targets].sort((a, b) => a - b),
		);
	}

	const cycles: ImportCycle[] = [];
	for (const component of stronglyConnectedComponents(adjacency)) {
		const selfImport =
			component.length === 1 && (adjacency.get(component[0] as number) ?? []).includes(component[0] as number);
		if (component.length < 2 && !selfImport) continue;
		const paths = component.map((id) => (byId.get(id) as FileMeta).path).sort();
		cycles.push({ files: paths });
	}
	// Largest groups first; then by first file, for a stable order.
	cycles.sort((a, b) => {
		if (b.files.length !== a.files.length) return b.files.length - a.files.length;
		const [x, y] = [a.files[0] as string, b.files[0] as string];
		return x < y ? -1 : x > y ? 1 : 0;
	});
	return cycles;
}

/**
 * Tarjan's strongly-connected-components, iterative so a deep import chain cannot overflow the
 * call stack. Returns one array of node ids per component.
 */
function stronglyConnectedComponents(adjacency: Map<number, number[]>): number[][] {
	const index = new Map<number, number>();
	const lowLink = new Map<number, number>();
	const onStack = new Set<number>();
	const stack: number[] = [];
	const components: number[][] = [];
	let counter = 0;

	for (const root of adjacency.keys()) {
		if (index.has(root)) continue;
		const work: { node: number; next: number }[] = [{ node: root, next: 0 }];
		while (work.length > 0) {
			const frame = work[work.length - 1] as { node: number; next: number };
			const node = frame.node;
			if (frame.next === 0) {
				index.set(node, counter);
				lowLink.set(node, counter);
				counter++;
				stack.push(node);
				onStack.add(node);
			}
			const neighbors = adjacency.get(node) ?? [];
			if (frame.next < neighbors.length) {
				const neighbor = neighbors[frame.next] as number;
				frame.next++;
				if (!index.has(neighbor)) {
					work.push({ node: neighbor, next: 0 });
				} else if (onStack.has(neighbor)) {
					lowLink.set(node, Math.min(lowLink.get(node) as number, index.get(neighbor) as number));
				}
			} else {
				if (lowLink.get(node) === index.get(node)) {
					const component: number[] = [];
					let popped: number;
					do {
						popped = stack.pop() as number;
						onStack.delete(popped);
						component.push(popped);
					} while (popped !== node);
					components.push(component);
				}
				work.pop();
				const parent = work[work.length - 1];
				if (parent) {
					lowLink.set(parent.node, Math.min(lowLink.get(parent.node) as number, lowLink.get(node) as number));
				}
			}
		}
	}
	return components;
}
