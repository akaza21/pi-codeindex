import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openIndex, type Store } from "../src/engine/index.ts";
import { TreeSitterParser } from "../src/engine/parser/tree-sitter-parser.ts";

// End-to-end C# support: classes/interfaces/methods/properties, ownerType from the enclosing
// class, receiver method calls (`recv.Method()`), bare calls, and base-list inheritance.
describe("C# support", () => {
	let dir: string;
	let store: Store;

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "codeindex-csharp-"));
		writeFileSync(
			join(dir, "shapes.cs"),
			[
				"namespace Geo;",
				"public interface IShape { double Area(); }",
				"public class Circle : IShape {",
				"    public double Radius { get; set; }",
				"    public double Area() {",
				"        var scale = 3.14;",
				"        return scale * Radius;",
				"    }",
				"}",
				"public class Program {",
				"    public static void Main() {",
				"        var c = new Circle();",
				"        double a = c.Area();",
				"        Helper();",
				"    }",
				"    static void Helper() {}",
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

	it("indexes properties added by the vendored tags query", () => {
		expect(store.definitions("Radius", 5)[0]?.kind).toBe("property");
	});

	it("attaches ownerType to class members", () => {
		expect(store.definitions("Radius", 5)[0]?.ownerType).toBe("Circle");
		expect(store.definitions("Area", 5).some((s) => s.ownerType === "Circle")).toBe(true);
	});

	it("resolves a receiver method call (c.Area()) and a bare call (Helper())", () => {
		expect(store.callers("Area", 10).some((h) => h.enclosing === "Main")).toBe(true);
		expect(store.callers("Helper", 10).some((h) => h.enclosing === "Main")).toBe(true);
	});

	it("captures the base-list supertype (Circle : IShape)", () => {
		expect(store.supertypes("Circle", 5).map((h) => h.name)).toContain("IShape");
	});

	it("captures qualified and generic base types (Ns.Base<int>, IFoo.Bar)", async () => {
		const parsed = await new TreeSitterParser().parse("a.cs", "class A : Ns.Base<int>, IFoo.Bar {}");
		const supertypes = parsed?.references.filter((r) => r.role === "extends").map((r) => r.name) ?? [];
		expect(supertypes).toEqual(expect.arrayContaining(["Base", "Bar"]));
	});

	it("records call arity for both member and bare calls", async () => {
		const parsed = await new TreeSitterParser().parse("b.cs", "class C { void M() { o.F(1, 2); G(1, 2, 3); } }");
		const calls = parsed?.references.filter((r) => r.role === "call") ?? [];
		expect(calls.find((c) => c.name === "F")?.argCount).toBe(2);
		expect(calls.find((c) => c.name === "G")?.argCount).toBe(3);
	});

	it("carries the namespace qualifier as the supertype receiver (Ns.Base)", async () => {
		const parsed = await new TreeSitterParser().parse("c.cs", "class A : Ns.Base<int> {}");
		const base = parsed?.references.find((r) => r.role === "extends" && r.name === "Base");
		expect(base?.receiver).toBe("Ns");
	});

	it("binds foreach loop and catch variables in the scope graph", async () => {
		const parsed = await new TreeSitterParser().parse(
			"d.cs",
			"class C { void M() { foreach (var x in xs) {} try {} catch (System.Exception ex) {} } }",
		);
		const defs = parsed?.scopeDefs.map((d) => d.name) ?? [];
		expect(defs).toEqual(expect.arrayContaining(["x", "ex"]));
	});
});
