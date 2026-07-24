import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openIndex, type Store } from "../src/engine/index.ts";

// The syntactic bare-name fallback must not cross language boundaries: a Ruby reference must never
// resolve to a same-named JavaScript symbol (cross-language name collisions are noise). It may,
// however, resolve to a same-named symbol in a compatible-language file (incl. across the
// TypeScript/JavaScript family, which legitimately reference each other).
describe("syntactic bare-name fallback respects language families", () => {
	let dir: string;
	let store: Store;

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "codeindex-xlang-"));
		writeFileSync(join(dir, "util.js"), "function helper() { return 1; }\n");
		writeFileSync(join(dir, "helper.rb"), "def helper\n  2\nend\n");
		writeFileSync(join(dir, "caller.rb"), "def other\n  helper()\nend\n");
		// TS/JS family control: a .ts reference to a name defined only in a .js file (no import,
		// no local) should still resolve via the bare-name fallback — same family.
		writeFileSync(join(dir, "thing.js"), "function doThing() { return 1; }\n");
		writeFileSync(join(dir, "use.ts"), "export function run() { return doThing(); }\n");
		const opened = openIndex({ root: dir, dbPath: join(dir, "i.db") });
		store = opened.store;
		await opened.indexer.sync();
	});

	afterAll(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("never binds a Ruby reference to a JavaScript symbol", () => {
		const fromCaller = store.allOccurrences().filter((o) => o.file === "caller.rb");
		expect(fromCaller.some((o) => o.symbol.includes("util.js"))).toBe(false);
	});

	it("still resolves to the same-named symbol in a compatible-language (.rb) file", () => {
		const fromCaller = store.allOccurrences().filter((o) => o.file === "caller.rb");
		expect(fromCaller.some((o) => o.symbol.includes("helper.rb"))).toBe(true);
	});

	it("resolves across the TypeScript/JavaScript family (a .ts ref to a .js symbol)", () => {
		const fromUse = store.allOccurrences().filter((o) => o.file === "use.ts");
		expect(fromUse.some((o) => o.symbol.includes("thing.js"))).toBe(true);
	});
});
