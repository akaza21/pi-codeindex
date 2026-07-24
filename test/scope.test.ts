import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openIndex, type Store, SyntacticResolver } from "../src/engine/index.ts";
import { buildScopeGraph } from "../src/engine/parser/scopes.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/scope-project", import.meta.url));

describe("buildScopeGraph (pure)", () => {
	it("places a symbol in the scope enclosing its own definition node", () => {
		// root [1..10]; one function scope at lines 1..5 (the symbol's own node).
		const fileRange = [1, 0, 10, 0] as const;
		const fnScope = [1, 0, 5, 1] as const;
		const symbol = {
			kind: "function",
			name: "foo",
			range: [1, 0, 5, 1] as const, // identical to fnScope → must be skipped
			nameRange: [1, 9, 1, 12] as const,
			exported: false,
		};
		const graph = buildScopeGraph(fileRange, [fnScope], [], [symbol]);
		const fooDef = graph.scopeDefs.find((d) => d.name === "foo");
		expect(fooDef?.symbolIndex).toBe(0);
		expect(fooDef?.scopeIndex).toBe(0); // root, not the function's own scope (index 1)
	});
});

describe("L2 scoped resolution disambiguates shadowed names", () => {
	let store: Store;
	let tmp: string;
	let dbPath: string;

	beforeAll(async () => {
		tmp = mkdtempSync(join(tmpdir(), "codeindex-scope-"));
		dbPath = join(tmp, "index.db");
		const opened = openIndex({ root: FIXTURE, dbPath });
		store = opened.store;
		await opened.indexer.sync();
	});

	afterAll(() => {
		store.close();
		rmSync(tmp, { recursive: true, force: true });
	});

	it("binds each call to exactly one definition at scoped/1.00", () => {
		const callers = store.callers("helper", 20);
		expect(callers).toHaveLength(2); // outer's call + other's call, no ambiguous duplicates
		for (const hit of callers) {
			expect(hit.provenance).toBe("scoped");
			expect(hit.confidence).toBe(1);
		}
		expect(new Set(callers.map((h) => h.enclosing))).toEqual(new Set(["outer", "other"]));
	});

	it("L1 alone is ambiguous on the same fixture (proves L2's added precision)", async () => {
		const l1Tmp = mkdtempSync(join(tmpdir(), "codeindex-l1-"));
		const opened = openIndex({
			root: FIXTURE,
			dbPath: join(l1Tmp, "index.db"),
			providers: [new SyntacticResolver()],
		});
		await opened.indexer.sync();
		const l1Callers = opened.store.callers("helper", 20);
		// Two call sites × two same-name candidates each = 4 ambiguous edges.
		expect(l1Callers.length).toBeGreaterThan(2);
		expect(l1Callers.every((h) => h.provenance === "syntactic")).toBe(true);
		opened.store.close();
		rmSync(l1Tmp, { recursive: true, force: true });
	});

	it("does not disturb cross-file import resolution (still L1)", () => {
		// `other` and `outer` are exported; a scoped binding must not break export facts.
		expect(store.definitions("outer", 5).some((d) => d.exported)).toBe(true);
	});
});
