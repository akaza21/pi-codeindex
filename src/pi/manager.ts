/**
 * Index manager: owns the per-repo store and drives background
 * syncs and filesystem watching for the pi session.
 *
 * - Reads use a main-thread store; WAL makes worker commits visible to it.
 * - Syncs run in a worker thread (in-process fallback when the worker can't load),
 *   deduped per repo so one repo never syncs twice at once.
 * - A debounced recursive watcher folds edits into the index; watchers never keep the
 *   process alive and are torn down on shutdown.
 */

import { existsSync, watch as watchNative } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { watch as watchPortable } from "chokidar";
import { defaultDbPath, languageForFile, openIndex, type Store, type SyncResult } from "../engine/index.ts";
import { isPrunedSourcePath } from "../engine/indexer/source-filter.ts";
import { MAX_INDEX_FILE_LIMIT, validateIndexFileLimit } from "../limits.ts";
import type { IndexWorkerRequest, IndexWorkerResponse } from "./worker.ts";

/** The in-process TypeScript typed resolver is opt-in: set PI_CODEINDEX_TYPED=1 to enable. */
export function typedEnabled(): boolean {
	return process.env.PI_CODEINDEX_TYPED === "1";
}

/** Optional full-sync file cap for pi; invalid values fail fast instead of silently changing scope. */
export function configuredMaxFiles(): number | undefined {
	const raw = process.env.PI_CODEINDEX_MAX_FILES;
	if (raw === undefined || raw === "") return undefined;
	const value = Number(raw);
	try {
		return validateIndexFileLimit(value);
	} catch {
		throw new Error(
			`PI_CODEINDEX_MAX_FILES must be a positive integer no greater than ${MAX_INDEX_FILE_LIMIT.toLocaleString("en-US")}`,
		);
	}
}

const WATCH_DEBOUNCE_MS = 750;
const MAX_PENDING_WATCH_CHANGES = 2_048;

type WatcherState = "inactive" | "starting" | "active" | "disabled" | "unavailable" | "error";

interface WatcherHandle {
	close(): void | Promise<void>;
}

/** Injectable boundary around platform watcher implementations. */
export interface WatcherBackend {
	readonly name: string;
	start(
		root: string,
		onChange: (filename: string | null, event: string) => void,
		onError: (error: unknown) => void,
		onReady: (requiresCatchUp: boolean) => void,
	): WatcherHandle;
}

/** Automatic watching is enabled unless the documented recovery switch is exactly `0`. */
export function watchingEnabled(): boolean {
	return process.env.PI_CODEINDEX_WATCH !== "0";
}

function platformWatcherBackend(): WatcherBackend {
	if (process.platform === "win32") {
		return {
			name: "windows-polling",
			start(root, onChange, onError, onReady) {
				// Native recursive fs.watch has caused process-level aborts on Windows while
				// directory entries are changing. Chokidar's polling backend avoids that native path.
				const watcher = watchPortable(root, {
					followSymlinks: false,
					ignoreInitial: true,
					ignored: (path) => isIgnoredWatchPath(root, path),
					persistent: false,
					usePolling: true,
					interval: 1_000,
					binaryInterval: 1_500,
				});
				watcher.on("error", onError);
				watcher.on("all", (event, path) => onChange(relative(root, path).replaceAll("\\", "/"), event));
				// Chokidar ignores entries discovered during its initial scan. A catch-up sync
				// after `ready` closes that startup window before steady-state events take over.
				watcher.once("ready", () => onReady(true));
				return watcher;
			},
		};
	}
	return {
		name: "native-recursive",
		start(root, onChange, onError, onReady) {
			const watcher = watchNative(root, { recursive: true, persistent: false }, (event, filename) =>
				onChange(filename === null ? null : String(filename), event),
			);
			watcher.on("error", onError);
			watcher.unref();
			onReady(false);
			return watcher;
		},
	};
}

/** The worker could not be spawned or died before its ready handshake; sync in-process. */
export class WorkerUnavailableError extends Error {}
class ManagerClosedError extends Error {}

export class IndexManager {
	private readonly root: string;
	private readonly dbPath: string;
	private store?: Store;
	private inflight?: Promise<SyncResult>;
	private inflightIsIncremental = false;
	private synced = false;
	private workerUnavailable = false;
	private closing = false;
	private shutdownPromise?: Promise<void>;
	private readonly workers = new Set<Worker>();
	private readonly watcherBackend: WatcherBackend;
	private watcher?: WatcherHandle;
	private watcherGeneration = 0;
	private watchTimer?: ReturnType<typeof setTimeout>;
	private lastSyncError?: string;
	private watcherState: WatcherState = "inactive";
	private watcherError?: string;
	private fullSyncPending = false;
	/** Repo-relative paths the watcher saw change since the last sync (incremental re-sync). */
	private readonly pendingChanges = new Set<string>();

