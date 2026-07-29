/**
 * Workspace discovery and multi-repository index management. A cwd inside a Git repository selects
 * that repository. A workspace directory can discover child repositories and query them together;
 * each repository keeps its own `.codeindex/index.db`.
 *
 * Boundary rules:
 *  - `.git` (dir or file) marks a repo root.
 *  - A build-marker dir counts as a root only when NOT inside a detected git repo
 *    (containment rule — prevents monorepo packages from being double-indexed).
 *  - Linked worktrees of the same repository are deduplicated.
 *
 * Discovery is cached in-memory with a short TTL (no on-disk registry).
 */

import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { SyncResult } from "../engine/index.ts";
import { MAX_CONCURRENT_REPO_SYNCS, MAX_CONCURRENT_TYPED_REPO_SYNCS } from "../limits.ts";
import { IndexManager, typedEnabled } from "./manager.ts";
import { enclosingRepoRoot, isRepoRoot, mainRepoRoot } from "./repo.ts";

export interface WorkspaceRepo {
	path: string;
	name: string;
	kind: "git" | "marker";
	/** Main repo root when this entry is a linked git worktree of another checkout. */
	worktreeOf?: string;
}

interface SyncJob {
	run: () => Promise<unknown>;
	resolve: (value: unknown) => void;
	reject: (reason?: unknown) => void;
}

const MAX_FANOUT_REPOS = 8;
const REPO_CACHE_TTL_MS = 30_000;
const MAX_DEPTH = 4;

const BUILD_MARKERS = [
	"go.mod",
	"package.json",
	"Cargo.toml",
	"pyproject.toml",
	"requirements.txt",
	"Gemfile",
	"pom.xml",
	"build.gradle",
	"composer.json",
];
const PRUNED_DIRS = new Set([
	"node_modules",
	"dist",
	"build",
	"out",
	"target",
	"vendor",
	"coverage",
	"tmp",
	"venv",
	"__pycache__",
]);

export function discoverRepos(workspaceRoot: string): WorkspaceRepo[] {
	const root = resolve(workspaceRoot);
	if (isRepoRoot(root)) return [{ path: root, name: basename(root), kind: "git" }];

	const repos: WorkspaceRepo[] = [];
	const visit = (dir: string, depth: number, insideGit: boolean): void => {
		if (depth > MAX_DEPTH) return;
		let isGit = false;
		if (dir !== root && isRepoRoot(dir)) {
			isGit = true;
			const { mainRoot, isWorktree } = mainRepoRoot(dir);
			repos.push({ path: dir, name: basename(dir), kind: "git", ...(isWorktree ? { worktreeOf: mainRoot } : {}) });
		} else if (dir !== root && !insideGit && hasBuildMarker(dir)) {
			repos.push({ path: dir, name: basename(dir), kind: "marker" });
		}
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.startsWith(".") || PRUNED_DIRS.has(entry)) continue;
			const child = join(dir, entry);
			try {
				const stat = lstatSync(child);
				if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
			} catch {
				continue;
			}
			visit(child, depth + 1, insideGit || isGit);
		}
	};
	visit(root, 0, false);
	return dedupeContained(repos).sort((a, b) => a.path.localeCompare(b.path));
}

/** Repos relevant to a cwd: the enclosing git repo, or the discovered workspace, else cwd. */
export function resolveWorkspaceRepos(cwd: string): WorkspaceRepo[] {
	const repoRoot = enclosingRepoRoot(cwd);
	if (repoRoot) return [{ path: repoRoot, name: basename(repoRoot), kind: "git" }];
	const discovered = discoverRepos(cwd);
	return discovered.length > 0 ? discovered : [{ path: resolve(cwd), name: basename(resolve(cwd)), kind: "marker" }];
}

/** Drop marker roots contained inside git roots, and worktrees that duplicate a checkout. */
function dedupeContained(repos: WorkspaceRepo[]): WorkspaceRepo[] {
	const gitRoots = repos.filter((repo) => repo.kind === "git").map((repo) => repo.path);
	const withoutContainedMarkers = repos.filter(
		(repo) => repo.kind === "git" || !gitRoots.some((root) => containsPath(root, repo.path)),
	);
	const byIdentity = new Map<string, WorkspaceRepo>();
	for (const repo of withoutContainedMarkers) {
		const identity = repo.worktreeOf ?? repo.path;
		if (!byIdentity.has(identity)) byIdentity.set(identity, repo);
	}
	return [...byIdentity.values()];
}

