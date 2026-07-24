import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { exportScip, openIndex, scipAvailable, scipSymbol } from "../src/engine/index.ts";
import type { FileMeta, OccurrenceRecord, SymbolRecord } from "../src/engine/model/types.ts";
import type { Store } from "../src/engine/ports.ts";

const SCIP_PROTO = fileURLToPath(new URL("./fixtures/vendor/scip.proto", import.meta.url));

interface ScipIndex {
	metadata: { projectRoot: string };
	documents: {
		relativePath: string;
		language: string;
		positionEncoding: number;
		symbols: { symbol: string }[];
		occurrences: Occurrence[];
	}[];
}
interface Occurrence {
	symbol: string;
	symbolRoles: number;
	range: number[];
	singleLineRange?: { line: number; startCharacter: number; endCharacter: number };
	multiLineRange?: { startLine: number; startCharacter: number; endLine: number; endCharacter: number };
}

describe("SCIP symbol strings", () => {
	it("builds valid SCIP symbols with file + descriptor chain", () => {
		expect(scipSymbol({ repo: "demo", file: "src/a.ts", name: "Shape", kind: "class" })).toBe(
			"scip-codeindex . demo . `src/a.ts`/Shape#",
		);
		expect(scipSymbol({ repo: "demo", file: "src/a.ts", name: "area", kind: "method", ownerType: "Shape" })).toBe(
			"scip-codeindex . demo . `src/a.ts`/Shape#area().",
		);
		expect(scipSymbol({ repo: "demo", file: "a.ts", name: "helper", kind: "function" })).toBe(
			"scip-codeindex . demo . `a.ts`/helper().",
		);
	});

	it("escapes a space in the repo (package name) by doubling it, per SCIP grammar", () => {
		expect(scipSymbol({ repo: "my repo", file: "a.ts", name: "x", kind: "variable" })).toBe(
			"scip-codeindex . my  repo . `a.ts`/x.",
		);
	});

	it("uses the `.` placeholder for an empty package name", () => {
		expect(scipSymbol({ repo: "", file: "a.ts", name: "x", kind: "variable" })).toBe(
			"scip-codeindex . . . `a.ts`/x.",
		);
	});
});

/** Lazy-load protobufjs (optional dep) and resolve the `Index` type from the canonical schema. */
async function loadScipIndexType(): Promise<{ decode(buffer: Uint8Array): object }> {
	const protobuf = (await import("protobufjs")).default;
	return (await protobuf.load(SCIP_PROTO)).lookupType("scip.Index");
}

/** Minimal in-memory Store exposing only what `exportScip` reads — lets us craft wire edge cases. */
function fakeStore(symbols: SymbolRecord[], occurrences: OccurrenceRecord[], files: FileMeta[]): Store {
	return {
		allSymbols: () => symbols,
		allOccurrences: () => occurrences,
		allFiles: () => files,
	} as unknown as Store;
}