	constructor(root: string, watcherBackend: WatcherBackend = platformWatcherBackend()) {
		this.root = root;
		this.dbPath = defaultDbPath(root);
		this.watcherBackend = watcherBackend;
	}

	repoRoot(): string {
		return this.root;
	}

	/** Main-thread store for reads, opened lazily. */
	getStore(): Store {
		if (this.closing) throw new ManagerClosedError("index manager is shutting down");
		if (!this.store) {
			const maxFiles = configuredMaxFiles();
			this.store = openIndex({
				root: this.root,
				dbPath: this.dbPath,
				typed: typedEnabled(),
				...(maxFiles === undefined ? {} : { maxFiles }),
			}).store;
		}
		return this.store;
	}

	isReady(): boolean {
		return this.getStore().isReady();
	}

	isSyncing(): boolean {
		return this.inflight !== undefined;
	}

	diagnostics(): {
		watcher: WatcherState;
		watcherBackend: string;
		lastSyncError?: string;
		watcherError?: string;
	} {
		return {
			watcher: this.watcherState,
			watcherBackend: this.watcherBackend.name,
			...(this.lastSyncError ? { lastSyncError: this.lastSyncError } : {}),
			...(this.watcherError ? { watcherError: this.watcherError } : {}),
		};
	}

	/** Best-effort store for routing; never triggers a sync. */
	readyStore(): Store | undefined {
		const store = this.getStore();
		return store.isReady() ? store : undefined;
	}

	/** Run a sync (worker, in-process fallback), deduping concurrent calls. */
	sync(signal?: AbortSignal): Promise<SyncResult> {
		signal?.throwIfAborted();
		if (this.closing) return Promise.reject(new ManagerClosedError("index manager is shutting down"));
		if (this.inflight)
			return waitFor(
				this.inflightIsIncremental
					? this.inflight.then(
							() => this.sync(signal),
							() => this.sync(signal),
						)
					: this.inflight,
				signal,
			);
		this.inflightIsIncremental = false;
		this.inflight = this.runSync()
			.then((result) => {
				this.synced = true;
				return result;
			})
			.finally(() => {
				this.inflight = undefined;
			});
		return waitFor(this.inflight, signal);
	}

	/** Background sync completion used by the workspace's bounded warm-up scheduler. */
	warm(): Promise<void> {
		if (this.closing) return Promise.resolve();
		if (this.synced && !this.inflight) return Promise.resolve();
		return this.sync().then(
			() => undefined,
			() => undefined,
		);
	}

	/**
	 * Re-index only the files the watcher saw change since the last sync — an O(changed)
	 * warm re-sync instead of a whole-repo walk. Never overlaps another sync; changes that
	 * arrive mid-sync are drained afterwards. A full sync (warm/manual) remains the fallback.
	 */
	private syncPending(): Promise<unknown> {
		if (this.closing) return Promise.resolve();
		if (this.pendingChanges.size === 0 && !this.fullSyncPending) return Promise.resolve();
		if (this.inflight)
			return this.inflight.then(
				() => this.syncPending(),
				() => this.syncPending(),
			);
		const only = [...this.pendingChanges];
		const full = this.fullSyncPending;
		this.pendingChanges.clear();
		this.fullSyncPending = false;
		// Layout, ignore, and nested-repository boundaries can affect files beyond
		// the changed path, so re-sync them in full.
		const request =
			full || only.some((path) => isLayoutFile(path) || isIgnoreFile(path) || isNestedRepositoryMarker(path))
				? {}
				: { only };
		this.inflightIsIncremental = request.only !== undefined;
		this.inflight = this.runSync(request)
			.then((result) => {
				this.synced = true;
				return result;
			})
			.finally(() => {
				this.inflight = undefined;
				this.inflightIsIncremental = false;
			});
		return this.inflight.then(
			() => (this.pendingChanges.size > 0 || this.fullSyncPending ? this.syncPending() : undefined),
			() => {
				if (this.closing) return;
				// Sync failed: requeue the batch so a later edit (or full sync) retries it.
				if (full) this.fullSyncPending = true;
				else for (const path of only) this.pendingChanges.add(path);
			},
		);
	}

