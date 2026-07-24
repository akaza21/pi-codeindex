import { describe, expect, it } from "vitest";
import { TreeSitterParser } from "../src/engine/parser/tree-sitter-parser.ts";
import type { ParsedImport } from "../src/engine/ports.ts";

const parser = new TreeSitterParser();

async function imports(path: string, source: string): Promise<ParsedImport[]> {
	return (await parser.parse(path, source))?.imports ?? [];
}

describe("Go import kinds", () => {
	it("maps blank `_` to side-effect, dot `.` to wildcard, alias to namespace", async () => {
		const result = await imports(
			"main.go",
			'package main\nimport (\n\t_ "a/blank"\n\t. "a/dot"\n\tm "a/named"\n\t"a/plain"\n)\n',
		);
		expect(result.find((i) => i.source === "a/blank")).toMatchObject({ kind: "side-effect" });
		expect(result.find((i) => i.source === "a/dot")).toMatchObject({ kind: "wildcard" });
		expect(result.find((i) => i.source === "a/named")).toMatchObject({ kind: "namespace", local: "m" });
		expect(result.find((i) => i.source === "a/plain")).toMatchObject({ kind: "namespace", local: "plain" });
	});
});

describe("Java normal vs static imports", () => {
	it("distinguishes class import, static member import, and static wildcard", async () => {
		const result = await imports(
			"X.java",
			"import a.b.C;\nimport static a.b.C.m;\nimport a.b.*;\nimport static a.b.D.*;\n",
		);
		// normal class import: package source, class as imported/local, not static
		expect(result.find((i) => i.local === "C")).toMatchObject({ kind: "named", source: "a.b", imported: "C" });
		expect(result.find((i) => i.local === "C")?.isStatic).toBeFalsy();
		// static member import: class FQN as source, member local, static
		expect(result.find((i) => i.local === "m")).toMatchObject({ kind: "named", source: "a.b.C", isStatic: true });
		// package wildcard (not static) vs static wildcard (static)
		const wildcards = result.filter((i) => i.kind === "wildcard");
		expect(wildcards.find((i) => i.source === "a.b")?.isStatic).toBeFalsy();
		expect(wildcards.find((i) => i.source === "a.b.D")?.isStatic).toBe(true);
	});
});
