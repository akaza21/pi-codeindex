import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { type OccurrenceHit, openIndex, type Store } from "../src/engine/index.ts";

function fixture(name: string): string {
	return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

const opened: Array<{ store: Store; tmp: string }> = [];
async function index(name: string): Promise<Store> {
	const tmp = mkdtempSync(join(tmpdir(), "codeindex-xfile-"));
	const o = openIndex({ root: fixture(name), dbPath: join(tmp, "index.db") });
	await o.indexer.sync();
	opened.push({ store: o.store, tmp });
	return o.store;
}

/** A caller resolved cross-file by the binder is precise (import/package), not a name guess. */
function precise(hit: OccurrenceHit | undefined): boolean {
	return hit !== undefined && hit.confidence >= 0.8 && hit.provenance === "syntactic";
}

describe("compiler-free cross-file resolution", () => {
	afterAll(() => {
		for (const { store, tmp } of opened) {
			store.close();
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("go: resolves an imported package call (pkg.Symbol) precisely", async () => {
		const store = await index("xfile-go");
		const callers = store.callers("Do", 10);
		// `Do` is only defined in util/helper.go, so a precise caller proves cross-package binding.
		expect(callers.some((h) => h.enclosing === "run" && precise(h))).toBe(true);
	});

	it("go: resolves a same-package call across sibling files", async () => {
		const store = await index("xfile-go");
		const callers = store.callers("A", 10);
		expect(callers.some((h) => h.enclosing === "B" && precise(h))).toBe(true);
	});

	it("python: resolves a from-import call to the module file", async () => {
		const store = await index("xfile-py");
		const callers = store.callers("helper", 10);
		expect(callers.some((h) => h.enclosing === "run" && precise(h))).toBe(true);
	});

	it("python: resolves a qualified call after plain `import pkg.mod`", async () => {
		const store = await index("xfile-py-qualified");
		const callers = store.callers("helper", 10);
		expect(callers.some((h) => h.enclosing === "run" && precise(h))).toBe(true);
	});

	it("java: resolves a same-package Class.method() call", async () => {
		const store = await index("xfile-java");
		const callers = store.callers("doIt", 10);
		expect(callers.some((h) => h.enclosing === "run" && precise(h))).toBe(true);
	});

	it("go: resolves a bare call through a dot import (wildcard)", async () => {
		const store = await index("xfile-go-dot");
		const callers = store.callers("Greet", 10);
		expect(callers.some((h) => h.enclosing === "run" && precise(h))).toBe(true);
	});

	it("java: resolves a bare member through a static wildcard import", async () => {
		const store = await index("xfile-java-static");
		const callers = store.callers("go", 10);
		expect(callers.some((h) => h.enclosing === "run" && precise(h))).toBe(true);
	});

	it("java: a NON-static package wildcard does NOT precisely bind a bare member", async () => {
		const store = await index("xfile-java-neg");
		// `import com.a.*` must not import-bind a bare `helperMethod()`; at most a low-confidence name guess.
		expect(store.callers("helperMethod", 10).every((h) => !precise(h))).toBe(true);
	});
});
