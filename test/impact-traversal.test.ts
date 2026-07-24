import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openIndex, type Store } from "../src/engine/index.ts";

// A2: fair frontier budget + per-caller aggregation + visible hop depth. The corpus has one hot
// caller (three call sites of the seed), a sibling direct caller, and a depth-3 chain above the
// hot caller. Pre-fix, the seed's whole limit was spent on the hot caller's occurrence rows, so
// the traversal never reached the sibling or the deeper levels.
describe("impact traversal — fair, aggregated, depth-labelled", () => {
	let dir: string;
	let store: Store;

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "codeindex-impact-"));
		const files: Record<string, string> = {
			"target.ts": "export function target() { return 1; }\n",
			"hot.ts":
				'import { target } from "./target.ts";\nexport function hot() { return target() + target() + target(); }\n',
			"sibling.ts": 'import { target } from "./target.ts";\nexport function sibling() { return target(); }\n',
			"mid.ts": 'import { hot } from "./hot.ts";\nexport function mid() { return hot(); }\n',
			"top.ts": 'import { mid } from "./mid.ts";\nexport function top() { return mid(); }\n',
		};
		for (const [name, body] of Object.entries(files)) {
			const full = join(dir, name);
			mkdirSync(dirname(full), { recursive: true });
			writeFileSync(full, body);
		}
		const opened = openIndex({ root: dir, dbPath: join(dir, "i.db") });
		store = opened.store;
		await opened.indexer.sync();
	});

	afterAll(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("reaches every branch and depth within a small limit, aggregating duplicate call sites", () => {
		const hits = store.impact("target", 3, 4);
		const byCaller = new Map(hits.map((h) => [h.enclosing, h]));
		// Both direct callers and both deeper levels are represented despite the tight limit.
		expect(byCaller.get("hot")?.depth).toBe(1);
		expect(byCaller.get("sibling")?.depth).toBe(1);
		expect(byCaller.get("mid")?.depth).toBe(2);
		expect(byCaller.get("top")?.depth).toBe(3);
		// The hot caller's three call sites collapse into one row with a site count.
		expect(byCaller.get("hot")?.sites).toBe(3);
	});

	it("orders results by non-decreasing hop depth", () => {
		const depths = store.impact("target", 3, 4).map((h) => h.depth ?? 0);
		expect(depths).toEqual([...depths].sort((a, b) => a - b));
	});
});
