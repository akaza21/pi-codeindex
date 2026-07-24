import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openIndex, type Store } from "../src/engine/index.ts";

// End-to-end C++ support: classes/methods (in-class + pure-virtual), ownerType from the enclosing
// class, receiver method calls (`c.m()` and `s->m()`), bare calls, and base-class inheritance.
describe("C++ support", () => {
	let dir: string;
	let store: Store;

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "codeindex-cpp-"));
		writeFileSync(
			join(dir, "shapes.cpp"),
			[
				"namespace geo {",
				"class Shape { public: virtual double area() = 0; };",
				"class Circle : public Shape {",
				"  double r;",
				"public:",
				"  Circle(double radius) : r(radius) {}",
				"  double area() override { double scale = 3.14; return scale * r; }",
				"};",
				"double run() { Circle c(2.0); Shape* s = &c; return c.area() + s->area() + helper(1); }",
				"double helper(int x) { return x; }",
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

	it("attaches ownerType to a method declared in two classes", () => {
		// `area` is declared in both classes; each carries its owner.
		const owners = store.definitions("area", 5).map((s) => s.ownerType);
		expect(owners).toContain("Shape");
		expect(owners).toContain("Circle");
	});

	it("resolves receiver method calls (c.area(), s->area()) and a bare call", () => {
		expect(store.callers("area", 10).some((h) => h.enclosing === "run")).toBe(true);
		expect(store.callers("helper", 10).some((h) => h.enclosing === "run")).toBe(true);
	});

	it("captures the base class as a supertype (Circle : public Shape)", () => {
		expect(store.supertypes("Circle", 5).map((h) => h.name)).toContain("Shape");
	});

	it("indexes out-of-class and namespaced member definitions with ownerType from the qualifier", async () => {
		const { TreeSitterParser } = await import("../src/engine/parser/tree-sitter-parser.ts");
		const parsed = await new TreeSitterParser().parse(
			"q.cpp",
			"namespace N { class C { int m(); }; }\nint C::one() { return 1; }\nint N::C::m() { return 2; }\nint f() { return N::C::m(); }",
		);
		const members = (parsed?.symbols ?? []).filter((s) => s.kind === "method");
		// `C::one` -> owner C; `N::C::m` -> owner C (innermost qualifier).
		expect(members.find((s) => s.name === "one")?.ownerType).toBe("C");
		expect(members.find((s) => s.name === "m")?.ownerType).toBe("C");
		// The namespaced call N::C::m() is captured, carrying the qualifier as a receiver.
		const call = (parsed?.references ?? []).find((r) => r.role === "call" && r.name === "m");
		expect(call?.receiver).toBe("C");
	});

	it("does NOT confidently bind a qualified call to every same-named member", async () => {
		const probe = mkdtempSync(join(tmpdir(), "codeindex-cpp2-"));
		writeFileSync(
			join(probe, "x.cpp"),
			[
				"namespace N { struct C { int m(); }; }",
				"namespace A { struct C { int m(); }; }",
				"int N::C::m() { return 1; }",
				"int A::C::m() { return 2; }",
				"int caller() { return N::C::m(); }",
			].join("\n"),
		);
		const opened = openIndex({ root: probe, dbPath: join(probe, "i.db") });
		await opened.indexer.sync();
		// The qualifier can't be resolved without type info, so the call stays a low-confidence guess
		// across the same-named members — never a confident (scoped 1.0) edge to all of them.
		expect(opened.store.callers("m", 10).every((h) => h.confidence <= 0.5)).toBe(true);
		opened.store.close();
		rmSync(probe, { recursive: true, force: true });
	});
});
