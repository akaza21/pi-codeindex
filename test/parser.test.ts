import { describe, expect, it } from "vitest";
import { TreeSitterParser } from "../src/engine/parser/tree-sitter-parser.ts";

describe("TreeSitterParser (tags.scm)", () => {
	const parser = new TreeSitterParser();

	it("extracts function definitions and call references from TypeScript", async () => {
		const source = [
			"export function add(a: number, b: number) { return a + b; }",
			"function multiply(a: number, b: number) { return a * b; }",
			"export function square(n: number) { return add(n, 0) + multiply(n, n); }",
		].join("\n");
		const parsed = await parser.parse("math.ts", source);
		expect(parsed).toBeDefined();

		const names = parsed?.symbols.map((s) => s.name).sort();
		expect(names).toEqual(["add", "multiply", "square"]);

		const add = parsed?.symbols.find((s) => s.name === "add");
		expect(add?.exported).toBe(true);
		const multiply = parsed?.symbols.find((s) => s.name === "multiply");
		expect(multiply?.exported).toBe(false);

		const calls = parsed?.references.filter((r) => r.role === "call").map((r) => r.name) ?? [];
		expect(calls).toContain("add");
		expect(calls).toContain("multiply");
	});

	it("extracts imports for TS/JS", async () => {
		const parsed = await parser.parse("app.ts", 'import { add, square } from "./math.ts";\nadd(square(1), 2);');
		expect(parsed?.imports.map((i) => `${i.kind}:${i.local}`)).toEqual(["named:add", "named:square"]);
	});

	it("does not double-emit a reference captured by more than one tags.scm pattern", async () => {
		// `new Calc()` was captured twice by the JS/TS tags, producing duplicate occurrences.
		const parsed = await parser.parse(
			"app.ts",
			'import { Calc } from "./calc";\nexport function run() { return new Calc(); }',
		);
		const calcRefs = parsed?.references.filter((r) => r.name === "Calc") ?? [];
		expect(calcRefs).toHaveLength(1);
		expect(calcRefs[0]?.role).toBe("call"); // the surviving ref is still the constructor call site
	});

	it("returns undefined for unsupported extensions", async () => {
		expect(await parser.parse("notes.txt", "hello")).toBeUndefined();
	});

	// A definition's own name token is never a call/reference to itself, whatever a grammar's
	// tags.scm captures. Guards every language against the fabricated `f -> f` self-edge (A1).
	it.each([
		["work.rb", "def work\n  1\nend\n"],
		["work.ts", "export function work() { return 1; }\n"],
		["work.py", "def work():\n    return 1\n"],
		["work.go", "package p\nfunc Work() int { return 1 }\n"],
	])("never emits a call/reference at a definition's own name range (%s)", async (path, source) => {
		const parsed = await parser.parse(path, source);
		const defNameRanges = new Set((parsed?.symbols ?? []).map((s) => s.nameRange.join(":")));
		const clashing = (parsed?.references ?? []).filter(
			(r) => (r.role === "call" || r.role === "reference") && defNameRanges.has(r.range.join(":")),
		);
		expect(clashing).toEqual([]);
	});
});
