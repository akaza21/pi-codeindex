import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openIndex, type Store } from "../src/engine/index.ts";
import type { FileFacts, Range } from "../src/engine/ports.ts";
import { MAX_NAME_FANOUT, weighTargets } from "../src/engine/resolve/ranking.ts";

const RANGE: Range = [1, 0, 1, 6];

function emptyFacts(): FileFacts {
	return { symbols: [], references: [], imports: [], scopes: [], scopeDefs: [] };
}

/** A store seeded with one target symbol `widget` and two empty files for occurrences to sit in. */
function seededStore(): { store: Store; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "codeindex-rank-"));
	const { store } = openIndex({ root: dir, dbPath: join(dir, "index.db") });
	store.transaction(() => {
		store.upsertFileFacts("target.ts", "typescript", 1, 1, "h0", {
			...emptyFacts(),
			symbols: [
				{ moniker: "m#widget", name: "widget", kind: "function", file: "target.ts", range: RANGE, exported: true },
			],
		});
		store.upsertFileFacts("a.ts", "typescript", 1, 1, "h1", emptyFacts());
		store.upsertFileFacts("z.ts", "typescript", 1, 1, "h2", emptyFacts());
	});
	return {
		store,
		cleanup: () => {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

describe("occurrence ranking", () => {
	const cleanups: Array<() => void> = [];
	afterAll(() => {
		for (const c of cleanups) c();
	});

	it("breaks equal-confidence ties by provenance, not path", () => {
		const { store, cleanup } = seededStore();
		cleanups.push(cleanup);
		// The lower-provenance hit sits in the alphabetically-FIRST file (a.ts); a path-only
		// tie-break would put it first. Provenance must win, surfacing the typed hit (z.ts).
		store.replaceOccurrences([
			{ symbol: "m#widget", file: "a.ts", range: RANGE, role: "call", provenance: "syntactic", confidence: 1 },
			{ symbol: "m#widget", file: "z.ts", range: RANGE, role: "call", provenance: "typed", confidence: 1 },
		]);
		const hits = store.callers("widget", 10);
		expect(hits.map((h) => h.provenance)).toEqual(["typed", "syntactic"]);
	});

	it("orders by confidence first, provenance only within equal confidence", () => {
		const { store, cleanup } = seededStore();
		cleanups.push(cleanup);
		store.replaceOccurrences([
			{ symbol: "m#widget", file: "z.ts", range: RANGE, role: "call", provenance: "syntactic", confidence: 0.9 },
			{ symbol: "m#widget", file: "a.ts", range: RANGE, role: "call", provenance: "typed", confidence: 0.5 },
		]);
		const hits = store.callers("widget", 10);
		// Higher confidence wins outright even though its provenance is lower.
		expect(hits.map((h) => h.confidence)).toEqual([0.9, 0.5]);
	});

	it("is deterministic across repeated queries", () => {
		const { store, cleanup } = seededStore();
		cleanups.push(cleanup);
		store.replaceOccurrences([
			{ symbol: "m#widget", file: "z.ts", range: RANGE, role: "call", provenance: "scoped", confidence: 1 },
			{ symbol: "m#widget", file: "a.ts", range: RANGE, role: "call", provenance: "scoped", confidence: 1 },
		]);
		const once = store.callers("widget", 10).map((h) => `${h.file}:${h.provenance}`);
		const twice = store.callers("widget", 10).map((h) => `${h.file}:${h.provenance}`);
		expect(once).toEqual(twice);
		// Equal confidence AND provenance → stable path/location order.
		expect(once[0]).toBe("a.ts:scoped");
	});

	it("fully orders same-file same-line hits by column", () => {
		const { store, cleanup } = seededStore();
		cleanups.push(cleanup);
		store.replaceOccurrences([
			{ symbol: "m#widget", file: "a.ts", range: [1, 9, 1, 15], role: "call", provenance: "scoped", confidence: 1 },
			{ symbol: "m#widget", file: "a.ts", range: [1, 2, 1, 8], role: "call", provenance: "scoped", confidence: 1 },
		]);
		expect(store.callers("widget", 10).map((h) => h.range[1])).toEqual([2, 9]);
	});
});

describe("weighTargets — fan-out cap", () => {
	const name = (i: number) => ({ moniker: `m#s${i}`, resolution: "name", confidence: 0.5 });
	const precise = (i: number) => ({ moniker: `m#s${i}`, resolution: "scoped", confidence: 1 });

	it("splits confidence for tractable name-only ambiguity (<= cap)", () => {
		const out = weighTargets(Array.from({ length: MAX_NAME_FANOUT }, (_, i) => name(i)));
		expect(out).toHaveLength(MAX_NAME_FANOUT);
		expect(out[0]?.confidence).toBeCloseTo(0.5 / MAX_NAME_FANOUT);
	});

	it("drops intractable name-only ambiguity (> cap) — pure noise, not actionable", () => {
		expect(weighTargets(Array.from({ length: MAX_NAME_FANOUT + 1 }, (_, i) => name(i)))).toEqual([]);
	});

	it("never drops precise bindings, regardless of count", () => {
		const out = weighTargets(Array.from({ length: MAX_NAME_FANOUT + 50 }, (_, i) => precise(i)));
		expect(out).toHaveLength(MAX_NAME_FANOUT + 50); // precise candidates are kept (split by fan-out)
	});
});

describe("fan-out cap — end-to-end through resolveOccurrences", () => {
	const cleanups: Array<() => void> = [];
	afterAll(() => {
		for (const c of cleanups) c();
	});

	it("drops a >cap bare-name reference edge, but keeps the definitions findable via def", async () => {
		const dir = mkdtempSync(join(tmpdir(), "codeindex-fanout-"));
		const n = MAX_NAME_FANOUT + 1; // 9 same-named defs => intractable
		for (let i = 0; i < n; i++) writeFileSync(join(dir, `d${i}.ts`), `export function widget() { return ${i}; }\n`);
		// A bare `widget()` call with no import/local: only the >cap name-only fallback can resolve it.
		writeFileSync(join(dir, "use.ts"), "export function run() { return widget(); }\n");
		const { store, indexer } = openIndex({ root: dir, dbPath: join(dir, "i.db") });
		cleanups.push(() => {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		});
		await indexer.sync();
		// The reference edge is dropped (intractably ambiguous), so no caller occurrence is stored...
		expect(store.callers("widget", 50)).toHaveLength(0);
		// ...but every definition is still indexed and findable (definitions are never capped).
		expect(store.definitions("widget", 50)).toHaveLength(n);
		// A3: the empty answer is explained as fan-out suppression, not "not found" or "unused".
		expect(store.diagnoseEmpty("widget")).toEqual({ kind: "suppressed", definitions: n, sites: 1 });
		expect(store.diagnoseEmpty("nope")).toEqual({ kind: "no-symbol" });
		// `run` is defined once and nothing targets it: genuinely edge-less, not suppressed.
		expect(store.diagnoseEmpty("run")).toEqual({ kind: "no-edges", definitions: 1 });
	});
});
