import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ImportCycle, importCycles, openIndex, type Store } from "../src/engine/index.ts";

describe("import cycles", () => {
	let dir: string;
	let store: Store;
	const cyclesOf = (): ImportCycle[] => importCycles(store.importSnapshot(), store.allFiles());

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "codeindex-cycles-"));
		const ts = (name: string, importsFrom: string, sym: string) =>
			writeFileSync(join(dir, name), `import { x } from "${importsFrom}"; export const ${sym} = 1; void x;\n`);
		// a ↔ b (2-cycle); c → d → e → c (3-cycle)
		ts("a.ts", "./b", "a");
		ts("b.ts", "./a", "b");
		ts("c.ts", "./d", "c");
		ts("d.ts", "./e", "d");
		ts("e.ts", "./c", "e");
		// acyclic importers into the cycles — must NOT be reported
		ts("lone.ts", "./a", "lone");
		ts("solo.ts", "./lone", "solo");
		// a file importing itself — a degenerate 1-file cycle
		ts("self.ts", "./self", "self");
		// a Python import cycle — out of scope (TS/JS only), must NOT be reported
		writeFileSync(join(dir, "pa.py"), "from pb import y\nx = 1\n");
		writeFileSync(join(dir, "pb.py"), "from pa import x\ny = 1\n");

		const opened = openIndex({ root: dir, dbPath: join(dir, "i.db") });
		store = opened.store;
		await opened.indexer.sync();
	});

	afterAll(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("reports strongly-connected import groups, largest first, files sorted", () => {
		const cycles = cyclesOf();
		expect(cycles.map((c) => c.files)).toEqual([["c.ts", "d.ts", "e.ts"], ["a.ts", "b.ts"], ["self.ts"]]);
	});

	it("excludes files that import into a cycle but are not part of one", () => {
		const inCycle = new Set(cyclesOf().flatMap((c) => c.files));
		expect(inCycle.has("lone.ts")).toBe(false);
		expect(inCycle.has("solo.ts")).toBe(false);
	});

	it("is scoped to TS/JS — does not report a Python import cycle", () => {
		const inCycle = new Set(cyclesOf().flatMap((c) => c.files));
		expect(inCycle.has("pa.py")).toBe(false);
		expect(inCycle.has("pb.py")).toBe(false);
	});

	// Pins that the (extracted) module resolver still applies tsconfig path aliases,
	// so a cycle formed through `@app/*` imports is detected the same as relative ones.
	it("detects a cycle formed through tsconfig path aliases", async () => {
		const aliasDir = mkdtempSync(join(tmpdir(), "codeindex-cycles-alias-"));
		writeFileSync(
			join(aliasDir, "tsconfig.json"),
			'{ "compilerOptions": { "baseUrl": ".", "paths": { "@app/*": ["src/*"] } } }\n',
		);
		mkdirSync(join(aliasDir, "src"));
		writeFileSync(join(aliasDir, "src/x.ts"), 'import { y } from "@app/y"; export const x = 1; void y;\n');
		writeFileSync(join(aliasDir, "src/y.ts"), 'import { x } from "@app/x"; export const y = 1; void x;\n');
		const opened = openIndex({ root: aliasDir, dbPath: join(aliasDir, "i.db") });
		try {
			await opened.indexer.sync();
			expect(importCycles(opened.store.importSnapshot(), opened.store.allFiles()).map((c) => c.files)).toEqual([
				["src/x.ts", "src/y.ts"],
			]);
		} finally {
			opened.store.close();
			rmSync(aliasDir, { recursive: true, force: true });
		}
	});
});
