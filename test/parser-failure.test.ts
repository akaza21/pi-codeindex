import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openIndex, type Parser, TreeSitterParser } from "../src/engine/index.ts";

describe("parser failure recovery", () => {
	it("drops stale facts when a previously available grammar cannot parse", async () => {
		const root = mkdtempSync(join(tmpdir(), "codeindex-parser-failure-"));
		const real = new TreeSitterParser();
		let unavailable = false;
		const parser: Parser = {
			languageForFile: (path) => real.languageForFile(path),
			supportedExtensions: () => real.supportedExtensions(),
			parse: (path, source) => (unavailable ? Promise.resolve(undefined) : real.parse(path, source)),
			structuralQuery: (lang, pattern) => real.structuralQuery(lang, pattern),
		};
		writeFileSync(join(root, "main.ts"), "export function oldFact() { return 1; }\n");
		const opened = openIndex({ root, dbPath: join(root, ".idx.db"), parser });
		try {
			await opened.indexer.sync();
			expect(opened.store.definitions("oldFact", 5)).toHaveLength(1);
			unavailable = true;
			writeFileSync(join(root, "main.ts"), "export function changedFact() { return 2; }\n");
			await opened.indexer.sync({ only: ["main.ts"] });
			expect(opened.store.definitions("oldFact", 5)).toHaveLength(0);
			expect(opened.store.status().files).toBe(0);
		} finally {
			opened.store.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