	private async runSync(opts: { only?: readonly string[] } = {}): Promise<SyncResult> {
		try {
			if (this.closing) throw new ManagerClosedError("index manager is shutting down");
			let result: SyncResult;
			if (!this.workerUnavailable) {
				try {
					result = await this.runInWorker(opts);
					this.lastSyncError = undefined;
					return result;
				} catch (error) {
					if (!(error instanceof WorkerUnavailableError)) throw error;
					if (this.closing) throw new ManagerClosedError("index manager shut down before the worker became ready");
					this.workerUnavailable = true;
				}
			}
			if (this.closing) throw new ManagerClosedError("index manager is shutting down");
			result = await this.runInProcess(opts);
			this.lastSyncError = undefined;
			return result;
		} catch (error) {
			if (!(error instanceof ManagerClosedError))
				this.lastSyncError = error instanceof Error ? error.message : String(error);
			throw error;
		}
	}

	/** Isolated for shutdown-race tests; worker fallback is allowed only while the manager is open. */
	private runInProcess(opts: { only?: readonly string[] }): Promise<SyncResult> {
		return openIndexAndSync(this.root, this.dbPath, opts);
	}

	private runInWorker(opts: { only?: readonly string[] }): Promise<SyncResult> {
		// Rejects with WorkerUnavailableError if the worker can't start; runSync catches that and runs
		// the sync in-process instead.
		return this.spawnWorker(new URL("./worker.ts", import.meta.url), opts);
	}

	private spawnWorker(specifier: string | URL, opts: { only?: readonly string[] }): Promise<SyncResult> {
		return new Promise((resolve, reject) => {
			if (this.closing) {
				reject(new ManagerClosedError("index manager is shutting down"));
				return;
			}
			let worker: Worker;
			try {
				worker = new Worker(specifier);
			} catch (error) {
				reject(new WorkerUnavailableError(String(error)));
				return;
			}
			this.workers.add(worker);
			let ready = false;
			let settled = false;
			let response: IndexWorkerResponse | undefined;
			const settle = (fn: () => void): void => {
				if (settled) return;
				settled = true;
				this.workers.delete(worker);
				fn();
			};
			worker.on("message", (message: IndexWorkerResponse) => {
				if (message.ready) {
					ready = true;
					worker.postMessage({
						root: this.root,
						dbPath: this.dbPath,
						...(opts.only ? { only: [...opts.only] } : {}),
					} satisfies IndexWorkerRequest);
					return;
				}
				response = message;
			});
			worker.once("error", (error) =>
				settle(() => reject(ready ? error : new WorkerUnavailableError(String(error)))),
			);
			worker.once("exit", (code) => {
				settle(() => {
					if (!ready) {
						reject(new WorkerUnavailableError(`index worker exited with code ${code} before ready`));
					} else if (code !== 0) {
						reject(new Error(`index worker exited with code ${code}`));
					} else if (response?.result) {
						resolve(response.result);
					} else {
						reject(new Error(response?.error ?? "index worker returned no result"));
					}
				});
			});
		});
	}

	/** Debounced recursive watcher; folds edits into the index. */
	startWatching(): void {
		if (this.watcher || this.closing) return;
		if (!watchingEnabled()) {
			this.watcherState = "disabled";
			this.watcherError = undefined;
			return;
		}
		const generation = ++this.watcherGeneration;
		this.watcherState = "starting";
		this.watcherError = undefined;
		try {
			const watcher = this.watcherBackend.start(
				this.root,
				(filename, event) => {
					if (generation !== this.watcherGeneration) return;
					this.handleWatchChange(filename, event);
				},
				(error) => {
					if (generation !== this.watcherGeneration) return;
					this.watcherState = "error";
					this.watcherError = error instanceof Error ? error.message : String(error);
					void this.stopWatching(true);
				},
				(requiresCatchUp) => {
					if (generation !== this.watcherGeneration) return;
					this.watcherState = "active";
					this.watcherError = undefined;
					if (requiresCatchUp) {
						this.fullSyncPending = true;
						this.pendingChanges.clear();
						this.schedulePendingSync();
					}
				},
			);
			if (generation !== this.watcherGeneration) {
				try {
					void Promise.resolve(watcher.close()).catch(() => undefined);
				} catch {}
				return;
			}
			this.watcher = watcher;
		} catch (error) {
			this.watcherState = "unavailable";
			this.watcherError = error instanceof Error ? error.message : String(error);
		}
	}

