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

import { existsSync, type FSWatcher, watch } from "node:fs";
import { Worker } from "node:worker_threads";
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

/** The worker could not be spawned or died before its ready handshake; sync in-process. */
class WorkerUnavailableError extends Error {}

export class IndexManager {
	private readonly root: string;
	private readonly dbPath: string;
	private store?: Store;
	private inflight?: Promise<SyncResult>;
	private inflightIsIncremental = false;
	private synced = false;
	private workerUnavailable = false;
	private readonly workers = new Set<Worker>();
	private watcher?: FSWatcher;
	private watchTimer?: ReturnType<typeof setTimeout>;
	private watchCatchUpTimer?: ReturnType<typeof setTimeout>;
	private lastSyncError?: string;
	private watcherState: "inactive" | "active" | "unavailable" | "error" = "inactive";
	private watcherError?: string;
	/** Repo-relative paths the watcher saw change since the last sync (incremental re-sync). */
	private readonly pendingChanges = new Set<string>();

	constructor(root: string) {
		this.root = root;
		this.dbPath = defaultDbPath(root);
	}

	repoRoot(): string {
		return this.root;
	}

	/** Main-thread store for reads, opened lazily. */
	getStore(): Store {
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
		watcher: "inactive" | "active" | "unavailable" | "error";
		lastSyncError?: string;
		watcherError?: string;
	} {
		return {
			watcher: this.watcherState,
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
		if (this.pendingChanges.size === 0) return Promise.resolve();
		if (this.inflight)
			return this.inflight.then(
				() => this.syncPending(),
				() => this.syncPending(),
			);
		const only = [...this.pendingChanges];
		this.pendingChanges.clear();
		// Layout, ignore, and nested-repository boundaries can affect files beyond
		// the changed path, so re-sync them in full.
		const request = only.some((path) => isLayoutFile(path) || isIgnoreFile(path) || isNestedRepositoryMarker(path))
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
			() => (this.pendingChanges.size > 0 ? this.syncPending() : undefined),
			() => {
				// Sync failed: requeue the batch so a later edit (or full sync) retries it.
				for (const path of only) this.pendingChanges.add(path);
			},
		);
	}

	private async runSync(opts: { only?: readonly string[] } = {}): Promise<SyncResult> {
		try {
			let result: SyncResult;
			if (!this.workerUnavailable) {
				try {
					result = await this.runInWorker(opts);
					this.lastSyncError = undefined;
					return result;
				} catch (error) {
					if (!(error instanceof WorkerUnavailableError)) throw error;
					this.workerUnavailable = true;
				}
			}
			result = await openIndexAndSync(this.root, this.dbPath, opts);
			this.lastSyncError = undefined;
			return result;
		} catch (error) {
			this.lastSyncError = error instanceof Error ? error.message : String(error);
			throw error;
		}
	}

	private runInWorker(opts: { only?: readonly string[] }): Promise<SyncResult> {
		// Rejects with WorkerUnavailableError if the worker can't start; runSync catches that and runs
		// the sync in-process instead.
		return this.spawnWorker(new URL("./worker.ts", import.meta.url), opts);
	}

	private spawnWorker(specifier: string | URL, opts: { only?: readonly string[] }): Promise<SyncResult> {
		return new Promise((resolve, reject) => {
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
			const settle = (fn: () => void): void => {
				if (settled) return;
				settled = true;
				this.workers.delete(worker);
				void worker.terminate().catch(() => undefined);
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
				if (message.result) settle(() => resolve(message.result as SyncResult));
				else settle(() => reject(new Error(message.error ?? "index worker returned no result")));
			});
			worker.once("error", (error) =>
				settle(() => reject(ready ? error : new WorkerUnavailableError(String(error)))),
			);
			worker.once("exit", (code) =>
				settle(() =>
					reject(
						ready
							? new Error(`index worker exited with code ${code}`)
							: new WorkerUnavailableError(`index worker exited with code ${code} before ready`),
					),
				),
			);
		});
	}

	/** Debounced recursive watcher; folds edits into the index. */
	startWatching(): void {
		if (this.watcher) return;
		try {
			this.watcher = watch(this.root, { recursive: true, persistent: false }, (_event, filename) => {
				if (!existsSync(this.root)) return this.stopWatching();
				if (!isWatchableChange(filename)) return;
				this.pendingChanges.add(String(filename).replaceAll("\\", "/"));
				if (this.watchTimer) clearTimeout(this.watchTimer);
				this.watchTimer = setTimeout(() => {
					this.watchTimer = undefined;
					void this.syncPending();
				}, WATCH_DEBOUNCE_MS);
			});
			this.watcherState = "active";
			this.watcherError = undefined;
			this.watcher.on("error", (error) => {
				this.watcherState = "error";
				this.watcherError = error.message;
				this.stopWatching(true);
			});
			// Recursive watcher backends may become observable asynchronously.
			// A one-time full sync closes that attachment gap.
			if (this.synced) {
				this.watchCatchUpTimer = setTimeout(() => {
					this.watchCatchUpTimer = undefined;
					const syncIfWatching = async (): Promise<void> => {
						if (this.watcher) await this.sync();
					};
					const catchUp = this.inflight ? this.inflight.then(syncIfWatching, syncIfWatching) : syncIfWatching();
					void catchUp.catch(() => undefined);
				}, WATCH_DEBOUNCE_MS);
			}
		} catch (error) {
			this.watcherState = "unavailable";
			this.watcherError = error instanceof Error ? error.message : String(error);
		}
	}

	stopWatching(preserveState = false): void {
		if (this.watchTimer) {
			clearTimeout(this.watchTimer);
			this.watchTimer = undefined;
		}
		if (this.watchCatchUpTimer) {
			clearTimeout(this.watchCatchUpTimer);
			this.watchCatchUpTimer = undefined;
		}
		if (this.watcher) {
			try {
				this.watcher.close();
			} catch {}
			this.watcher = undefined;
		}
		if (!preserveState) {
			this.watcherState = "inactive";
			this.watcherError = undefined;
		}
	}

	/** Terminate background workers and close the store; used on session shutdown. */
	shutdown(): void {
		this.stopWatching();
		for (const worker of [...this.workers]) {
			this.workers.delete(worker);
			void worker.terminate().catch(() => undefined);
		}
		this.store?.close();
		this.store = undefined;
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
	const normalized = filename.replaceAll("\\", "/");
	if (isIgnoreFile(normalized) || isNestedRepositoryMarker(normalized)) return true;
	if (isPrunedSourcePath(normalized)) return false;
	return isLayoutFile(normalized) || languageForFile(normalized) !== undefined;
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
