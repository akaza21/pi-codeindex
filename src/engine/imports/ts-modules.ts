/**
 * TS/JS module resolution: turn an import `source` string into the indexed file it refers to.
 * Shared by the syntactic resolver (binding imported references) and the import-cycle detector,
 * so the "how a module specifier maps to a file" logic lives in one place.
 */

import { dirname, extname, join, normalize } from "node:path";
import type { ImportSnapshot } from "../ports.ts";
import { applyTsLayout } from "./project-layout.ts";

/** Languages that use TS/JS module + re-export resolution (vs the per-language cross-file binders). */
export const ECMASCRIPT: ReadonlySet<string> = new Set(["typescript", "tsx", "javascript"]);

/** Extension candidates for relative-import resolution (language knowledge lives here, not the store). */
const TS_MODULE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/**
 * Resolve a TS/JS import `source` to a file id. Relative imports resolve against the importing
 * file; bare imports go through the project's tsconfig baseUrl/paths aliases.
 */
export function resolveTsModule(snapshot: ImportSnapshot, fromPath: string, source: string): number | undefined {
	const stems = source.startsWith(".")
		? [normalize(join(dirname(fromPath), source)).replaceAll("\\", "/")]
		: applyTsLayout(snapshot.projectLayout(), source);
	for (const raw of stems) {
		const id = lookupTsFile(snapshot, raw);
		if (id !== undefined) return id;
	}
	return undefined;
}

/** Try a module stem against the indexed files, expanding TS/JS extensions and `/index`. */
function lookupTsFile(snapshot: ImportSnapshot, raw: string): number | undefined {
	const extension = extname(raw);
	const stem = extension ? raw.slice(0, -extension.length) : raw;
	const candidates = new Set<string>([raw]);
	for (const ext of TS_MODULE_EXTENSIONS) {
		candidates.add(`${stem}${ext}`);
		candidates.add(`${raw}${ext}`);
		candidates.add(`${raw}/index${ext}`);
	}
	for (const candidate of candidates) {
		const id = snapshot.fileIdByPath(candidate);
		if (id !== undefined) return id;
	}
	return undefined;
}