	private handleWatchChange(filename: string | null, event: string): void {
		if (!existsSync(this.root)) {
			void this.stopWatching();
			return;
		}
		if (filename === null || filename === "") {
			this.fullSyncPending = true;
			this.pendingChanges.clear();
			this.schedulePendingSync();
			return;
		}
		const normalized = normalizeWatchPath(this.root, filename);
		if (!normalized) return;
		if (!isWatchableChange(normalized)) {
			if (isDirectoryEvent(event) && !isPrunedSourcePath(normalized)) {
				this.fullSyncPending = true;
				this.pendingChanges.clear();
				this.schedulePendingSync();
			}
			return;
		}
		if (!this.fullSyncPending) {
			if (this.pendingChanges.size >= MAX_PENDING_WATCH_CHANGES) {
				this.pendingChanges.clear();
				this.fullSyncPending = true;
			} else {
				this.pendingChanges.add(normalized);
			}
		}
		this.schedulePendingSync();
	}

	private schedulePendingSync(): void {
		if (this.watchTimer) clearTimeout(this.watchTimer);
		this.watchTimer = setTimeout(() => {
			this.watchTimer = undefined;
			void this.syncPending();
		}, WATCH_DEBOUNCE_MS);
	}

	async stopWatching(preserveState = false): Promise<void> {
		this.watcherGeneration++;
		if (this.watchTimer) {
			clearTimeout(this.watchTimer);
			this.watchTimer = undefined;
		}
		this.pendingChanges.clear();
		this.fullSyncPending = false;
		const watcher = this.watcher;
		this.watcher = undefined;
		if (!preserveState) {
			this.watcherState = "inactive";
			this.watcherError = undefined;
		}
		try {
			await watcher?.close();
		} catch {}
	}

	/** Terminate background workers and close the store; used on session shutdown. */
	async shutdown(): Promise<void> {
		if (this.shutdownPromise) return this.shutdownPromise;
		this.closing = true;
		this.shutdownPromise = (async () => {
			await this.stopWatching();
			const workers = [...this.workers];
			this.workers.clear();
			await Promise.all(workers.map((worker) => worker.terminate().catch(() => undefined)));
			await this.inflight?.catch(() => undefined);
			this.store?.close();
			this.store = undefined;
		})();
		return this.shutdownPromise;
	}
}

/** Let one caller stop waiting for a shared sync without cancelling the cache update for others. */
function waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	signal.throwIfAborted();
	return new Promise<T>((resolve, reject) => {
		const aborted = (): void => reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
		signal.addEventListener("abort", aborted, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
	});
}

function openIndexAndSync(root: string, dbPath: string, opts: { only?: readonly string[] }): Promise<SyncResult> {
	const maxFiles = configuredMaxFiles();
	const { store, indexer } = openIndex({
		root,
		dbPath,
		typed: typedEnabled(),
		...(maxFiles === undefined ? {} : { maxFiles }),
	});
	return indexer.sync(opts).finally(() => store.close());
}

function isWatchableChange(filename: string | null): boolean {
	if (!filename) return false;
	const normalized = process.platform === "win32" ? filename.replaceAll("\\", "/") : filename;
	if (isIgnoreFile(normalized) || isLayoutFile(normalized))
		return !isPrunedSourcePath(normalized.split("/").slice(0, -1).join("/"));
	if (isNestedRepositoryMarker(normalized)) {
		const parts = normalized.split("/");
		return !isPrunedSourcePath(parts.slice(0, parts.indexOf(".git")).join("/"));
	}
	if (isPrunedSourcePath(normalized)) return false;
	return languageForFile(normalized) !== undefined;
}

function normalizeWatchPath(root: string, filename: string): string | undefined {
	const candidate = resolve(root, filename);
	const normalized = relative(root, candidate);
	if (!normalized || normalized === ".." || normalized.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`))
		return undefined;
	if (isAbsolute(normalized)) return undefined;
	return process.platform === "win32" ? normalized.replaceAll("\\", "/") : normalized;
}

function isDirectoryEvent(event: string): boolean {
	return event === "rename" || event === "addDir" || event === "unlinkDir";
}

function isIgnoredWatchPath(root: string, path: string): boolean {
	const normalized = relative(root, path).replaceAll("\\", "/");
	if (!normalized || isIgnoreFile(normalized)) return false;
	const parts = normalized.split("/");
	if (parts.length > 1 && parts.at(-1) === ".git") return false;
	return isPrunedSourcePath(normalized);
}

/** Per-repo config files that change how imports resolve; a change re-derives the whole layout. */
function isLayoutFile(path: string): boolean {
	const base = path.split("/").pop() ?? "";
	return base === "tsconfig.json" || base === "go.mod";
}

function isIgnoreFile(path: string): boolean {
	return (path.split("/").pop() ?? "") === ".gitignore";
}

/** A `.git` marker below the selected root starts or ends a nested-repository boundary. */
function isNestedRepositoryMarker(path: string): boolean {
	return path.split("/").indexOf(".git") > 0;
}
