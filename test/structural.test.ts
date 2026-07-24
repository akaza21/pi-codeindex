import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NodeFileSystem, openIndex, type Store, structuralSearch, TreeSitterParser } from "../src/engine/index.ts";

const FUNCTIONS = "(function_declaration name: (identifier) @name)";

describe("structural search", () => {
	let dir: string;
	let store: Store;
	const fs = new NodeFileSystem();
	const parser = new TreeSitterParser();
	const deps = () => ({ store, fs, parser, root: dir });

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "codeindex-struct-"));
		writeFileSync(
			join(dir, "a.ts"),
			"export function alpha() { try { run(); } catch (e) {} }\nexport function beta() { return 2; }\n",
		);
		writeFileSync(
			join(dir, "b.ts"),
			"export class Widget extends Base {}\nexport function gamma() { fetch('/x'); other(); }\n",
		);
		// A multi-line method (no top-level function_declaration), for the span test.
		writeFileSync(join(dir, "c.ts"), "export class Multi {\n\thandle() {\n\t	return 1;\n\t}\n}\n");
		const opened = openIndex({ root: dir, dbPath: join(dir, "i.db") });
		store = opened.store;
		await opened.indexer.sync();
	});

	afterAll(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("finds nodes by shape and returns captures with text", async () => {
		const hits = await structuralSearch(deps(), { lang: "typescript", pattern: FUNCTIONS });
		expect(hits.map((h) => h.captures[0]?.text)).toEqual(["alpha", "beta", "gamma"]);
		// Deterministic: candidates are path-sorted, matches in tree order.
		expect(hits.map((h) => h.file)).toEqual(["a.ts", "a.ts", "b.ts"]);
	});

	it("spans a multi-line capture from its start line to its end line", async () => {
		const hits = await structuralSearch(deps(), { lang: "typescript", pattern: "(method_definition) @m" });
		expect(hits).toHaveLength(1);
		const range = hits[0]?.range;
		expect(range?.[0]).toBe(2);
		expect((range?.[2] ?? 0) > (range?.[0] ?? 0)).toBe(true);
	});

	it("supports anchors (empty catch block)", async () => {
		const hits = await structuralSearch(deps(), {
			lang: "typescript",
			pattern: '(catch_clause body: (statement_block . "}")) @c',
		});
		expect(hits).toHaveLength(1);
		expect(hits[0]?.file).toBe("a.ts");
	});

	it("supports predicates (#eq? filters by text)", async () => {
		const hits = await structuralSearch(deps(), {
			lang: "typescript",
			pattern: '((call_expression function: (identifier) @fn) (#eq? @fn "fetch"))',
		});
		expect(hits.map((h) => h.captures[0]?.text)).toEqual(["fetch"]); // not run/other
	});

	it("scopes by path substring", async () => {
		const hits = await structuralSearch(deps(), { lang: "typescript", pattern: FUNCTIONS, path: "b.ts" });
		expect(hits.map((h) => h.captures[0]?.text)).toEqual(["gamma"]);
	});

	it("caps hits to exactly `limit`, in order, across files", async () => {
		const hits = await structuralSearch(deps(), { lang: "typescript", pattern: FUNCTIONS, limit: 2 });
		expect(hits.map((h) => h.captures[0]?.text)).toEqual(["alpha", "beta"]);
	});

	it("returns nothing (but still compiles) for an empty scope", async () => {
		expect(await structuralSearch(deps(), { lang: "typescript", pattern: FUNCTIONS, path: "no-such-file" })).toEqual(
			[],
		);
	});

	it("returns nothing for limit 0", async () => {
		expect(await structuralSearch(deps(), { lang: "typescript", pattern: FUNCTIONS, limit: 0 })).toEqual([]);
	});

	it("still fails loudly on a malformed query when the scope is empty", async () => {
		await expect(
			structuralSearch(deps(), { lang: "typescript", pattern: "(function_declaration", path: "no-such-file" }),
		).rejects.toThrow(/invalid query/);
	});

	it("rejects a captureless query even when the scope is empty", async () => {
		await expect(
			structuralSearch(deps(), { lang: "typescript", pattern: "(function_declaration)", path: "no-such-file" }),
		).rejects.toThrow(/capture at least one/);
	});

	it("refuses an over-broad scope instead of scanning unbounded files", async () => {
		await expect(structuralSearch(deps(), { lang: "typescript", pattern: FUNCTIONS, maxFiles: 1 })).rejects.toThrow(
			/scope too broad/,
		);
	});

	it("honors caller cancellation", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			structuralSearch(deps(), { lang: "typescript", pattern: FUNCTIONS, signal: controller.signal }),
		).rejects.toMatchObject({ name: "AbortError" });
	});

	it("fails loudly on a malformed query", async () => {
		await expect(structuralSearch(deps(), { lang: "typescript", pattern: "(function_declaration" })).rejects.toThrow(
			/invalid query/,
		);
	});

	it("rejects a query that captures nothing", async () => {
		await expect(structuralSearch(deps(), { lang: "typescript", pattern: "(function_declaration)" })).rejects.toThrow(
			/capture at least one/,
		);
	});
});
