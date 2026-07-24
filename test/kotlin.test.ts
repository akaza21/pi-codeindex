import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openIndex, type Store } from "../src/engine/index.ts";

// End-to-end Kotlin support: parse + symbols + references + ownerType + inheritance + scope,
// via the @tree-sitter-grammars/tree-sitter-kotlin grammar and our vendored tags/locals queries.
describe("Kotlin support", () => {
	let dir: string;
	let store: Store;

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "codeindex-kotlin-"));
		writeFileSync(
			join(dir, "greet.kt"),
			[
				"package com.example",
				"interface Greeter { fun greet(name: String): String }",
				"class PoliteGreeter(val prefix: String) : Greeter {",
				"    override fun greet(name: String): String {",
				"        val msg = prefix + name",
				"        return msg",
				"    }",
				"}",
				"object Util { fun shout(s: String): String = s.uppercase() }",
				"fun run() {",
				'    val g: Greeter = PoliteGreeter("Hi ")',
				'    g.greet("world")',
				'    Util.shout("x")',
				"}",
				"",
			].join("\n"),
		);
		writeFileSync(
			join(dir, "shapes.kt"),
			[
				"package com.example",
				"open class Base {",
				"    fun b() {}",
				"}",
				"interface Iface {",
				"    fun i()",
				"}",
				// `Base()` invokes the superclass constructor; `Iface` is a bare supertype. `x` is a
				// plain ctor param (a local), `count` is a `val` property.
				"class Derived(x: Int, val count: Int) : Base(), Iface {",
				"    override fun i() {}",
				"    fun run(h: Holder) {",
				"        this.helper()",
				"        h.inner.helper()",
				"    }",
				"    fun helper() {}",
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

	it("indexes classes, objects, functions and constructor properties (not local vals)", () => {
		const names = store.search("greet", 20).map((h) => h.name);
		expect(store.definitions("PoliteGreeter", 5)).toHaveLength(1);
		expect(store.definitions("Util", 5)[0]?.kind).toBe("object");
		expect(names).toContain("greet");
		// `msg` is a local val inside greet() — it must NOT be a top-level symbol.
		expect(store.definitions("msg", 5)).toHaveLength(0);
		// `prefix` is a constructor `val` property — it IS a symbol.
		expect(store.definitions("prefix", 5).length).toBeGreaterThan(0);
	});

	it("attaches ownerType to class and object members", () => {
		const greet = store.definitions("greet", 5).find((s) => s.ownerType === "PoliteGreeter");
		expect(greet).toBeTruthy();
		expect(store.definitions("shout", 5)[0]?.ownerType).toBe("Util");
	});

	it("resolves a receiver method call (g.greet) to the method", () => {
		const callers = store.callers("greet", 10);
		expect(callers.some((h) => h.enclosing === "run")).toBe(true);
	});

	it("captures the supertype (PoliteGreeter : Greeter) for hierarchy queries", () => {
		const supers = store.supertypes("PoliteGreeter", 5).map((h) => h.name);
		expect(supers).toContain("Greeter");
	});

	it("captures BOTH a constructor-invoked superclass `Base()` and a bare interface supertype", () => {
		const supers = store.supertypes("Derived", 5).map((h) => h.name);
		expect(supers).toContain("Base"); // `: Base()` — constructor_invocation must be unwrapped
		expect(supers).toContain("Iface");
	});

	it("indexes only `val`/`var` constructor params as properties, not plain params", () => {
		expect(store.definitions("count", 5).length).toBeGreaterThan(0); // `val count` is a property
		expect(store.definitions("x", 5)).toHaveLength(0); // plain `x` is a local, not a symbol
	});

	it("captures non-identifier receiver calls: `this.helper()` and chained `h.inner.helper()`", () => {
		// `this` is a `this_expression` and `h.inner` is a nested navigation_expression — neither is a
		// plain identifier, so both only bind when the receiver pattern accepts any expression. Both
		// calls target the in-file `helper`, so two call sites enclosed by `run` must be found.
		const inRun = store.callers("helper", 10).filter((h) => h.enclosing === "run");
		expect(inRun.length).toBeGreaterThanOrEqual(2);
	});
});
