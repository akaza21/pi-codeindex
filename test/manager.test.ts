import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultDbPath, openIndex, SqliteStore } from "../src/engine/index.ts";
import createExtension from "../src/pi/index.ts";
import { configuredMaxFiles, IndexManager } from "../src/pi/manager.ts";

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let dir: string | undefined;
afterEach(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
	dir = undefined;
});

describe("freshness — Indexer.verify", () => {
	it("counts changed / new / deleted files against the index", async () => {
		dir = mkdtempSync(join(tmpdir(), "codeindex-verify-"));
		writeFileSync(join(dir, "a.ts"), "export function a() { return 1; }\n");
		writeFileSync(join(dir, "b.ts"), "export function b() { return 2; }\n");
		const { store, indexer } = openIndex({ root: dir, dbPath: join(dir, "i.db") });
		try {
			await indexer.sync();
			expect(await indexer.verify()).toEqual({ changed: 0, new: 0, deleted: 0 });
			writeFileSync(join(dir, "a.ts"), "export function a() { return 111111; }\n"); // size changes
			writeFileSync(join(dir, "c.ts"), "export function c() { return 3; }\n");
			rmSync(join(dir, "b.ts"));
			expect(await indexer.verify()).toEqual({ changed: 1, new: 1, deleted: 1 });
		} finally {
			store.close();
		}
	});

	it("detects a same-size edit whose timestamp was restored", async () => {
		dir = mkdtempSync(join(tmpdir(), "codeindex-verify-content-"));
		const path = join(dir, "a.ts");
		writeFileSync(path, "export function oldName() {}\n");
		const { store, indexer } = openIndex({ root: dir, dbPath: join(dir, "i.db") });
		try {
			await indexer.sync();
			const before = statSync(path);
			writeFileSync(path, "export function newName() {}\n");
			utimesSync(path, before.atime, before.mtime);
			expect(await indexer.verify()).toEqual({ changed: 1, new: 0, deleted: 0 });
			await indexer.sync();
			expect(store.definitions("oldName", 5)).toHaveLength(0);
			expect(store.definitions("newName", 5)).toHaveLength(1);
		} finally {
			store.close();
		}
	});
});

describe("freshness — stale hint", () => {
	it("appends a staleness hint on a read when the index is old", async () => {
		dir = mkdtempSync(join(tmpdir(), "codeindex-stale-"));
		writeFileSync(join(dir, "a.ts"), "export function stalecheck() { return 1; }\n");
		const tools = new Map<string, any>();
		const handlers = new Map<string, any>();
		createExtension({
			registerTool: (def: any) => tools.set(def.name, def),
			on: (event: string, handler: any) => handlers.set(event, handler),
			registerCommand: () => {},
			registerShortcut: () => {},
			registerFlag: () => {},
		} as any);
		const ctx = { cwd: dir };
		try {
			await tools.get("codeindex_sync").execute("s", {}, undefined, undefined, ctx);
			// Backdate the last sync well past the staleness threshold (a separate WAL connection).
			const side = new SqliteStore(dir, defaultDbPath(dir));
			side.setMeta("last_sync_at", new Date(Date.now() - 60 * 60 * 1000).toISOString());
			side.close();
			const res = await tools.get("codeindex_def").execute("d", { name: "stalecheck" }, undefined, undefined, ctx);
			expect(res.content[0].text).toContain("if results look stale");
		} finally {
			handlers.get("session_shutdown")?.({}, ctx);
		}
	});
});

describe("manual sync contract", () => {
	it("rejects an environment file cap above the engine ceiling", () => {
		const previous = process.env.PI_CODEINDEX_MAX_FILES;
		try {
			process.env.PI_CODEINDEX_MAX_FILES = "100001";
			expect(() => configuredMaxFiles()).toThrow("no greater than 100,000");
		} finally {
			if (previous === undefined) delete process.env.PI_CODEINDEX_MAX_FILES;
			else process.env.PI_CODEINDEX_MAX_FILES = previous;
		}
	});

	it("queues a full sync behind an in-flight watcher sync", async () => {
		dir = mkdtempSync(join(tmpdir(), "codeindex-sync-queue-"));
		const manager = new IndexManager(dir);
		const calls: Array<{ only?: readonly string[] }> = [];
		let finishFirst: ((value: any) => void) | undefined;
		(manager as any).runSync = (opts: { only?: readonly string[] }) => {
			calls.push(opts);
			if (calls.length === 1)
				return new Promise((resolve) => {
					finishFirst = resolve;
				});
			return Promise.resolve({
				indexedFiles: 0,
				removedFiles: 0,
				totalFiles: 0,
				symbols: 0,
				truncated: false,
				durationMs: 0,
			});
		};
		(manager as any).pendingChanges.add("a.ts");
		const incremental = (manager as any).syncPending();
		const manual = manager.sync();
		finishFirst?.({ indexedFiles: 1, removedFiles: 0, totalFiles: 1, symbols: 1, truncated: false, durationMs: 0 });
		await Promise.all([incremental, manual]);
		expect(calls).toEqual([{ only: ["a.ts"] }, undefined]);
		manager.shutdown();
	});

	it("retains a sync failure for status diagnostics", async () => {
		dir = mkdtempSync(join(tmpdir(), "codeindex-sync-error-"));
		const manager = new IndexManager(dir);
		(manager as any).runInWorker = () => Promise.reject(new Error("synthetic sync failure"));
		try {
			await expect(manager.sync()).rejects.toThrow("synthetic sync failure");
			expect(manager.diagnostics().lastSyncError).toBe("synthetic sync failure");
		} finally {
			manager.shutdown();
		}
	});
});

describe("watcher integration", () => {
	// fs.watch({recursive}) is platform-gated; unsupported platforms must report degradation.
	it("folds a filesystem edit into the index (edit -> sync -> query)", async () => {
		dir = mkdtempSync(join(tmpdir(), "codeindex-watch-"));
		writeFileSync(join(dir, "a.ts"), "export function original() { return 1; }\n");
		const m = new IndexManager(dir);
		try {
			await m.sync();
			expect(m.getStore().definitions("original", 5)).toHaveLength(1);
			m.startWatching();
			if (m.diagnostics().watcher !== "active") {
				expect(m.diagnostics().watcher).toBe("unavailable");
				return;
			}
			// macOS can expose a recursive watcher handle before its backend is ready.
			await delay(500);
			writeFileSync(
				join(dir, "a.ts"),
				"export function original() { return 1; }\nexport function addedByWatcher() { return 2; }\n",
			);
			const deadline = Date.now() + 8000;
			let seen = false;
			while (Date.now() < deadline) {
				await delay(200);
				if (m.getStore().definitions("addedByWatcher", 5).length > 0) {
					seen = true;
					break;
				}
			}
			expect(seen).toBe(true);
			expect(m.getStore().definitions("addedByWatcher", 5)).toHaveLength(1);
		} finally {
			m.shutdown();
		}
	}, 15000);
});
