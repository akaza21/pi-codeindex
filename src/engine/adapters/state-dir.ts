/**
 * Repo-local state directory `<repo>/.codeindex/`, self-ignoring so the index DB never
 * shows up as untracked VCS noise and stays out of any global tool config.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const STATE_DIR_NAME = ".codeindex";

export function ensureStateDir(root: string): string {
	const dir = join(root, STATE_DIR_NAME);
	mkdirSync(dir, { recursive: true });
	const ignorePath = join(dir, ".gitignore");
	if (!existsSync(ignorePath)) writeFileSync(ignorePath, "*\n");
	return dir;
}

export function defaultDbPath(root: string): string {
	return join(ensureStateDir(root), "index.db");
}
