import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openIndex, type Store } from "../src/engine/index.ts";

// End-to-end C support: structs, functions, calls (with the body-inclusive function span so a call
// is enclosed by the function it sits in), and a block scope graph.
describe("C support", () => {
	let dir: string;
	let store: Store;

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "codeindex-c-"));
		writeFileSync(
			join(dir, "calc.c"),
			[
				"struct Point { int x; int y; };",
				"int add(int a, int b) { int sum = a + b; return sum; }",
				"int run(void) { int r = add(1, 2); return r; }",
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

	it("resolves a call to its enclosing function (body-inclusive span)", () => {
		expect(store.callers("add", 10).some((h) => h.enclosing === "run")).toBe(true);
	});

	it("binds params and locals in the scope graph", async () => {
		const { TreeSitterParser } = await import("../src/engine/parser/tree-sitter-parser.ts");
		const parsed = await new TreeSitterParser().parse("x.c", "int f(int a) { int b = a; return b; }");
		const defs = parsed?.scopeDefs.map((d) => d.name) ?? [];
		expect(defs).toEqual(expect.arrayContaining(["a", "b"]));
	});
});
