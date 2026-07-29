import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultDbPath, openIndex, SqliteStore } from "../src/engine/index.ts";
import createExtension from "../src/pi/index.ts";
import {
	configuredMaxFiles,
	IndexManager,
	type WatcherBackend,
	WorkerUnavailableError,
	watchingEnabled,
} from "../src/pi/manager.ts";

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
			await handlers.get("session_shutdown")?.({}, ctx);
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
		await manager.shutdown();
	});

	it("retains a sync failure for status diagnostics", async () => {
		dir = mkdtempSync(join(tmpdir(), "codeindex-sync-error-"));
		const manager = new IndexManager(dir);
		(manager as any).runInWorker = () => Promise.reject(new Error("synthetic sync failure"));
		try {
			await expect(manager.sync()).rejects.toThrow("synthetic sync failure");
			expect(manager.diagnostics().lastSyncError).toBe("synthetic sync failure");
		} finally {
			await manager.shutdown();
		}
	});
});

describe("watcher integration", () => {
	it("supports an explicit watcher recovery switch", async () => {
		dir = mkdtempSync(join(tmpdir(), "codeindex-watch-disabled-"));
		const previous = process.env.PI_CODEINDEX_WATCH;
		let starts = 0;
		const backend: WatcherBackend = {
			name: "test",
			start() {
				starts++;
				return { close() {} };
			},
		};
		process.env.PI_CODEINDEX_WATCH = "0";
		const manager = new IndexManager(dir, backend);
		try {
			expect(watchingEnabled()).toBe(false);
			manager.startWatching();
			expect(starts).toBe(0);
			expect(manager.diagnostics()).toMatchObject({ watcher: "disabled", watcherBackend: "test" });
		} finally {
			await manager.shutdown();
			if (previous === undefined) delete process.env.PI_CODEINDEX_WATCH;
			else process.env.PI_CODEINDEX_WATCH = previous;
		}
	});

	it("contains synchronous and asynchronous watcher failures", async () => {
		dir = mkdtempSync(join(tmpdir(), "codeindex-watch-errors-"));
		const listeners = process.listenerCount("uncaughtException");
		const unavailable = new IndexManager(dir, {
			name: "throws",
			start() {
				throw Object.assign(new Error("descriptor budget exhausted"), { code: "EMFILE" });
			},
		});
		unavailable.startWatching();
		expect(unavailable.diagnostics()).toMatchObject({
			watcher: "unavailable",
			watcherBackend: "throws",
			watcherError: "descriptor budget exhausted",
		});

		let emitError: ((error: unknown) => void) | undefined;
		let closes = 0;
		const failing = new IndexManager(dir, {
			name: "emits",
			start(_root, _change, error) {
				emitError = error;
				return {
					close() {
						closes++;
					},
				};
			},
		});
		failing.startWatching();
		emitError?.(Object.assign(new Error("watch quota exhausted"), { code: "ENOSPC" }));
		await new Promise<void>((done) => setImmediate(done));
		expect(failing.diagnostics()).toMatchObject({
			watcher: "error",
			watcherBackend: "emits",
			watcherError: "watch quota exhausted",
		});
		expect(closes).toBe(1);
		expect(process.listenerCount("uncaughtException")).toBe(listeners);
		await unavailable.shutdown();
		await failing.shutdown();
	});

	it("reports watcher startup and catches up after a polling backend becomes ready", async () => {
		dir = mkdtempSync(join(tmpdir(), "codeindex-watch-ready-"));
		let ready: ((requiresCatchUp: boolean) => void) | undefined;
		const manager = new IndexManager(dir, {
			name: "delayed",
			start(_root, _change, _error, onReady) {
				ready = onReady;
				return { close() {} };
			},
		});
		const calls: Array<{ only?: readonly string[] }> = [];
		(manager as any).runSync = async (opts: { only?: readonly string[] }) => {
			calls.push(opts);
			return {
				indexedFiles: 0,
				removedFiles: 0,
				totalFiles: 0,
				symbols: 0,
				truncated: false,
				durationMs: 0,
			};
		};
		try {
			manager.startWatching();
			expect(manager.diagnostics().watcher).toBe("starting");
			ready?.(true);
			expect(manager.diagnostics().watcher).toBe("active");
			expect((manager as any).fullSyncPending).toBe(true);
			await (manager as any).syncPending();
			expect(calls).toEqual([{}]);
		} finally {
			await manager.shutdown();
		}
	});

	it("falls back to a bounded full sync for unknown filenames and event storms", async () => {
		dir = mkdtempSync(join(tmpdir(), "codeindex-watch-bounded-"));
		let emitChange: ((filename: string | null, event?: string) => void) | undefined;
		const manager = new IndexManager(dir, {
			name: "synthetic",
			start(_root, change) {
				emitChange = (filename, event = "change") => change(filename, event);
				return { close() {} };
			},
		});
		const calls: Array<{ only?: readonly string[] }> = [];
		(manager as any).runSync = async (opts: { only?: readonly string[] }) => {
			calls.push(opts);
			return {
				indexedFiles: 0,
				removedFiles: 0,
				totalFiles: 0,
				symbols: 0,
				truncated: false,
				durationMs: 0,
			};
		};
		try {
			manager.startWatching();
			emitChange?.("../outside.ts");
			expect((manager as any).pendingChanges.size).toBe(0);
			emitChange?.("node_modules/pkg/.gitignore");
			expect((manager as any).pendingChanges.size).toBe(0);
			emitChange?.("sub/../inside.ts");
			expect([...(manager as any).pendingChanges]).toEqual(["inside.ts"]);
			(manager as any).pendingChanges.clear();
			emitChange?.(null);
			await (manager as any).syncPending();
			expect(calls).toEqual([{}]);
			for (let i = 0; i < 2_100; i++) emitChange?.(`f${i}.ts`);
			expect((manager as any).pendingChanges.size).toBe(0);
			expect((manager as any).fullSyncPending).toBe(true);
			await (manager as any).syncPending();
			expect(calls).toEqual([{}, {}]);
		} finally {
			await manager.shutdown();
		}
	});

	it("drains a full-refresh event that arrives during an incremental sync", async () => {
		dir = mkdtempSync(join(tmpdir(), "codeindex-watch-mid-sync-"));
		let emitChange: ((filename: string | null, event?: string) => void) | undefined;
		const manager = new IndexManager(dir, {
			name: "synthetic",
			start(_root, change) {
				emitChange = (filename, event = "change") => change(filename, event);
				return { close() {} };
			},
		});
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
		try {
			manager.startWatching();
			emitChange?.("a.ts");
			const draining = (manager as any).syncPending();
			emitChange?.(null);
			finishFirst?.({
				indexedFiles: 1,
				removedFiles: 0,
				totalFiles: 1,
				symbols: 1,
				truncated: false,
				durationMs: 0,
			});
			await draining;
			expect(calls).toEqual([{ only: ["a.ts"] }, {}]);
		} finally {
			await manager.shutdown();
		}
	});

	it("uses a full refresh for directory rename events but ignores pruned trees", async () => {
		dir = mkdtempSync(join(tmpdir(), "codeindex-watch-directory-"));
		let emitChange: ((filename: string | null, event?: string) => void) | undefined;
		const manager = new IndexManager(dir, {
			name: "synthetic",
			start(_root, change) {
				emitChange = (filename, event = "change") => change(filename, event);
				return { close() {} };
			},
		});
		try {
			manager.startWatching();
			emitChange?.("node_modules/new-directory", "rename");
			expect((manager as any).fullSyncPending).toBe(false);
			emitChange?.("src/new-directory", "rename");
			expect((manager as any).fullSyncPending).toBe(true);
		} finally {
			await manager.shutdown();
		}
	});

	it("does not fall back to in-process indexing when shutdown kills an unready worker", async () => {
		dir = mkdtempSync(join(tmpdir(), "codeindex-shutdown-race-"));
		const manager = new IndexManager(dir);
		let failWorker: (() => void) | undefined;
		let fallbacks = 0;
		(manager as any).runInWorker = () =>
			new Promise((_resolve, reject) => {
				failWorker = () => reject(new WorkerUnavailableError("worker terminated before ready"));
			});
		(manager as any).runInProcess = async () => {
			fallbacks++;
			throw new Error("in-process fallback must not run during shutdown");
		};
		const syncResult = manager.sync().catch((error) => error);
		const shutdown = manager.shutdown();
		failWorker?.();
		await shutdown;
		expect(await syncResult).toBeInstanceOf(Error);
		expect(fallbacks).toBe(0);
		expect(manager.diagnostics().lastSyncError).toBeUndefined();
	});

	it("waits for an in-process fallback already in flight before closing the store", async () => {
		dir = mkdtempSync(join(tmpdir(), "codeindex-shutdown-fallback-"));
		const manager = new IndexManager(dir);
		let finishFallback: ((value: any) => void) | undefined;
		let fallbackStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			fallbackStarted = resolve;
		});
		(manager as any).runInWorker = async () => {
			throw new WorkerUnavailableError("worker unavailable");
		};
		(manager as any).runInProcess = () =>
			new Promise((resolve) => {
				fallbackStarted?.();
				finishFallback = resolve;
			});

		const sync = manager.sync();
		await started;
		let shutdownFinished = false;
		const shutdown = manager.shutdown().then(() => {
			shutdownFinished = true;
		});
		await Promise.resolve();
		expect(shutdownFinished).toBe(false);
		finishFallback?.({
			indexedFiles: 0,
			removedFiles: 0,
			totalFiles: 0,
			symbols: 0,
			truncated: false,
			durationMs: 0,
		});
		await sync;
		await shutdown;
		expect(shutdownFinished).toBe(true);
	});

	// Unsupported watcher backends must report degradation instead of breaking indexing.
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
			await m.shutdown();
		}
	}, 15000);
});
