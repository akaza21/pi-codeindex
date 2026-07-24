/**
 * Node filesystem adapter implementing the FileSystem port. Pure I/O only; the walk
 * applies repository ignore rules and hard traversal boundaries before yielding files.
 */

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { isPrunedSourcePath } from "../indexer/source-filter.ts";
import type { FileStat, FileSystem } from "../ports.ts";
import { canonicalRepositoryRoot, existingPathWithinRoot } from "./repo-path.ts";
import { RepositoryIgnore } from "./repository-ignore.ts";

export class NodeFileSystem implements FileSystem {
	private readonly root: string;
	private ignoreRules: RepositoryIgnore;

	constructor(root: string) {
		this.root = canonicalRepositoryRoot(root);
		this.ignoreRules = new RepositoryIgnore(this.root);
	}

	readFile(absPath: string): string | undefined {
		try {
			const path = existingPathWithinRoot(this.root, absPath, true);
			return path ? readFileSync(path, "utf8") : undefined;
		} catch {
			return undefined;
		}
	}

	stat(absPath: string): FileStat | undefined {
		try {
			const path = existingPathWithinRoot(this.root, absPath, true);
			if (!path) return undefined;
			const s = lstatSync(path);
			return { mtimeMs: s.mtimeMs, size: s.size };
		} catch {
			return undefined;
		}
	}

	exists(absPath: string): boolean {
		return existingPathWithinRoot(this.root, absPath, true) !== undefined;
	}

	refreshIgnoreRules(root: string): void {
		const canonical = existingPathWithinRoot(this.root, root);
		if (canonical !== this.root) return;
		this.ignoreRules = new RepositoryIgnore(this.root);
	}

	isIgnored(root: string, relativePath: string, directory = false): boolean {
		if (existingPathWithinRoot(this.root, root) !== this.root) return true;
		return this.ignoreRules.ignores(relativePath, directory);
	}

	*walk(root: string): Iterable<string> {
		const start = resolve(root);
		if (existingPathWithinRoot(this.root, start) !== this.root) return;
		// A walk is a new filesystem snapshot. Re-read ignore files so repeated
		// syncs through one Indexer observe `.gitignore` edits.
		this.refreshIgnoreRules(start);
		const stack = [start];
		while (stack.length > 0) {
			const dir = stack.pop() as string;
			let entries: string[];
			try {
				entries = readdirSync(dir).sort();
			} catch {
				continue;
			}
			for (const entry of entries) {
				if (isPrunedSourcePath(entry)) continue;
				const full = join(dir, entry);
				const relativePath = relative(start, full).replaceAll("\\", "/");
				let stat: { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean };
				try {
					stat = lstatSync(full);
				} catch {
					continue;
				}
				// Never leave the selected repository through a directory/file symlink, and
				// avoid cycles created by links back into an ancestor.
				if (stat.isSymbolicLink()) continue;
				if (stat.isDirectory()) {
					if (!this.isIgnored(this.root, relativePath, true)) stack.push(full);
				} else if (stat.isFile() && !this.isIgnored(this.root, relativePath)) {
					yield full;
				}
			}
		}
	}
}
