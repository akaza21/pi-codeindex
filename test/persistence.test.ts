import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { type OccurrenceRecord, openIndex, type Store } from "../src/engine/index.ts";

const opened: Store[] = [];
afterAll(() => {
	for (const store of opened) store.close();
});

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
		try {
			// Index once (writes symbols/occurrences keyed by the new descriptor monikers).
			const first = openIndex({ root: dir, dbPath });
			await first.indexer.sync();
			first.store.close();

			// Reopen the same DB WITHOUT re-syncing — reads must still join occurrences to
			// symbols by the persisted moniker strings (incl. the `().` / `#` markers).
			const { store } = openIndex({ root: dir, dbPath });
			opened.push(store);
			expect(store.definitions("Shape", 5)).toHaveLength(1);
			expect(store.callers("area", 5).some((h) => h.enclosing === "run")).toBe(true);
			expect(store.supertypes("Circle", 5).map((h) => `${h.enclosing} ${h.role} ${h.name}`)).toContain(
				"Circle extends Shape",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	// allOccurrences (and the agent reads) persist occurrences by integer symbol FK, so an
	// occurrence whose target symbol does not exist is dropped, not stored as a dangling row.
	it("persists only occurrences whose target symbol exists", async () => {
		const dir = mkdtempSync(join(tmpdir(), "codeindex-dangling-"));
		writeFileSync(join(dir, "m.ts"), "export function real() { return 1; }\n");
		try {
			const { store, indexer } = openIndex({ root: dir, dbPath: join(dir, "i.db") });
			opened.push(store);
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
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
