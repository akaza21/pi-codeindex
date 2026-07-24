import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type OccurrenceHit, openIndex, type Store } from "../src/engine/index.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/relations", import.meta.url));

let store: Store;
let tmp: string;

beforeAll(async () => {
	tmp = mkdtempSync(join(tmpdir(), "codeindex-rel-"));
	const opened = openIndex({ root: FIXTURE, dbPath: join(tmp, "index.db") });
	store = opened.store;
	await opened.indexer.sync();
});
afterAll(() => {
	store.close();
	rmSync(tmp, { recursive: true, force: true });
});

/** Render a hit as "subtype role base" for order-independent assertions. */
const edge = (h: OccurrenceHit) => `${h.enclosing} ${h.role} ${h.name}`;

describe("inheritance relationships", () => {
	it("resolves a cross-file `extends` via import (L1 import provenance)", () => {
		const impl = store.implementers("Base", 10);
		expect(impl.map(edge)).toContain("Derived extends Base");
		// imported base → syntactic import binding, not a same-file scope hit
		expect(impl.find((h) => h.enclosing === "Derived")?.confidence).toBeGreaterThanOrEqual(0.8);
	});

	it("resolves cross-file `implements`", () => {
		expect(store.implementers("Greeter", 10).map(edge)).toContain("Derived implements Greeter");
	});

	it("lists a type's supertypes (outgoing), both extends and implements", () => {
		expect(store.supertypes("Derived", 10).map(edge).sort()).toEqual([
			"Derived extends Base",
			"Derived implements Greeter",
		]);
	});

	it("handles Python multiple bases", () => {
		expect(store.supertypes("Dog", 10).map(edge).sort()).toEqual(["Dog extends Animal", "Dog extends Walks"]);
	});

	it("handles Java extends + implements", () => {
		expect(store.supertypes("Cat", 10).map(edge).sort()).toEqual(["Cat extends Base2", "Cat implements Pet"]);
		expect(store.implementers("Pet", 10).map(edge)).toContain("Cat implements Pet");
	});

	it("handles Ruby superclass", () => {
		expect(store.implementers("Vehicle", 10).map(edge)).toContain("Car extends Vehicle");
	});

	it("aggregates implementers by name across files (recall-first)", () => {
		// Both the Python Dog and any other Animal subtype surface together.
		expect(store.implementers("Animal", 10).map(edge)).toContain("Dog extends Animal");
	});

	it("does not pollute the call graph with inheritance edges", () => {
		// `extends`/`implements` are not calls; callers/callees must exclude them.
		expect(store.callers("Base", 10).every((h) => h.role === "call" || h.role === "reference")).toBe(true);
	});

	it("does not double-count a heritage name also captured by tags (Java/Ruby)", () => {
		// Base2/Pet/Vehicle heritage sites must appear once, with the inheritance role only.
		expect(store.references("Base2", 10).map((h) => h.role)).toEqual(["extends"]);
		expect(store.references("Pet", 10).map((h) => h.role)).toEqual(["implements"]);
		expect(store.callers("Base2", 10)).toHaveLength(0);
		expect(store.callers("Pet", 10)).toHaveLength(0);
		expect(
			store
				.references("Vehicle", 10)
				.filter((h) => h.range[0] === 3)
				.map((h) => h.role),
		).toEqual(["extends"]);
	});

	it("binds a generic base on the constructor name (`extends Box<T>`)", () => {
		const impl = store.implementers("Box", 10).map(edge);
		expect(impl).toContain("StringBox extends Box");
		expect(impl).toContain("Inner extends Box"); // nested class inside a function
	});

	it("handles an interface extending multiple interfaces", () => {
		expect(store.supertypes("IC", 10).map(edge).sort()).toEqual(["IC extends IA", "IC extends IB"]);
	});

	it("reports no supertypes for a class with no heritage", () => {
		expect(store.supertypes("Plain", 10)).toHaveLength(0);
	});

	it("resolves a qualified base (`extends NS.NsBase`)", () => {
		expect(store.implementers("NsBase", 10).map(edge)).toContain("Q extends NsBase");
	});

	it("resolves a multi-segment qualified base (`extends Out.In.Deep`)", () => {
		expect(store.implementers("Deep", 10).map(edge)).toContain("DeepSub extends Deep");
	});

	it("never invents an inheritance edge from a computed/mixin superclass", () => {
		// `class Mixed extends wrap(Box) {}` must NOT record `wrap` (or `Box`) as a supertype.
		expect(store.supertypes("Mixed", 10)).toHaveLength(0);
		// the mixin call itself stays a normal call edge (not dropped by relation de-dup).
		expect(store.callers("wrap", 10).some((h) => h.enclosing === "Mixed")).toBe(true);
	});
});