function hasBuildMarker(dir: string): boolean {
	return BUILD_MARKERS.some((marker) => {
		try {
			return statSync(join(dir, marker)).isFile();
		} catch {
			return false;
		}
	});
}

/** Order repos so the cwd-containing repo comes first (it is warmed first, never capped out). */
function prioritizeCwd(repos: WorkspaceRepo[], cwd: string): WorkspaceRepo[] {
	const here = resolve(cwd);
	const contains = (repo: WorkspaceRepo) => containsPath(repo.path, here);
	const inside = repos.filter(contains).sort((a, b) => b.path.length - a.path.length);
	const outside = repos.filter((repo) => !contains(repo));
	return [...inside, ...outside];
}

/**
 * Owns one IndexManager per repo and fans queries out across them. Reuses the
 * single-repo IndexManager unchanged — this layer only adds discovery + fan-out.
 */
export class WorkspaceManager {
	private readonly cwd: string;
	private readonly syncConcurrency: number;
	private readonly managers = new Map<string, IndexManager>();
	private cache?: { at: number; repos: WorkspaceRepo[] };
	private warmedUp = false;
	private watching = false;
	private shuttingDown = false;
	private activeSyncs = 0;
	private readonly syncQueue: SyncJob[] = [];
	private readonly queuedWarmupPaths = new Set<string>();

	constructor(cwd: string) {
		this.cwd = cwd;
		this.syncConcurrency = typedEnabled() ? MAX_CONCURRENT_TYPED_REPO_SYNCS : MAX_CONCURRENT_REPO_SYNCS;
	}

	private allRepos(): WorkspaceRepo[] {
		const now = Date.now();
		if (!this.cache || now - this.cache.at > REPO_CACHE_TTL_MS) {
			this.cache = { at: now, repos: prioritizeCwd(resolveWorkspaceRepos(this.cwd), this.cwd) };
		}
		return this.cache.repos;
	}

	private filtered(filter?: string): WorkspaceRepo[] {
		const all = this.allRepos();
		if (!filter) return all;
		const normalizedFilter = filter.replaceAll("\\", "/");
		const resolvedFilter = resolveExistingPath(this.cwd, filter);
		return all.filter((repo) => {
			if (repo.name === filter || (isAbsolute(filter) && samePath(repo.path, filter))) return true;
			if (repo.path.replaceAll("\\", "/").endsWith(`/${normalizedFilter}`)) return true;
			return resolvedFilter !== undefined && containsPath(canonicalExistingPath(repo.path), resolvedFilter);
		});
	}

	/** Matching repos, cwd-first, capped at the fan-out limit. */
	repos(filter?: string): WorkspaceRepo[] {
		return this.filtered(filter).slice(0, MAX_FANOUT_REPOS);
	}

	/** How many matching repos the cap dropped (surfaced so capped queries are never silent). */
	droppedRepos(filter?: string): number {
		return Math.max(0, this.filtered(filter).length - MAX_FANOUT_REPOS);
	}

	multi(filter?: string): boolean {
		return this.repos(filter).length > 1;
	}

	managerFor(repoPath: string): IndexManager {
		let manager = this.managers.get(repoPath);
		if (!manager) {
			manager = new IndexManager(repoPath);
			this.managers.set(repoPath, manager);
			if (this.watching && this.automaticRepo()?.path === repoPath) manager.startWatching();
		}
		return manager;
	}

	/**
	 * Queue a best-effort warm-up without starting more than the workspace resource policy allows.
	 * Repeated reads of an unready repo coalesce into the same queued or in-flight manager sync.
	 */
	warmRepo(repoPath: string): void {
		if (this.shuttingDown || this.queuedWarmupPaths.has(repoPath)) return;
		const manager = this.managerFor(repoPath);
		if (manager.isReady() || manager.isSyncing()) return;
		this.queuedWarmupPaths.add(repoPath);
		void this.enqueueSync(async () => {
			this.queuedWarmupPaths.delete(repoPath);
			await manager.warm();
		}).catch(() => {});
	}

