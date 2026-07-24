/**
 * Node filesystem adapter implementing the FileSystem port. Pure I/O only; the walk
 * applies repository ignore rules and hard traversal boundaries before yielding files.
 */

import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { isPrunedSourcePath } from "../indexer/source-filter.ts";
import type { FileStat, FileSystem } from "../ports.ts";
import { RepositoryIgnore } from "./repository-ignore.ts";

export class NodeFileSystem implements FileSystem {
	private readonly ignoreRules = new Map<string, RepositoryIgnore>();

	readFile(absPath: string): string | undefined {
		try {
			return readFileSync(absPath, "utf8");
		} catch {
			return undefined;
		}
	}

	stat(absPath: string): FileStat | undefined {
		try {
			const s = lstatSync(absPath);
			if (s.isSymbolicLink()) return undefined;
			return { mtimeMs: s.mtimeMs, size: s.size };
		} catch {
			return undefined;
		}
	}

	exists(absPath: string): boolean {
		return existsSync(absPath);
	}

	refreshIgnoreRules(root: string): void {
		this.ignoreRules.set(root, new RepositoryIgnore(root));
	}

	isIgnored(root: string, relativePath: string, directory = false): boolean {
		let rules = this.ignoreRules.get(root);
		if (!rules) {
			rules = new RepositoryIgnore(root);
			this.ignoreRules.set(root, rules);
		}
		return rules.ignores(relativePath, directory);
	}

	*walk(root: string): Iterable<string> {
		// A walk is a new filesystem snapshot. Re-read ignore files so repeated
		// syncs through one Indexer observe `.gitignore` edits.
		this.refreshIgnoreRules(root);
		const stack = [root];
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
				const relativePath = relative(root, full).replaceAll("\\", "/");
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
					if (!this.isIgnored(root, relativePath, true)) stack.push(full);
				} else if (stat.isFile() && !this.isIgnored(root, relativePath)) {
					yield full;
				}
			}
		}
	}
}
