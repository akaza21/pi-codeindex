import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openIndex, type Store } from "../src/engine/index.ts";

// End-to-end Scala support: classes/objects/traits/defs, ownerType from the enclosing template,
// member references (`c.area` — uniform access), bare calls, and extends/with inheritance.
describe("Scala support", () => {
	let dir: string;
	let store: Store;

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "codeindex-scala-"));
		writeFileSync(
			join(dir, "shapes.scala"),
			[
				"package geo",
				"trait Shape { def area: Double }",
				"class Base",
				"class Circle(r: Double) extends Base with Shape {",
				"  def area: Double = { val pi = 3.14; pi * r }",
				"}",
				"object Main {",
				"  def run(): Double = { val c = new Circle(2.0); c.area + helper(1) }",
				"  def helper(x: Int): Int = x",
				"}",
				"",
			].join("\n"),
		);
		const opened = openIndex({ root: dir, dbPath: join(dir, "i.db") });
		store = opened.store;
		await opened.indexer.sync();
	});

	afterAll(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("attaches def ownerType (area is owned by Circle)", () => {
		expect(store.definitions("area", 5).some((s) => s.ownerType === "Circle")).toBe(true);
	});

	it("resolves a bare call (helper()); member references are intentionally not tagged", () => {
		expect(store.callers("helper", 10).some((h) => h.enclosing === "run")).toBe(true);
		// `c.area` is a member selection, syntactically identical to a package/type path in Scala, so it
		// is deliberately not recorded as a call edge (avoids binding path segments to same-named defs).
	});

	it("captures extends and with-mixin supertypes", () => {
		const supers = store.supertypes("Circle", 5).map((h) => h.name);
		expect(supers).toContain("Base");
		expect(supers).toContain("Shape");
	});

	it("does NOT create call edges for package/type path segments (D2 safety)", async () => {
		const probe = mkdtempSync(join(tmpdir(), "codeindex-scala2-"));
		writeFileSync(
			join(probe, "p.scala"),
			["package a", "object b { class C { def m: Int = 1 } }", "object T { val x = a.b.C.m }", ""].join("\n"),
		);
		const opened = openIndex({ root: probe, dbPath: join(probe, "i.db") });
		await opened.indexer.sync();
		// `a.b.C` is a package/type path, not member calls; segments must not become caller edges.
		expect(opened.store.callers("b", 10)).toHaveLength(0);
		expect(opened.store.callers("C", 10)).toHaveLength(0);
		opened.store.close();
		rmSync(probe, { recursive: true, force: true });
	});
});
