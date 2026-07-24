import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type OccurrenceHit, openIndex, type Store } from "../src/engine/index.ts";
import { type Hierarchy, supertypeChain } from "../src/engine/resolve/hierarchy.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/hierarchy", import.meta.url));
let store: Store;
let tmp: string;

beforeAll(async () => {
	tmp = mkdtempSync(join(tmpdir(), "codeindex-hier-"));
	const opened = openIndex({ root: FIXTURE, dbPath: join(tmp, "index.db") });
	store = opened.store;
	await opened.indexer.sync();
});
afterAll(() => {
	store.close();
	rmSync(tmp, { recursive: true, force: true });
});

const caller = (name: string, enclosing: string): OccurrenceHit | undefined =>
	store.callers(name, 20).find((h) => h.enclosing === enclosing);

describe("inheritance-aware member binding", () => {
	it("binds a `this.method()` call to a member inherited from a cross-file base", () => {
		// `greet` exists only on Base; the single caller is the inherited resolution, not a
		// blind same-name guess (which would be capped at 0.5) and not "certain".
		const hits = store.callers("greet", 20);
		expect(hits.map((h) => h.enclosing)).toEqual(["run"]);
		expect(hits[0]?.confidence).toBeGreaterThanOrEqual(0.8);
		expect(hits[0]?.confidence).toBeLessThan(1); // a structural inference, never "certain"
	});

	it("leaves an own-class member to precise same-file/scope binding (no inherited fallback)", () => {
		const hit = caller("own", "useOwn");
		expect(hit?.confidence).toBe(1); // precise, not the distance-decayed inherited score
		expect(hit?.file).toContain("sub.ts");
	});

	it("decays confidence with inheritance distance (depth-2 chain)", () => {
		const near = caller("greet", "run"); // distance 1
		const far = caller("deep", "go"); // distance 2 (Leaf -> MidBase -> GrandBase)
		expect(far).toBeDefined();
		expect(far?.confidence).toBeLessThan(near?.confidence ?? 1);
		expect(far?.confidence).toBeGreaterThanOrEqual(0.5);
	});

	it("keeps a diamond ambiguous: equal-distance hits share (low) confidence, never a silent pick", () => {
		const hits = store.callers("paint", 20).filter((h) => h.enclosing === "render");
		expect(hits.length).toBe(2); // DA.paint and DB.paint
		for (const h of hits) expect(h.confidence).toBeLessThan(0.5); // split → visibly uncertain
	});

	it("never fabricates a confident binding when the receiver type has no known supertypes", () => {
		// `this.ghost()` in Orphan (no base): falls back to the name guess, capped low.
		const hit = caller("ghost", "go");
		expect(hit?.confidence ?? 0).toBeLessThanOrEqual(0.5);
	});

	it("does not bind an instance `this` call to an inherited static member", () => {
		// `Base.ping` is static; `this.ping()` must not resolve to it at high confidence.
		const hit = caller("ping", "pingCaller");
		expect(hit?.confidence ?? 0).toBeLessThanOrEqual(0.5);
	});

	it("caps a declaration-only (interface) member at the name-guess ceiling", () => {
		// `Solo.only` is just a signature; binding to it is a contract pointer, not certain.
		const hit = caller("only", "use");
		expect(hit?.confidence ?? 0).toBeLessThanOrEqual(0.5);
	});

	it("supertypeChain is cycle-safe", () => {
		const cyclic: Hierarchy = new Map([
			["A", ["B"]],
			["B", ["A"]],
		]);
		const chain = supertypeChain(cyclic, "A").map((c) => c.moniker);
		expect(chain).toEqual(["A", "B"]); // terminates, each node once
	});
});
