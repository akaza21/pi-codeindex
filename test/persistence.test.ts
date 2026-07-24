import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { type OccurrenceRecord, openIndex, SqliteStore, type Store } from "../src/engine/index.ts";

describe("moniker persistence", () => {
	it("rebuilds a corrupt cache database instead of leaving the package unusable", async () => {
		const dir = mkdtempSync(join(tmpdir(), "codeindex-corrupt-"));
		const dbPath = join(dir, "index.db");
		writeFileSync(dbPath, "this is not sqlite");
		writeFileSync(join(dir, "recover.ts"), "export function recovered() { return true; }\n");
		const { store, indexer } = openIndex({ root: dir, dbPath });
		try {
			await indexer.sync();
			expect(store.definitions("recovered", 5)).toHaveLength(1);
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("round-trips monikers through SQLite: a reopened index still resolves", async () => {
		const dir = mkdtempSync(join(tmpdir(), "codeindex-persist-"));
		const dbPath = join(dir, "index.db");
		writeFileSync(
			join(dir, "shapes.ts"),
			"export class Shape { area() { return 0; } }\n" +
				"export class Circle extends Shape {}\n" +
				"export function run() { new Shape().area(); }\n",
		);
		let firstStore: Store | undefined;
		let reopenedStore: Store | undefined;
		try {
			// Index once (writes symbols/occurrences keyed by the new descriptor monikers).
			const first = openIndex({ root: dir, dbPath });
			firstStore = first.store;
			await first.indexer.sync();
			firstStore.close();
			firstStore = undefined;

			// Reopen the same DB WITHOUT re-syncing — reads must still join occurrences to
			// symbols by the persisted moniker strings (incl. the `().` / `#` markers).
			const { store } = openIndex({ root: dir, dbPath });
			reopenedStore = store;
			expect(store.definitions("Shape", 5)).toHaveLength(1);
			expect(store.callers("area", 5).some((h) => h.enclosing === "run")).toBe(true);
			expect(store.supertypes("Circle", 5).map((h) => `${h.enclosing} ${h.role} ${h.name}`)).toContain(
				"Circle extends Shape",
			);
		} finally {
			reopenedStore?.close();
			firstStore?.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rebuilds a cache containing an escaping file path before serving it", async () => {
		const dir = mkdtempSync(join(tmpdir(), "codeindex-cache-boundary-"));
		const dbPath = join(dir, "index.db");
		writeFileSync(join(dir, "safe.ts"), "export function safe() { return true; }\n");
		let reopened: Store | undefined;
		try {
			const first = openIndex({ root: dir, dbPath });
			await first.indexer.sync();
			first.store.close();

			const raw = new DatabaseSync(dbPath);
			raw.prepare("INSERT INTO files (path, lang, mtime_ms, size, hash) VALUES (?, ?, ?, ?, ?)").run(
				"../outside.ts",
				"typescript",
				0,
				0,
				"",
			);
			raw.close();

			const opened = openIndex({ root: dir, dbPath });
			reopened = opened.store;
			expect(reopened.allFiles()).toEqual([]);
			await opened.indexer.sync();
			expect(reopened.definitions("safe", 5)).toHaveLength(1);
		} finally {
			reopened?.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects unsafe file paths at the persistence boundary", () => {
		const dir = mkdtempSync(join(tmpdir(), "codeindex-store-boundary-"));
		const store = new SqliteStore(dir, join(dir, "index.db"));
		try {
			expect(() =>
				store.upsertFileFacts("../outside.ts", "typescript", 0, 0, "", {
					symbols: [],
					references: [],
					imports: [],
					scopes: [],
					scopeDefs: [],
				}),
			).toThrow("outside the repository");
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not reuse an index created for a different repository root", async () => {
		const parent = mkdtempSync(join(tmpdir(), "codeindex-root-boundary-"));
		const firstRoot = join(parent, "first");
		const secondRoot = join(parent, "second");
		const dbPath = join(parent, "shared.db");
		mkdirSync(firstRoot);
		mkdirSync(secondRoot);
		writeFileSync(join(firstRoot, "first.ts"), "export function firstOnly() { return 1; }\n");
		writeFileSync(join(secondRoot, "second.ts"), "export function secondOnly() { return 2; }\n");
		let secondStore: Store | undefined;
		try {
			const first = openIndex({ root: firstRoot, dbPath });
			await first.indexer.sync();
			expect(first.store.definitions("firstOnly", 5)).toHaveLength(1);
			first.store.close();

			const second = openIndex({ root: secondRoot, dbPath });
			secondStore = second.store;
			expect(secondStore.definitions("firstOnly", 5)).toEqual([]);
			expect(secondStore.allFiles()).toEqual([]);
			await second.indexer.sync();
			expect(secondStore.definitions("secondOnly", 5)).toHaveLength(1);
		} finally {
			secondStore?.close();
			rmSync(parent, { recursive: true, force: true });
		}
	});

	// allOccurrences (and the agent reads) persist occurrences by integer symbol FK, so an
	// occurrence whose target symbol does not exist is dropped, not stored as a dangling row.
	it("persists only occurrences whose target symbol exists", async () => {
		const dir = mkdtempSync(join(tmpdir(), "codeindex-dangling-"));
		writeFileSync(join(dir, "m.ts"), "export function real() { return 1; }\n");
		let openedStore: Store | undefined;
		try {
			const { store, indexer } = openIndex({ root: dir, dbPath: join(dir, "i.db") });
			openedStore = store;
			await indexer.sync();
			const realMoniker = store.definitions("real", 5)[0]?.moniker as string;
			const at = (symbol: string): OccurrenceRecord => ({
				symbol,
				file: "m.ts",
				range: [1, 0, 1, 4],
				role: "reference",
				provenance: "syntactic",
				confidence: 0.5,
			});
			store.replaceOccurrences([at(realMoniker), at("m.ts#nope().@9:9")]);
			const targets = store.allOccurrences().map((o) => o.symbol);
			expect(targets).toContain(realMoniker); // resolvable target kept
			expect(targets).not.toContain("m.ts#nope().@9:9"); // dangling target dropped
		} finally {
			openedStore?.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
