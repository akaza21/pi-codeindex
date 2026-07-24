import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { openIndex, type Store } from "../src/engine/index.ts";
import { TreeSitterParser } from "../src/engine/parser/tree-sitter-parser.ts";
import { weighTargets } from "../src/engine/resolve/ranking.ts";

const opened: Array<{ close: () => void }> = [];
async function index(root: string): Promise<Store> {
	const tmp = mkdtempSync(join(tmpdir(), "codeindex-rf-"));
	const o = openIndex({ root, dbPath: join(tmp, "index.db") });
	await o.indexer.sync();
	opened.push({
		close: () => {
			o.store.close();
			rmSync(tmp, { recursive: true, force: true });
		},
	});
	return o.store;
}
function fixture(name: string): string {
	return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

afterAll(() => {
	for (const o of opened) o.close();
});

describe("confidence weighting", () => {
	it("keeps a single precise binding at full confidence", () => {
		expect(weighTargets([{ moniker: "m", resolution: "import", confidence: 0.9 }])[0]?.confidence).toBe(0.9);
	});
	it("splits multiple precise candidates by fan-out (never several at full confidence)", () => {
		const out = weighTargets([
			{ moniker: "a", resolution: "import", confidence: 0.9 },
			{ moniker: "b", resolution: "import", confidence: 0.9 },
		]);
		expect(out.every((t) => t.confidence === 0.45)).toBe(true);
	});
	it("a lone name guess stays at its low base (never 1.0)", () => {
		expect(weighTargets([{ moniker: "m", resolution: "name", confidence: 0.5 }])[0]?.confidence).toBe(0.5);
	});
});

describe("receiver-qualified scope resolution", () => {
	it("a package-qualified call is NOT captured by a same-name local via L2", async () => {
		// main.go has a local `Do` AND calls `util.Do()`. The guard must let L1's import
		// binder resolve it (provenance "syntactic"), not L2 lexical scope ("scoped").
		const store = await index(fixture("guard-go"));
		const callers = store.callers("Do", 10);
		const fromRun = callers.find((h) => h.enclosing === "run");
		expect(fromRun).toBeDefined();
		expect(fromRun?.provenance).toBe("syntactic"); // would be "scoped" without the guard
	});
});

describe("Python named import used as a receiver", () => {
	it("resolves `from pkg import mod; mod.fn()` cross-file", async () => {
		const store = await index(fixture("pyrecv"));
		const callers = store.callers("fn", 10);
		expect(callers.some((h) => h.provenance === "syntactic" && h.confidence >= 0.8)).toBe(true);
	});
});

describe("qualified receiver capture", () => {
	it("captures a chained receiver so a qualified call is never bound as a bare local", async () => {
		const parsed = await new TreeSitterParser().parse("a.ts", "function f() { return a.b.c(); }");
		const ref = parsed?.references.find((r) => r.name === "c");
		expect(ref?.receiver).toBe("a.b");
	});

	it("captures a qualified Ruby receiver (call node, `receiver` field)", async () => {
		const parsed = await new TreeSitterParser().parse("a.rb", "def f\n  a.b.c\nend\n");
		const ref = parsed?.references.find((r) => r.name === "c");
		expect(ref?.receiver).toBe("a.b");
	});
});

describe("file-cap safety", () => {
	it("a truncated walk removes rows outside the deterministic capped corpus", async () => {
		const dir = mkdtempSync(join(tmpdir(), "codeindex-cap-"));
		const db = join(dir, ".idx.db");
		for (const n of ["a", "b", "c"]) writeFileSync(join(dir, `${n}.ts`), `export function ${n}fn() { return 1; }\n`);
		const first = openIndex({ root: dir, dbPath: db });
		await first.indexer.sync();
		expect(first.store.status().files).toBe(3);
		first.store.close();
		// Re-parse everything, but cap the walk at 2: the persisted corpus must obey the cap
		// exactly, matching a clean capped rebuild.
		for (const n of ["a", "b", "c"]) writeFileSync(join(dir, `${n}.ts`), `export function ${n}fn() { return 2; }\n`);
		const capped = openIndex({ root: dir, dbPath: db, maxFiles: 2 });
		try {
			const result = await capped.indexer.sync();
			expect(result.truncated).toBe(true);
			expect(result.removedFiles).toBe(1);
			expect(capped.store.status().files).toBe(2);
		} finally {
			capped.store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("moniker uniqueness", () => {
	it("does not drop same-name symbols that start on the same line", async () => {
		const dir = mkdtempSync(join(tmpdir(), "codeindex-mon-"));
		// Two same-name declarations on one line: their monikers must differ (column-keyed).
		writeFileSync(join(dir, "a.ts"), "function f() {} function g() {} function f() {}\n");
		const { store, indexer } = openIndex({ root: dir, dbPath: join(dir, ".idx.db") });
		try {
			await indexer.sync();
			expect(store.definitions("f", 10)).toHaveLength(2); // both `f`s indexed, not collapsed to 1
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("same-line nested enclosing attribution", () => {
	it("attributes a call to the tightest enclosing def by column, not just line", async () => {
		const dir = mkdtempSync(join(tmpdir(), "codeindex-encl-"));
		writeFileSync(
			join(dir, "a.ts"),
			"export const outer = () => { const inner = () => helper(); return inner; };\nexport function helper() { return 1; }\n",
		);
		const { store, indexer } = openIndex({ root: dir, dbPath: join(dir, ".idx.db") });
		try {
			await indexer.sync();
			const callers = store.callers("helper", 10);
			expect(callers.some((h) => h.enclosing === "inner")).toBe(true); // not "outer"
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("occurrences dirty marker", () => {
	it("is visible while an incremental sync upserts changed-file facts", async () => {
		const dir = mkdtempSync(join(tmpdir(), "codeindex-dirty-"));
		writeFileSync(join(dir, "a.ts"), "export function before() {}\n");
		const { store, indexer } = openIndex({ root: dir, dbPath: join(dir, ".idx.db") });
		try {
			await indexer.sync();
			writeFileSync(join(dir, "a.ts"), "export function after() { return 1; }\n");
			const upsertFileFacts = store.upsertFileFacts.bind(store);
			store.upsertFileFacts = (...args) => {
				expect(store.getMeta("occurrences_dirty")).toBe("1");
				upsertFileFacts(...args);
			};
			await indexer.sync({ only: ["a.ts"] });
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("updates project layout in the same transaction after marking occurrences dirty", async () => {
		const dir = mkdtempSync(join(tmpdir(), "codeindex-layout-dirty-"));
		const config = join(dir, "tsconfig.json");
		writeFileSync(join(dir, "a.ts"), "export function value() {}\n");
		writeFileSync(config, JSON.stringify({ compilerOptions: { paths: { "@value": ["a.ts"] } } }));
		const { store, indexer } = openIndex({ root: dir, dbPath: join(dir, ".idx.db") });
		try {
			await indexer.sync();
			const transaction = store.transaction.bind(store);
			let transactionDepth = 0;
			store.transaction = ((fn: () => unknown) =>
				transaction(() => {
					transactionDepth++;
					try {
						return fn();
					} finally {
						transactionDepth--;
					}
				})) as Store["transaction"];
			const setMeta = store.setMeta.bind(store);
			store.setMeta = (key, value) => {
				if (key === "project_layout") {
					expect(transactionDepth).toBeGreaterThan(0);
					expect(store.getMeta("occurrences_dirty")).toBe("1");
				}
				setMeta(key, value);
			};
			writeFileSync(config, JSON.stringify({ compilerOptions: { paths: { "@value": ["b.ts"] } } }));
			await indexer.sync({ only: ["tsconfig.json"] });
			expect(store.getMeta("occurrences_dirty")).toBe("0");
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("file cap status", () => {
	it("rejects a programmatic file cap above the public ceiling", () => {
		const dir = mkdtempSync(join(tmpdir(), "codeindex-cap-invalid-"));
		writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
		expect(() => openIndex({ root: dir, dbPath: join(dir, ".idx.db"), maxFiles: 100_001 })).toThrow(
			"no greater than 100,000",
		);
		rmSync(dir, { recursive: true, force: true });
	});

	it("surfaces a truncated full walk in sync results and status", async () => {
		const dir = mkdtempSync(join(tmpdir(), "codeindex-cap-"));
		writeFileSync(join(dir, "a.ts"), "export function a() {}\n");
		writeFileSync(join(dir, "b.ts"), "export function b() {}\n");
		const { store, indexer } = openIndex({ root: dir, dbPath: join(dir, ".idx.db"), maxFiles: 1 });
		try {
			expect((await indexer.sync()).truncated).toBe(true);
			expect(store.status().truncated).toBe(true);
			rmSync(join(dir, "b.ts"));
			expect((await indexer.sync()).truncated).toBe(false);
			expect(store.status().truncated).toBe(false);
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not report truncation when only unsupported files remain after the exact cap", async () => {
		const dir = mkdtempSync(join(tmpdir(), "codeindex-cap-exact-"));
		writeFileSync(join(dir, "a.ts"), "export function a() {}\n");
		writeFileSync(join(dir, "z.txt"), "not source\n");
		const { store, indexer } = openIndex({ root: dir, dbPath: join(dir, ".idx.db"), maxFiles: 1 });
		try {
			expect((await indexer.sync()).truncated).toBe(false);
			expect(store.status().files).toBe(1);
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("content-hash skip", () => {
	it("re-index after a touch (mtime changed, content identical) reparses nothing", async () => {
		const dir = mkdtempSync(join(tmpdir(), "codeindex-hash-"));
		writeFileSync(join(dir, "a.ts"), "export function f() { return 1; }\n");
		const { store, indexer } = openIndex({ root: dir, dbPath: join(dir, ".idx.db") });
		try {
			const first = await indexer.sync();
			expect(first.indexedFiles).toBe(1);
			// Bump mtime into the future without changing content.
			const future = Date.now() / 1000 + 60;
			utimesSync(join(dir, "a.ts"), future, future);
			const second = await indexer.sync();
			expect(second.indexedFiles).toBe(0); // hash-confirmed unchanged → no reparse
			expect(store.definitions("f", 5)).toHaveLength(1); // still indexed
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
