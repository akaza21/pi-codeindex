import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { discoverRepos, resolveWorkspaceRepos, WorkspaceManager } from "../src/pi/workspace.ts";

/** A workspace dir holding two sibling git repos (empty `.git` marks a repo root). */
function makeWorkspace(count = 2): string {
	const work = mkdtempSync(join(tmpdir(), "codeindex-ws-"));
	const base: Array<[string, string]> = [
		["alpha", "alphaFn"],
		["beta", "betaFn"],
		["gamma", "gammaFn"],
		["delta", "deltaFn"],
		["epsilon", "epsilonFn"],
	];
	const specs = base.slice(0, count);
	for (const [name, fn] of specs) {
		const repo = join(work, name);
		mkdirSync(join(repo, ".git"), { recursive: true });
		writeFileSync(join(repo, "main.ts"), `export function ${fn}() { return 1; }\n`);
	}
	return work;
}

describe("workspace discovery", () => {
	let work: string;
	beforeAll(() => {
		work = makeWorkspace();
	});
	afterAll(() => rmSync(work, { recursive: true, force: true }));

	it("discovers child git repos when cwd is not itself a repo", () => {
		const repos = discoverRepos(work)
			.map((r) => r.name)
			.sort();
		expect(repos).toEqual(["alpha", "beta"]);
		expect(resolveWorkspaceRepos(work)).toHaveLength(2);
	});

	it("fans a synced query out across repos with [repo] tags", async () => {
		const ws = new WorkspaceManager(work);
		expect(ws.multi()).toBe(true);
		for (const repo of ws.repos()) await ws.managerFor(repo.path).sync();

		const alpha = ws.managerFor(ws.repos().find((r) => r.name === "alpha")?.path as string);
		expect(alpha.getStore().definitions("alphaFn", 5)).toHaveLength(1);
		const beta = ws.managerFor(ws.repos().find((r) => r.name === "beta")?.path as string);
		expect(beta.getStore().definitions("alphaFn", 5)).toHaveLength(0); // isolated per repo

		await ws.shutdown();
	});

	it("bounds workspace warm-up concurrency while retaining all query repos", async () => {
		const largeWork = makeWorkspace(5);
		const previous = process.env.PI_CODEINDEX_TYPED;
		delete process.env.PI_CODEINDEX_TYPED;
		const ws = new WorkspaceManager(largeWork);
		try {
			const repos = ws.repos();
			expect(repos).toHaveLength(5);
			let active = 0;
			let peak = 0;
			let started = 0;
			const releases: Array<() => void> = [];
			for (const repo of repos) {
				const manager = ws.managerFor(repo.path);
				(manager as any).isReady = () => false;
				(manager as any).isSyncing = () => false;
				(manager as any).warm = () =>
					new Promise<void>((resolve) => {
						started++;
						active++;
						peak = Math.max(peak, active);
						releases.push(() => {
							active--;
							resolve();
						});
					});
			}

			ws.warmUp();
			expect(started).toBe(2);
			while (started < repos.length) {
				releases.shift()?.();
				await new Promise<void>((resolve) => setImmediate(resolve));
			}
			for (const release of releases) release();
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(peak).toBe(2);
			expect(started).toBe(5);
			expect(ws.repos()).toHaveLength(5);
		} finally {
			await ws.shutdown();
			rmSync(largeWork, { recursive: true, force: true });
			if (previous === undefined) delete process.env.PI_CODEINDEX_TYPED;
			else process.env.PI_CODEINDEX_TYPED = previous;
		}
	});

	it("serializes typed workspace warm-ups", async () => {
		const typedWork = makeWorkspace(3);
		const previous = process.env.PI_CODEINDEX_TYPED;
		process.env.PI_CODEINDEX_TYPED = "1";
		const ws = new WorkspaceManager(typedWork);
		try {
			let active = 0;
			let peak = 0;
			let started = 0;
			const releases: Array<() => void> = [];
			for (const repo of ws.repos()) {
				const manager = ws.managerFor(repo.path);
				(manager as any).isReady = () => false;
				(manager as any).isSyncing = () => false;
				(manager as any).warm = () =>
					new Promise<void>((resolve) => {
						started++;
						active++;
						peak = Math.max(peak, active);
						releases.push(() => {
							active--;
							resolve();
						});
					});
			}

			ws.warmUp();
			expect(started).toBe(1);
			while (started < 3) {
				releases.shift()?.();
				await new Promise<void>((resolve) => setImmediate(resolve));
			}
			for (const release of releases) release();
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(peak).toBe(1);
		} finally {
			await ws.shutdown();
			rmSync(typedWork, { recursive: true, force: true });
			if (previous === undefined) delete process.env.PI_CODEINDEX_TYPED;
			else process.env.PI_CODEINDEX_TYPED = previous;
		}
	});
});
