/**
 * Git repo boundary detection. A directory containing `.git` (dir or file — covers
 * worktrees/submodules) is a repo root.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

export function isRepoRoot(dir: string): boolean {
	return existsSync(join(dir, ".git"));
}

/** Nearest ancestor (including cwd) that is a git repo root, or undefined. */
export function enclosingRepoRoot(cwd: string): string | undefined {
	let dir = resolve(cwd);
	while (true) {
		if (isRepoRoot(dir)) return dir;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/**
 * Main repo root shared by linked worktrees. A linked worktree has a `.git` FILE whose
 * `gitdir:` points at `<main>/.git/worktrees/<name>`; worktrees of one repo hold
 * near-identical content and must be deduped in fan-out. Submodules (gitdir under
 * `.git/modules/`) keep their own identity.
 */
export function mainRepoRoot(repoRoot: string): { mainRoot: string; isWorktree: boolean } {
	const root = resolve(repoRoot);
	try {
		const gitPath = join(root, ".git");
		if (statSync(gitPath).isFile()) {
			const match = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(gitPath, "utf8"));
			if (match?.[1]) {
				const gitdir = resolve(root, match[1].trim());
				const marker = `${sep}.git${sep}worktrees${sep}`;
				const idx = gitdir.indexOf(marker);
				if (idx !== -1) return { mainRoot: gitdir.slice(0, idx), isWorktree: true };
			}
		}
	} catch {}
	return { mainRoot: root, isWorktree: false };
}
