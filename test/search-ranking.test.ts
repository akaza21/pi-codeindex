import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type OpenedIndex, openIndex } from "../src/engine/index.ts";

// An exact name must outrank path-token matches, a multi-word query must still find the symbol,
// and an infix subsequence must resolve.
let handle: OpenedIndex | undefined;
let dir: string | undefined;

function open(files: Record<string, string>): OpenedIndex {
	dir = mkdtempSync(join(tmpdir(), "codeindex-search-"));
	for (const [name, body] of Object.entries(files)) {
		const full = join(dir, name);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, body);
	}
	handle = openIndex({ root: dir, dbPath: join(dir, "i.db") });
	return handle;
}

afterEach(() => {
	handle?.store.close();
	if (dir) rmSync(dir, { recursive: true, force: true });
	handle = undefined;
	dir = undefined;
});

describe("search ranking", () => {
	const corpus = {
		"storage/must.ts":
			"export function MustOpenStorage() { return 1; }\nexport function mustHelper() { return 2; }\n",
		"open.ts": "export function openThing() { return 3; }\n",
	};

	it("pins an exact name match first (Must Open Storage)", async () => {
		const h = open(corpus);
		await h.indexer.sync();
		expect(h.store.search("Must Open Storage", 5)[0]?.name).toBe("MustOpenStorage");
	});

	it("still finds the symbol for a partial multi-word query (must open)", async () => {
		const h = open(corpus);
		await h.indexer.sync();
		expect(h.store.search("must open", 5).map((s) => s.name)).toContain("MustOpenStorage");
	});

	it("resolves an infix subsequence FTS cannot prefix-match (OpenStor)", async () => {
		const h = open(corpus);
		await h.indexer.sync();
		expect(h.store.search("OpenStor", 5).map((s) => s.name)).toContain("MustOpenStorage");
	});

	it("treats `_` in a query as a literal, not a LIKE wildcard", async () => {
		const h = open({ "a.ts": "export function abcd() {}\n" });
		await h.indexer.sync();
		// `a_cd` must NOT match `abcd` (the `_` is literal); a real `a_cd` symbol would.
		expect(h.store.search("a_cd", 5).map((s) => s.name)).not.toContain("abcd");
	});
});
