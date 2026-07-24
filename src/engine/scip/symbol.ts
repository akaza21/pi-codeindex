/**
 * SCIP symbol strings. A SCIP symbol is `<scheme> <package> <descriptors>`, where the
 * package is `<manager> <name> <version>` (a `.` stands in for an absent field). We emit
 * file-local symbols as: the repo as the package name, the repo-relative file as a leading
 * namespace descriptor, then the symbol's own descriptor chain — reusing the one descriptor
 * builder so the encoding matches our monikers exactly.
 *
 *   scip-codeindex . <repo> . `src/shapes.ts`/Shape#area().
 *
 * This is best-effort interop, not a certified SCIP indexer: there is no method
 * disambiguator, so two same-name overloads in one scope share a symbol (rare; SCIP
 * consumers merge them). Positions live on the occurrence, not the symbol.
 */

import { descriptor } from "../model/descriptor.ts";

const SCIP_SCHEME = "scip-codeindex";

interface ScipSymbolParts {
	repo: string;
	file: string;
	name: string;
	kind: string;
	ownerType?: string;
}

export function scipSymbol(parts: ScipSymbolParts): string {
	// package = manager(.) name(repo) version(.). Components are space-separated, so a space
	// inside one is escaped by doubling it (per the SCIP grammar); empty fields use `.`.
	const pkg = `. ${escapePackagePart(parts.repo)} .`;
	const fileDescriptor = descriptor(parts.file, "module");
	const owner = parts.ownerType ? descriptor(parts.ownerType, "class") : "";
	return `${SCIP_SCHEME} ${pkg} ${fileDescriptor}${owner}${descriptor(parts.name, parts.kind)}`;
}

function escapePackagePart(value: string): string {
	return value === "" ? "." : value.replaceAll(" ", "  ");
}
