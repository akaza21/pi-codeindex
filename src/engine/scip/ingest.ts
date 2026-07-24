/**
 * Decodes a compiler-produced SCIP index and maps its cross-file references to local monikers.
 * Definitions are matched by exact name-token location; symbols without a local definition and
 * document-local SCIP symbols are skipped. Per-document UTF-8/UTF-16/UTF-32 positions are
 * translated to local UTF-16 coordinates against the exact source text. Ambiguous or malformed
 * positions reduce coverage instead of binding a reference to an enclosing or unrelated symbol.
 *
 * Imported facts persist until re-imported. Re-indexing a changed file removes its imported facts;
 * remaining facts with obsolete monikers no longer join to current symbols.
 */

import type { OccurrenceRecord } from "../model/types.ts";
import type { ResolveSnapshot } from "../ports.ts";
import { createScipRangeDecoder, type ScipRangeDecoder } from "./position.ts";
import { scipIndexType } from "./schema.ts";

const SYMBOL_ROLE_DEFINITION = 0x1;
const SCIP_CONFIDENCE = 0.95;

// SCIP `local <id>` symbols represent document-local bindings. Local variables are not indexed as
// symbols here, so mapping them by containment would incorrectly target the enclosing declaration.
const LOCAL_SYMBOL_PREFIX = "local ";
function isLocalSymbol(symbol: string): boolean {
	return symbol.startsWith(LOCAL_SYMBOL_PREFIX);
}

interface DecodedOccurrence {
	symbol?: string;
	symbolRoles?: number;
	range?: number[];
	singleLineRange?: { line?: number; startCharacter?: number; endCharacter?: number } | null;
	multiLineRange?: { startLine?: number; startCharacter?: number; endLine?: number; endCharacter?: number } | null;
}
interface DecodedDocument {
	relativePath?: string;
	occurrences?: DecodedOccurrence[];
	text?: string;
	positionEncoding?: number;
}
interface DecodedIndex {
	documents?: DecodedDocument[];
}

export interface ScipIngestOptions {
	/** Read the indexed UTF-8 source for a repo-relative SCIP document path. */
	readSource?: (relativePath: string) => string | undefined;
}

/** Decode SCIP bytes and return occurrences mapped to local symbols. */
export function ingestScip(
	snapshot: ResolveSnapshot,
	bytes: Uint8Array,
	options: ScipIngestOptions = {},
): OccurrenceRecord[] {
	const index = scipIndexType().decode(bytes) as unknown as DecodedIndex;
	const documents = index.documents ?? [];
	const decoderOf = new Map<DecodedDocument, ScipRangeDecoder>();
	const decoderFor = (document: DecodedDocument): ScipRangeDecoder => {
		const cached = decoderOf.get(document);
		if (cached) return cached;
		const embedded = Object.hasOwn(document, "text") ? document.text : undefined;
		const canRead = document.relativePath !== undefined && snapshot.fileIdByPath(document.relativePath) !== undefined;
		const source = embedded ?? (canRead ? options.readSource?.(document.relativePath as string) : undefined);
		const decoder = createScipRangeDecoder(document.positionEncoding ?? 0, source);
		decoderOf.set(document, decoder);
		return decoder;
	};

	// Map each SCIP symbol through its definition location.
	const monikerOf = new Map<string, string>();
	for (const document of documents) {
		const file = document.relativePath;
		if (!file) continue;
		for (const occ of document.occurrences ?? []) {
			if (!occ.symbol || isLocalSymbol(occ.symbol) || !isDefinition(occ)) continue;
			const range = decoderFor(document)(occ);
			if (!range) continue;
			const moniker = snapshot.symbolAtName(file, range[0], range[1]);
			if (moniker) monikerOf.set(occ.symbol, moniker);
		}
	}

	// Convert non-definition occurrences of locally defined symbols to references.
	// Dedup by (file, range, target): a source may list the same reference more than once, and one
	// reference location binds to exactly one symbol — duplicate rows would only add query noise.
	const occurrences: OccurrenceRecord[] = [];
	const seen = new Set<string>();
	for (const document of documents) {
		const file = document.relativePath;
		if (!file) continue;
		for (const occ of document.occurrences ?? []) {
			if (!occ.symbol || isLocalSymbol(occ.symbol) || isDefinition(occ)) continue;
			const moniker = monikerOf.get(occ.symbol);
			if (!moniker) continue; // external / not locally defined
			const range = decoderFor(document)(occ);
			if (!range) continue;
			const dedupKey = `${file}:${range.join(",")}:${moniker}`;
			if (seen.has(dedupKey)) continue;
			seen.add(dedupKey);
			const enclosing = snapshot.symbolAt(file, range[0], range[1]);
			occurrences.push({
				symbol: moniker,
				file,
				range,
				role: "reference",
				...(enclosing ? { enclosing } : {}),
				provenance: "scip",
				confidence: SCIP_CONFIDENCE,
			});
		}
	}
	return occurrences;
}

function isDefinition(occ: DecodedOccurrence): boolean {
	return ((occ.symbolRoles ?? 0) & SYMBOL_ROLE_DEFINITION) !== 0;
}