	private enqueueSync<T>(run: () => Promise<T>, priority = false): Promise<T> {
		if (this.shuttingDown) return Promise.reject(new Error("workspace is shutting down"));
		const promise = new Promise<unknown>((resolve, reject) => {
			const job = { run, resolve, reject };
			if (priority) this.syncQueue.unshift(job);
			else this.syncQueue.push(job);
		});
		this.drainSyncs();
		return promise as Promise<T>;
	}

	private drainSyncs(): void {
		while (!this.shuttingDown && this.activeSyncs < this.syncConcurrency && this.syncQueue.length > 0) {
			const job = this.syncQueue.shift();
			if (job === undefined) return;
			this.activeSyncs++;
			void job
				.run()
				.then(job.resolve, job.reject)
				.finally(() => {
					this.activeSyncs--;
					this.drainSyncs();
				});
		}
	}

	/** Sync selected repositories with bounded concurrency while preserving repository order. */
	async syncRepos(filter?: string, signal?: AbortSignal): Promise<Array<{ repo: WorkspaceRepo; result: SyncResult }>> {
		const repos = this.repos(filter);
		return mapConcurrent(repos, this.syncConcurrency, async (repo) => {
			signal?.throwIfAborted();
			// A blocking user request should run after active syncs, but ahead of background warm-ups
			// still waiting in the queue. Any later warm job for this repo becomes a cheap no-op.
			const result = await this.enqueueSync(() => this.managerFor(repo.path).sync(signal), true);
			return { repo, result };
		});
	}

	/**
	 * Whether any repo has a ready index holding symbols. `repos()` always resolves to at
	 * least the cwd (a marker fallback), so it cannot tell us if there is anything worth
	 * navigating; this can. Used to steer the agent toward the index only when it is useful.
	 */
	hasIndexedSymbols(): boolean {
		for (const manager of this.managers.values()) {
			const store = manager.readyStore();
			if (store?.hasSymbols()) return true;
		}
		return false;
	}

	/**
	 * Warm only the repository containing cwd. A container workspace may expose several
	 * repositories, but those are warmed on demand by the first query instead of consuming
	 * resources merely because a pi session started above them.
	 */
	warmUp(): void {
		if (this.warmedUp) return;
		this.warmedUp = true;
		const repo = this.automaticRepo();
		if (repo) this.warmRepo(repo.path);
	}

	startWatching(): void {
		this.watching = true;
		const repo = this.automaticRepo();
		if (repo) this.managerFor(repo.path).startWatching();
	}

	/** The single repository whose root contains cwd; absent for a multi-repo container root. */
	private automaticRepo(): WorkspaceRepo | undefined {
		const here = resolve(this.cwd);
		return this.repos().find((repo) => containsPath(repo.path, here));
	}

	async shutdown(): Promise<void> {
		this.shuttingDown = true;
		this.queuedWarmupPaths.clear();
		for (const job of this.syncQueue.splice(0)) job.reject(new Error("workspace shut down before sync started"));
		const managers = [...this.managers.values()];
		this.managers.clear();
		await Promise.all(managers.map((manager) => manager.shutdown()));
	}
}

/** Ordered concurrent map with a fixed number of workers and no promise allocation per item. */
async function mapConcurrent<T, R>(
	items: readonly T[],
	concurrency: number,
	run: (item: T) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < items.length) {
			const index = next++;
			const item = items[index];
			if (item === undefined) return;
			results[index] = await run(item);
		}
	};
	await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
	return results;
}

function containsPath(parent: string, candidate: string): boolean {
	const rel = relative(parent, candidate);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function samePath(left: string, right: string): boolean {
	const a = canonicalExistingPath(left);
	const b = canonicalExistingPath(right);
	return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Resolve path-like selectors without allowing a nonexistent string to select its enclosing repo. */
function resolveExistingPath(cwd: string, filter: string): string | undefined {
	const candidate = resolve(cwd, filter);
	if (!existsSync(candidate)) return undefined;
	return canonicalExistingPath(candidate);
}

/** Normalize platform aliases such as macOS `/var` → `/private/var` on both sides of a comparison. */
function canonicalExistingPath(path: string): string {
	const candidate = resolve(path);
	try {
		return realpathSync.native(candidate);
	} catch {
		return candidate;
	}
}
