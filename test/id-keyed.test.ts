import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openIndex, type Store } from "../src/engine/index.ts";

// Two functions named `helper`, each imported + called from its own file — so each call site
// binds precisely to one of them, letting us prove by-moniker disambiguation cleanly.
describe("id-keyed (by-moniker) queries", () => {
	let dir: string;
	let store: Store;

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "codeindex-idkey-"));
		writeFileSync(join(dir, "a.ts"), "export function helper() { return 1; }\n");
		writeFileSync(join(dir, "b.ts"), "export function helper() { return 2; }\n");
		writeFileSync(
			join(dir, "usesA.ts"),
			'import { helper } from "./a";\nexport function ra() { return helper(); }\n',
		);
		writeFileSync(
			join(dir, "usesB.ts"),
			'import { helper } from "./b";\nexport function rb() { return helper(); }\n',
		);
		const opened = openIndex({ root: dir, dbPath: join(dir, "i.db") });
		store = opened.store;
		await opened.indexer.sync();
	});

	afterAll(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("exposes a distinct, stable moniker on each definition", () => {
		const defs = store.definitions("helper", 10);
		expect(defs).toHaveLength(2);
		const monikers = defs.map((d) => d.moniker);
		expect(monikers.every((m) => typeof m === "string" && m.length > 0)).toBe(true);
		expect(new Set(monikers).size).toBe(2); // the two `helper`s are distinguishable by id
	});

	it("callersByMoniker targets one declaration; callers(name) spans both", () => {
		const defs = store.definitions("helper", 10);
		const inA = defs.find((d) => d.file === "a.ts")?.moniker as string;
		const inB = defs.find((d) => d.file === "b.ts")?.moniker as string;

		expect(store.callers("helper", 20)).toHaveLength(2); // by name: both helpers' call sites
		const callersA = store.callersByMoniker(inA, 20);
		const callersB = store.callersByMoniker(inB, 20);
		expect(callersA.map((h) => h.file)).toEqual(["usesA.ts"]);
		expect(callersB.map((h) => h.file)).toEqual(["usesB.ts"]);
	});

	it("references/impact by moniker also target the one declaration; a bogus id yields nothing", () => {
		const inA = store.definitions("helper", 10).find((d) => d.file === "a.ts")?.moniker as string;
		expect(store.referencesByMoniker(inA, 20).map((h) => h.file)).toEqual(["usesA.ts"]);
		expect(store.impactByMoniker(inA, 2, 20).every((h) => h.depth !== undefined)).toBe(true);
		expect(store.callersByMoniker("no.such#moniker@9:9", 20)).toEqual([]);
	});

	it("calleesByMoniker lists what one specific symbol calls", () => {
		// `ra` (in usesA.ts) calls `helper`; calleesByMoniker(ra) should surface that outgoing call.
		const ra = store.definitions("ra", 5).find((d) => d.file === "usesA.ts")?.moniker as string;
		expect(store.calleesByMoniker(ra, 20).map((h) => h.name)).toEqual(["helper"]);
	});

	it("search results also carry a moniker for disambiguation", () => {
		const hits = store.search("helper", 10);
		expect(hits.length).toBeGreaterThan(0);
		expect(hits.every((h) => typeof h.moniker === "string" && h.moniker.length > 0)).toBe(true);
	});
});
