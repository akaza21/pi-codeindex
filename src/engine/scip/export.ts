/**
 * SCIP index export (opt-in interop). Serialises the index to the Sourcegraph Code
 * Intelligence Protocol so it can be consumed by SCIP tooling. `protobufjs` is an optional
 * dependency — present only when this feature is used — so the SCIP message schema is
 * declared here programmatically (field numbers taken from scip.proto) rather than
 * vendoring the full `.proto`. If `protobufjs` is absent, export fails with a clear error.
 *
 * Each indexed declaration becomes a Definition occurrence plus a SymbolInformation; each
 * resolved reference becomes a (non-definition) occurrence. Occurrences whose target is not
 * a locally-indexed symbol (external/unresolved) are omitted. Columns come from tree-sitter,
 * which counts UTF-16 code units, so every document declares that position encoding.
 */

import { pathToFileURL } from "node:url";
import type { Range, Store } from "../ports.ts";
import { scipIndexType } from "./schema.ts";
import { scipSymbol } from "./symbol.ts";

export { scipAvailable } from "./schema.ts";

export interface ScipExportOptions {
	/** Absolute repo root (emitted as the SCIP `project_root` file URL). */
	projectRoot: string;
	/** Repo identifier used as the SCIP package name. */
	repo: string;
	toolName?: string;
	toolVersion?: string;
}

const SYMBOL_ROLE_DEFINITION = 0x1;
const TEXT_ENCODING_UTF8 = 1;
const POSITION_ENCODING_UTF16 = 2; // tree-sitter columns are UTF-16 code-unit offsets

export function exportScip(store: Store, opts: ScipExportOptions): Uint8Array {
	const Index = scipIndexType();
	const symbols = store.allSymbols();
	const symbolOf = new Map<string, string>();
	for (const symbol of symbols) {
		symbolOf.set(
			symbol.moniker,
			scipSymbol({
				repo: opts.repo,
				file: symbol.file,
				name: symbol.name,
				kind: symbol.kind,
				ownerType: symbol.ownerType,
			}),
		);
	}
	const languageOf = new Map(store.allFiles().map((file) => [file.path, file.lang]));

	interface DocumentBuffer {
		occurrences: object[];
		symbols: object[];
	}
	const byFile = new Map<string, DocumentBuffer>();
	const documentFor = (file: string): DocumentBuffer => {
		let doc = byFile.get(file);
		if (!doc) {
			doc = { occurrences: [], symbols: [] };
			byFile.set(file, doc);
		}
		return doc;
	};

	for (const symbol of symbols) {
		const scip = symbolOf.get(symbol.moniker);
		if (!scip) continue;
		const doc = documentFor(symbol.file);
		// A definition occurrence marks the name token (for rename/highlight), not the whole declaration.
		doc.occurrences.push(occurrence(symbol.nameRange ?? symbol.range, scip, SYMBOL_ROLE_DEFINITION));
		doc.symbols.push({ symbol: scip, displayName: symbol.name });
	}
	for (const ref of store.allOccurrences()) {
		const scip = symbolOf.get(ref.symbol);
		if (!scip) continue; // target is not a locally-indexed symbol — omit
		documentFor(ref.file).occurrences.push(occurrence(ref.range, scip, 0));
	}

	const documents = [...byFile.keys()].sort().map((file) => {
		const doc = documentFor(file);
		return {
			relativePath: file,
			language: languageOf.get(file) ?? "",
			positionEncoding: POSITION_ENCODING_UTF16,
			occurrences: doc.occurrences,
			symbols: doc.symbols,
		};
	});

	const message = Index.create({
		metadata: {
			toolInfo: { name: opts.toolName ?? "pi-codeindex", version: opts.toolVersion ?? "" },
			projectRoot: directoryUrl(opts.projectRoot),
			textDocumentEncoding: TEXT_ENCODING_UTF8,
		},
		documents,
	});
	return Index.encode(message).finish();
}

/** SCIP `project_root` denotes a directory, so emit a file URL with a trailing slash. */
function directoryUrl(absolutePath: string): string {
	const url = pathToFileURL(absolutePath).toString();
	return url.endsWith("/") ? url : `${url}/`;
}

/**
 * Build a SCIP occurrence. Our range is `[1-based line, 0-based col, …]`; SCIP lines are
 * 0-based. We emit both the typed range (the current form) and the deprecated packed `range`
 * (`[line, startChar, endChar]` single-line / `[startLine, startChar, endLine, endChar]`
 * multi-line) so both new and old consumers can read it.
 */
function occurrence(range: Range, symbol: string, symbolRoles: number): object {
	const startLine = range[0] - 1;
	const startChar = range[1];
	const endLine = range[2] - 1;
	const endChar = range[3];
	if (startLine === endLine) {
		return {
			symbol,
			symbolRoles,
			range: [startLine, startChar, endChar],
			singleLineRange: { line: startLine, startCharacter: startChar, endCharacter: endChar },
		};
	}
	return {
		symbol,
		symbolRoles,
		range: [startLine, startChar, endLine, endChar],
		multiLineRange: { startLine, startCharacter: startChar, endLine, endCharacter: endChar },
	};
}
