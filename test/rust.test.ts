import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openIndex, type Store } from "../src/engine/index.ts";
import { TreeSitterParser } from "../src/engine/parser/tree-sitter-parser.ts";

// End-to-end Rust support: structs/enums/traits/functions/impl-methods, ownerType from the `impl`
// block's type, receiver method calls (`recv.method()` via field_expression), and a block scope graph.
describe("Rust support", () => {
	let dir: string;
	let store: Store;

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "codeindex-rust-"));
		writeFileSync(
			join(dir, "shapes.rs"),
			[
				"pub trait Shape {",
				"    fn area(&self) -> f64;",
				"}",
				"pub struct Circle {",
				"    radius: f64,",
				"}",
				"impl Shape for Circle {",
				"    fn area(&self) -> f64 {",
				"        let scale = 3.14;",
				"        scale * self.radius",
				"    }",
				"}",
				"pub fn make() -> Circle {",
				"    Circle { radius: 2.0 }",
				"}",
				"pub fn run() -> f64 {",
				"    let c = make();",
				"    c.area()",
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

	it("indexes an impl method exactly once, with ownerType from the impl block", () => {
		const area = store.definitions("area", 5);
		// `area` matches both tags.scm `definition.method` and `definition.function`; dedup keeps one.
		expect(area).toHaveLength(1);
		expect(area[0]?.ownerType).toBe("Circle");
	});

	it("resolves a receiver method call (c.area()) and a plain call (make())", () => {
		expect(store.callers("area", 10).some((h) => h.enclosing === "run")).toBe(true);
		expect(store.callers("make", 10).some((h) => h.enclosing === "run")).toBe(true);
	});

	it("binds tuple-destructuring and closure locals in the scope graph", async () => {
		const parsed = await new TreeSitterParser().parse(
			"x.rs",
			"fn f((x, y): (i32, i32)) { let (a, b) = (1, 2); let g = |n| n + 1; }",
		);
		const defs = parsed?.scopeDefs.map((d) => d.name) ?? [];
		expect(defs).toEqual(expect.arrayContaining(["x", "y", "a", "b", "n"]));
	});

	it("keeps the more specific kind when an impl fn is tagged as both method and function", async () => {
		const parsed = await new TreeSitterParser().parse("y.rs", "struct S; impl S { fn m(&self) {} }");
		const m = parsed?.symbols.filter((s) => s.name === "m") ?? [];
		expect(m).toHaveLength(1);
		expect(m[0]?.kind).toBe("method");
	});
});
