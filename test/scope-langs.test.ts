import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openIndex, type Store } from "../src/engine/index.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/scope-langs", import.meta.url));

/**
 * L2 scope rules for Python/Go/Java are vendored (the grammar packages don't ship
 * locals.scm). These assert the scope graph actually resolves bindings for each.
 */
describe("L2 scope rules for vendored-locals languages", () => {
	let store: Store;
	let tmp: string;

	beforeAll(async () => {
		tmp = mkdtempSync(join(tmpdir(), "codeindex-langs-"));
		const opened = openIndex({ root: FIXTURE, dbPath: join(tmp, "index.db") });
		store = opened.store;
		await opened.indexer.sync();
	});

	afterAll(() => {
		store.close();
		rmSync(tmp, { recursive: true, force: true });
	});

	it("python: disambiguates a nested function from the module-level one (scoped)", () => {
		const callers = store.callers("helper", 20);
		expect(callers).toHaveLength(2);
		expect(callers.every((h) => h.provenance === "scoped" && h.confidence === 1)).toBe(true);
		expect(new Set(callers.map((h) => h.enclosing))).toEqual(new Set(["outer", "other"]));
	});

	it("go: resolves a top-level function call through the scope graph (scoped)", () => {
		const callers = store.callers("process", 20);
		expect(callers.some((h) => h.enclosing === "consumer" && h.provenance === "scoped")).toBe(true);
	});

	it("java: binds a same-class method call by class-body scope (scoped)", () => {
		const callers = store.callers("b", 20);
		const scoped = callers.filter((h) => h.provenance === "scoped");
		// `a()` calls `b()` and must bind to C.b via the class_body scope.
		expect(scoped.some((h) => h.enclosing === "a")).toBe(true);
	});
});
