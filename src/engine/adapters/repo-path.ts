import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** Canonical existing repository root used as the filesystem trust boundary. */
export function canonicalRepositoryRoot(root: string): string {
	return realpathSync(resolve(root));
}

/** Whether a stored path is a canonical repository-relative path. */
export function isSafeRepoRelativePath(path: string): boolean {
	if (!path || path.includes("\0") || isAbsolute(path) || /^[a-z]:[\\/]/i.test(path)) return false;
	const normalized = path.replaceAll("\\", "/");
	if (normalized.startsWith("//")) return false;
	const parts = normalized.split("/");
	if (parts.some((part) => part === "" || part === "." || part === "..")) return false;
	return normalized === path;
}

/**
 * Resolve an existing path only when its real target remains beneath `canonicalRoot`.
 * Resolving both sides prevents `..`, prefix-collision, and symlink escapes.
 */
export function existingPathWithinRoot(
	canonicalRoot: string,
	candidate: string,
	rejectLeafSymlink = false,
): string | undefined {
	try {
		const canonical = realpathSync(resolve(candidate));
		const rel = relative(canonicalRoot, canonical);
		if (rel !== "" && (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`))) return undefined;
		if (rejectLeafSymlink && lstatSync(resolve(candidate)).isSymbolicLink()) return undefined;
		return canonical;
	} catch {
		return undefined;
	}
}

/** Read one canonical repository-relative file without following a path outside the root. */
export function readRepoFile(root: string, relativePath: string): string | undefined {
	if (!isSafeRepoRelativePath(relativePath)) return undefined;
	try {
		const canonicalRoot = canonicalRepositoryRoot(root);
		const path = existingPathWithinRoot(canonicalRoot, resolve(canonicalRoot, relativePath), true);
		return path ? readFileSync(path, "utf8") : undefined;
	} catch {
		return undefined;
	}
}
