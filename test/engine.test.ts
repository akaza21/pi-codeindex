import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openIndex, type Store } from "../src/engine/index.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/ts-project", import.meta.url));

describe("end-to-end index over a TS fixture", () => {
	let store: Store;
	let tmp: string;

	beforeAll(async () => {
		tmp = mkdtempSync(join(tmpdir(), "codeindex-test-"));
		const opened = openIndex({ root: FIXTURE, dbPath: join(tmp, "index.db") });
		store = opened.store;
		await opened.indexer.sync();
	});

	afterAll(() => {
		store.close();
		rmSync(tmp, { recursive: true, force: true });
	});

	it("indexes both files and their symbols", () => {
		const status = store.status();
		expect(status.files).toBe(2);
		expect(status.symbols).toBeGreaterThanOrEqual(5);
	});

	it("finds definitions by name", () => {
		const defs = store.definitions("add", 10);
		expect(defs).toHaveLength(1);
		expect(defs[0]?.file).toBe("math.ts");
		expect(defs[0]?.exported).toBe(true);
	});

	it("resolves same-file calls with full confidence", () => {
		// square() calls add() and multiply() in the same file.
		const callees = store.callees("square", 20).map((h) => h.name);
		expect(callees).toContain("add");
		expect(callees).toContain("multiply");
	});

	it("resolves cross-file calls through imports", () => {
		// Calculator.accumulate and run live in app.ts and call add/square from math.ts.
		const callers = store.callers("add", 20);
		const files = new Set(callers.map((h) => h.file));
		expect(files.has("app.ts")).toBe(true); // import-resolved
		expect(files.has("math.ts")).toBe(true); // same-file (square -> add)
		const imported = callers.find((h) => h.file === "app.ts");
		expect(imported?.confidence).toBeGreaterThanOrEqual(0.9);
	});

	it("computes reverse-call impact", () => {
		const impacted = store.impact("add", 2, 50).map((h) => h.name);
		expect(impacted).toContain("add");
	});

	it("search returns ranked symbol hits", () => {
		expect(store.search("Calculator", 5).some((h) => h.kind.includes("class"))).toBe(true);
	});
});
