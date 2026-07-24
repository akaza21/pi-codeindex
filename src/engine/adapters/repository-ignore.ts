/**
 * Repository-local ignore rules used by the filesystem adapter.
 *
 * Git applies each `.gitignore` relative to the directory that contains it, with
 * deeper files taking precedence. We keep one matcher per directory instead of
 * rewriting patterns, which preserves anchored patterns and negations.
 */

import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ignore, { type Ignore } from "ignore";

interface RuleSet {
	baseParts: readonly string[];
	matcher: Ignore;
}

export class RepositoryIgnore {
	private readonly root: string;
	private readonly rulesByDirectory = new Map<string, RuleSet | null>();
	private readonly nestedRepositoryByDirectory = new Map<string, boolean>();

	constructor(root: string) {
		this.root = root;
	}

	/**
	 * Whether a repo-relative file or directory is excluded by `.gitignore` or
	 * crosses into a nested Git repository. Callers enforce hard safety exclusions
	 * (hidden paths, symlinks, generated/build directories) separately.
	 */
	ignores(relativePath: string, directory = false): boolean {
		const parts = normalizeParts(relativePath);
		// Incremental paths are expected to be repository-relative. Fail closed if
		// an adapter or caller ever supplies an absolute/escaping path.
		if (!parts) return true;
		if (parts.length === 0) return false;

		const active: RuleSet[] = [];
		const rootRules = this.rulesFor([]);
		if (rootRules) active.push(rootRules);

		// A lower-level .gitignore is read only after its directory is admitted.
		// Git cannot re-include a descendant when an ancestor directory itself is
		// excluded, so stop before loading rules from an excluded directory.
		const parentDepth = directory ? parts.length : parts.length - 1;
		for (let depth = 1; depth <= parentDepth; depth++) {
			const ancestor = parts.slice(0, depth);
			if (this.isNestedRepository(ancestor)) return true;
			if (evaluate(active, ancestor, true)) return true;
			const nested = this.rulesFor(ancestor);
			if (nested) active.push(nested);
		}

		return evaluate(active, parts, directory);
	}

	private rulesFor(directoryParts: readonly string[]): RuleSet | null {
		const key = directoryParts.join("/");
		const cached = this.rulesByDirectory.get(key);
		if (cached !== undefined || this.rulesByDirectory.has(key)) return cached ?? null;

		let source: string;
		try {
			const path = join(this.root, ...directoryParts, ".gitignore");
			const stat = lstatSync(path);
			if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("not a regular ignore file");
			source = readFileSync(path, "utf8");
		} catch {
			this.rulesByDirectory.set(key, null);
			return null;
		}
		const rules = {
			baseParts: [...directoryParts],
			// Git patterns are case-sensitive unless a repository explicitly sets
			// core.ignoreCase. Avoid silently changing Linux semantics.
			matcher: ignore({ ignorecase: false }).add(source),
		};
		this.rulesByDirectory.set(key, rules);
		return rules;
	}

	private isNestedRepository(directoryParts: readonly string[]): boolean {
		const key = directoryParts.join("/");
		const cached = this.nestedRepositoryByDirectory.get(key);
		if (cached !== undefined) return cached;
		try {
			lstatSync(join(this.root, ...directoryParts, ".git"));
			this.nestedRepositoryByDirectory.set(key, true);
			return true;
		} catch {
			this.nestedRepositoryByDirectory.set(key, false);
			return false;
		}
	}
}

function evaluate(rules: readonly RuleSet[], pathParts: readonly string[], directory: boolean): boolean {
	let ignored = false;
	for (const ruleSet of rules) {
		const candidateParts = pathParts.slice(ruleSet.baseParts.length);
		if (candidateParts.length === 0) continue;
		const candidate = `${candidateParts.join("/")}${directory ? "/" : ""}`;
		const result = ruleSet.matcher.test(candidate);
		if (result.ignored) ignored = true;
		else if (result.unignored) ignored = false;
	}
	return ignored;
}

function normalizeParts(path: string): string[] | undefined {
	const normalized = path.replaceAll("\\", "/");
	if (normalized.startsWith("/") || /^[a-z]:\//i.test(normalized)) return undefined;
	const parts = normalized.split("/").filter((part) => part !== "" && part !== ".");
	return parts.includes("..") ? undefined : parts;
}
