import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodeFileSystem, openIndex, type Store } from "../src/engine/index.ts";
import { IndexManager } from "../src/pi/manager.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(): string {
	const root = mkdtempSync(join(tmpdir(), "codeindex-ignore-"));
	roots.push(root);
	return root;
}

function write(root: string, path: string, source: string): void {
	const full = join(root, path);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, source);
}

function walked(root: string): string[] {
	return [...new NodeFileSystem().walk(root)].map((path) => relative(root, path).replaceAll("\\", "/"));
}

describe("repository ignore rules", () => {
	it("applies root rules, wildcards, and negations in a non-Git workspace", () => {
		const root = workspace();
		write(root, ".gitignore", "ignored/\n*.skip.ts\n!keep.skip.ts\n");
		write(root, "app.ts", "export const app = 1;\n");
		write(root, "ignored/drop.ts", "export const drop = 1;\n");
		write(root, "drop.skip.ts", "export const dropSkip = 1;\n");
		write(root, "keep.skip.ts", "export const keep = 1;\n");

		expect(walked(root)).toEqual(["app.ts", "keep.skip.ts"]);
	});

	it("applies nested rules relative to their directory and permits valid re-inclusion", () => {
		const root = workspace();
		write(root, ".gitignore", "packages/*/cache/*\n!packages/a/cache/root-kept.ts\n");
		write(root, "packages/a/.gitignore", "*.ts\n!keep.ts\n!cache/nested-kept.ts\n");
		write(root, "packages/a/drop.ts", "export const drop = 1;\n");
		write(root, "packages/a/keep.ts", "export const keep = 1;\n");
		write(root, "packages/a/cache/root-kept.ts", "export const rootKept = 1;\n");
		write(root, "packages/a/cache/nested-kept.ts", "export const nestedKept = 1;\n");
		write(root, "packages/a/cache/drop.ts", "export const cacheDrop = 1;\n");

		// The deeper `*.ts` rule overrides the root re-inclusion for root-kept;
		// the two deeper negations remain included.
		expect(walked(root)).toEqual(["packages/a/keep.ts", "packages/a/cache/nested-kept.ts"]);
	});

	it("does not load a nested ignore file from an ignored parent directory", () => {
		const root = workspace();
		write(root, ".gitignore", "blocked/\n");
		write(root, "blocked/.gitignore", "!keep.ts\n");
		write(root, "blocked/keep.ts", "export const keep = 1;\n");
		write(root, "visible.ts", "export const visible = 1;\n");

		expect(walked(root)).toEqual(["visible.ts"]);
	});

	it("keeps hard hidden-path exclusions even when .gitignore negates them", () => {
		const root = workspace();
		write(root, ".gitignore", "!.secret/\n!.secret/keep.ts\n");
		write(root, ".secret/keep.ts", "export const hidden = 1;\n");
		write(root, "visible.ts", "export const visible = 1;\n");

		expect(walked(root)).toEqual(["visible.ts"]);
	});

	it("does not follow a symlinked .gitignore or accept an escaping incremental path", () => {
		const root = workspace();
		const outside = workspace();
		write(outside, "rules", "*.ts\n");
		write(root, "visible.ts", "export const visible = 1;\n");
		if (process.platform !== "win32") {
			symlinkSync(join(outside, "rules"), join(root, ".gitignore"), "file");
			expect(walked(root)).toEqual(["visible.ts"]);
		}
		const fs = new NodeFileSystem();
		expect(fs.isIgnored(root, "../outside.ts")).toBe(true);
		expect(fs.isIgnored(root, "/absolute.ts")).toBe(true);
	});

	it("does not descend into nested Git repositories or submodules", () => {
		const root = workspace();
		mkdirSync(join(root, ".git"));
		write(root, "root.ts", "export const rootSymbol = 1;\n");
		write(root, "nested-repo/.git/HEAD", "ref: refs/heads/main\n");
		write(root, "nested-repo/child.ts", "export const nestedRepoSymbol = 1;\n");
		write(root, "submodule/.git", "gitdir: ../.git/modules/submodule\n");
		write(root, "submodule/child.ts", "export const submoduleSymbol = 1;\n");

		expect(walked(root)).toEqual(["root.ts"]);
	});

	it("keeps traversal and capped candidate order deterministic", () => {
		const root = workspace();
		write(root, "a/one.ts", "export const one = 1;\n");
		write(root, "b/two.ts", "export const two = 1;\n");
		write(root, "root.ts", "export const root = 1;\n");

		const first = walked(root);
		expect(first).toEqual(["root.ts", "b/two.ts", "a/one.ts"]);
		expect(walked(root)).toEqual(first);
	});
});

describe("ignore-aware indexing", () => {
	it("applies ignore rules to full and direct incremental syncs and refreshes edits", async () => {
		const root = workspace();
		write(root, ".gitignore", "ignored.ts\n");
		write(root, "ignored.ts", "export function ignoredSymbol() {}\n");
		write(root, "visible.ts", "export function visibleSymbol() {}\n");
		const opened = openIndex({ root, dbPath: join(root, ".index.db") });
		const store: Store = opened.store;

		try {
			await opened.indexer.sync();
			expect(store.definitions("visibleSymbol", 5)).toHaveLength(1);
			expect(store.definitions("ignoredSymbol", 5)).toHaveLength(0);

			write(root, ".gitignore", "!ignored.ts\n");
			await opened.indexer.sync({ only: ["ignored.ts"] });
			expect(store.definitions("ignoredSymbol", 5)).toHaveLength(1);

			write(root, ".gitignore", "ignored.ts\n");
			await opened.indexer.sync({ only: ["ignored.ts"] });
			expect(store.definitions("ignoredSymbol", 5)).toHaveLength(0);
		} finally {
			store.close();
		}
	});

	it("treats ignore and nested-repository watcher batches as full syncs", async () => {
		const root = workspace();
		const manager = new IndexManager(root);
		const calls: Array<{ only?: readonly string[] }> = [];
		(manager as any).runSync = (opts: { only?: readonly string[] }) => {
			calls.push(opts);
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
			(manager as any).pendingChanges.add("nested/.gitignore");
			await (manager as any).syncPending();
			(manager as any).pendingChanges.add("nested-repo/.git/HEAD");
			await (manager as any).syncPending();
			expect(calls).toEqual([{}, {}]);
		} finally {
			await manager.shutdown();
		}
	});
});