describe.skipIf(!scipAvailable())("SCIP index export", () => {
	it("emits a SCIP protobuf that decodes against the real scip.proto schema", async () => {
		// Decode with the canonical schema (vendored scip.proto) — an independent oracle that
		// validates our field numbers and wire types, not just a round-trip of our own schema.
		const Index = await loadScipIndexType();
		const dir = mkdtempSync(join(tmpdir(), "codeindex-scip-"));
		writeFileSync(
			join(dir, "shapes.ts"),
			"export class Shape { area() { return 0; } }\n" +
				"export class Circle extends Shape {}\n" +
				"export function run() { return new Shape().area(); }\n",
		);
		const { store, indexer } = openIndex({ root: dir, dbPath: join(dir, "i.db") });
		try {
			await indexer.sync();
			const decoded = Index.decode(exportScip(store, { projectRoot: dir, repo: "demo" })) as unknown as ScipIndex;

			expect(decoded.metadata.projectRoot.startsWith("file://")).toBe(true);
			const document = decoded.documents.find((d) => d.relativePath === "shapes.ts");
			expect(document).toBeDefined();
			expect(document?.language).toBe("typescript");
			expect(document?.positionEncoding).toBe(2); // UTF-16 (matches tree-sitter columns)

			const symbols = document?.symbols.map((s) => s.symbol) ?? [];
			expect(symbols).toContain("scip-codeindex . demo . `shapes.ts`/Shape#");
			expect(symbols).toContain("scip-codeindex . demo . `shapes.ts`/Shape#area().");

			// Definition occurrences land on the name tokens: `Shape` and `area` on line 1.
			const rangeOf = (suffix: string) =>
				(document?.occurrences ?? []).find((o) => (o.symbolRoles & 0x1) === 0x1 && o.symbol.endsWith(suffix))
					?.singleLineRange;
			expect(rangeOf("/Shape#")).toEqual({ line: 0, startCharacter: 13, endCharacter: 18 });
			expect(rangeOf("/Shape#area().")).toEqual({ line: 0, startCharacter: 21, endCharacter: 25 });

			expect(decoded.metadata.projectRoot.endsWith("/")).toBe(true); // project_root is a directory URL
			const occ = document?.occurrences ?? [];
			expect(occ.filter((o) => (o.symbolRoles & 0x1) === 0x1).length).toBe(symbols.length); // one Definition per symbol
			expect(occ.some((o) => o.symbolRoles === 0)).toBe(true); // and at least one reference
			// Every occurrence carries the current typed range AND the deprecated packed range, equivalently.
			for (const o of occ) {
				expect(o.singleLineRange).toBeDefined();
				expect(o.range).toEqual([
					o.singleLineRange?.line,
					o.singleLineRange?.startCharacter,
					o.singleLineRange?.endCharacter,
				]);
			}
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reports columns as UTF-16 code-unit offsets (matching position_encoding)", async () => {
		const Index = await loadScipIndexType();
		const dir = mkdtempSync(join(tmpdir(), "codeindex-scip-"));
		// `gem` holds a 4-byte/2-UTF-16-unit emoji, so `tail`'s column differs by encoding.
		const source = 'const gem = "\u{1F4A1}"; export function tail() {}\n';
		writeFileSync(join(dir, "emoji.ts"), source);
		const { store, indexer } = openIndex({ root: dir, dbPath: join(dir, "i.db") });
		try {
			await indexer.sync();
			const decoded = Index.decode(exportScip(store, { projectRoot: dir, repo: "demo" })) as unknown as ScipIndex;
			const tail = decoded.documents[0]?.occurrences.find((o) => o.symbol.endsWith("/tail()."));
			// The definition occurrence marks the name token, and String#indexOf counts UTF-16 units,
			// so the exported column must agree with it (the UTF-8 byte offset would be larger).
			expect(tail?.singleLineRange).toEqual({
				line: 0,
				startCharacter: source.indexOf("tail"),
				endCharacter: source.indexOf("tail") + "tail".length,
			});
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("emits multi-line ranges and drops references to non-indexed symbols", async () => {
		const Index = await loadScipIndexType();
		const symbol: SymbolRecord = {
			moniker: "m1",
			name: "Wide",
			kind: "class",
			file: "x.ts",
			range: [1, 4, 3, 8],
			nameRange: [1, 4, 3, 8],
			exported: true,
		};
		const external: OccurrenceRecord = {
			symbol: "not-indexed",
			file: "x.ts",
			range: [5, 0, 5, 6],
			role: "reference",
			provenance: "syntactic",
			confidence: 1,
		};
		const files: FileMeta[] = [{ id: 1, path: "x.ts", lang: "typescript", mtimeMs: 0, size: 0 }];
		const store = fakeStore([symbol], [external], files);
		const decoded = Index.decode(exportScip(store, { projectRoot: "/tmp/x", repo: "demo" })) as unknown as ScipIndex;

		const occ = decoded.documents[0]?.occurrences ?? [];
		expect(occ).toHaveLength(1); // the external reference is omitted; only the definition remains
		expect(occ[0]?.symbol).toBe("scip-codeindex . demo . `x.ts`/Wide#");
		expect(occ[0]?.singleLineRange ?? null).toBeNull(); // the typed range is multi-line, so this member is unset
		expect(occ[0]?.multiLineRange).toEqual({ startLine: 0, startCharacter: 4, endLine: 2, endCharacter: 8 });
		expect(occ[0]?.range).toEqual([0, 4, 2, 8]); // deprecated packed form, 4 ints for multi-line
	});

	it("writes a SCIP file from the standalone CLI", () => {
		const dir = mkdtempSync(join(tmpdir(), "codeindex-scip-cli-"));
		writeFileSync(join(dir, "a.ts"), "export class A { m() {} }\n");
		const out = join(dir, "index.scip");
		try {
			execFileSync(process.execPath, ["bin/codeindex.ts", "scip", out, dir], { stdio: "pipe" });
			expect(existsSync(out)).toBe(true);
			expect(statSync(out).size).toBeGreaterThan(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
