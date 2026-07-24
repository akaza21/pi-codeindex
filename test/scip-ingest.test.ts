import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportScip, type Indexer, ingestScip, openIndex, type Store, scipAvailable } from "../src/engine/index.ts";
import { scipIndexType } from "../src/engine/scip/schema.ts";

const scipCount = (store: Store): number => store.allOccurrences().filter((o) => o.provenance === "scip").length;

describe.skipIf(!scipAvailable())("SCIP ingest", () => {
	let dir: string;
	let store: Store;
	let indexer: Indexer;
	let bytes: Uint8Array;

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "codeindex-ingest-"));
		writeFileSync(join(dir, "calc.ts"), "export class Calc { add(a, b) { return a + b; } }\n");
		writeFileSync(
			join(dir, "app.ts"),
			'import { Calc } from "./calc";\nexport function run() { return new Calc().add(1, 2); }\n',
		);
		const opened = openIndex({ root: dir, dbPath: join(dir, "i.db") });
		store = opened.store;
		indexer = opened.indexer;
		await indexer.sync();
		// Round-trip oracle: export our own index, then ingest it back.
		bytes = exportScip(store, { projectRoot: dir, repo: "demo" });
	});

	afterAll(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("maps SCIP references back onto our symbols as provenance:scip occurrences", () => {
		const monikers = new Set(store.allSymbols().map((s) => s.moniker));
		const occurrences = ingestScip(store.snapshot(), bytes);
		expect(occurrences.length).toBeGreaterThan(0);
		expect(occurrences.every((o) => o.provenance === "scip")).toBe(true);
		expect(occurrences.every((o) => monikers.has(o.symbol))).toBe(true); // every target is a real symbol
		expect(occurrences.some((o) => o.file === "app.ts")).toBe(true); // the `new Calc()` reference
		// One reference location binds to one target: no duplicate (file,range,symbol).
		const keys = occurrences.map((o) => `${o.file}:${o.range.join(",")}:${o.symbol}`);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it("surfaces ingested occurrences in queries, ranked by provenance", () => {
		store.replaceIngestedOccurrences(ingestScip(store.snapshot(), bytes));
		const hits = store.references("Calc", 20);
		expect(hits.some((h) => h.provenance === "scip")).toBe(true);
	});

	it("is authoritative — no heuristic occurrence remains at a scip-covered location, across re-sync", async () => {
		const key = (o: { file: string; range: readonly number[] }) => `${o.file}:${o.range.join(",")}`;
		const shadowed = (): unknown[] => {
			const all = store.allOccurrences();
			const scipKeys = new Set(all.filter((o) => o.provenance === "scip").map(key));
			return all.filter((o) => o.provenance !== "scip" && scipKeys.has(key(o)));
		};
		store.replaceIngestedOccurrences(ingestScip(store.snapshot(), bytes));
		expect(shadowed()).toEqual([]); // scip rows replace the heuristic rows at their locations
		await indexer.sync(); // a re-sync must not resurrect the shadowed heuristic rows
		expect(shadowed()).toEqual([]);
	});

	it("survives a resolver re-sync (a normal sync does not wipe scip rows)", async () => {
		store.replaceIngestedOccurrences(ingestScip(store.snapshot(), bytes));
		expect(scipCount(store)).toBeGreaterThan(0);
		await indexer.sync(); // no file changes
		expect(scipCount(store)).toBeGreaterThan(0);
	});

	it("is idempotent — re-ingesting replaces rather than duplicates", () => {
		store.replaceIngestedOccurrences(ingestScip(store.snapshot(), bytes));
		const first = scipCount(store);
		store.replaceIngestedOccurrences(ingestScip(store.snapshot(), bytes));
		expect(scipCount(store)).toBe(first);
	});

	it("skips occurrences whose symbol has no local definition (external deps)", () => {
		// A synthetic SCIP index: one reference to `external#` with no Definition occurrence for it.
		const Index = scipIndexType();
		const synthetic = Index.encode(
			Index.create({
				documents: [
					{
						relativePath: "ghost.ts",
						occurrences: [
							{
								symbol: "external#",
								symbolRoles: 0,
								singleLineRange: { line: 0, startCharacter: 0, endCharacter: 8 },
							},
						],
					},
				],
			}),
		).finish();
		expect(ingestScip(store.snapshot(), synthetic)).toEqual([]);
	});

	it("reads the deprecated packed range (older indexers emit no typed range)", () => {
		// `Calc` is the name token at calc.ts line 1, cols 13–17 (0-based) — a packed single-line
		// Definition range [line, startChar, endChar]; the reference uses a packed range too.
		const monikers = new Set(store.allSymbols().map((s) => s.moniker));
		const Index = scipIndexType();
		const packed = Index.encode(
			Index.create({
				documents: [
					{
						relativePath: "calc.ts",
						positionEncoding: 2,
						occurrences: [{ symbol: "calc#", symbolRoles: 1, range: [0, 13, 17] }],
					},
					{
						relativePath: "app.ts",
						positionEncoding: 2,
						occurrences: [{ symbol: "calc#", symbolRoles: 0, range: [1, 0, 4] }],
					},
				],
			}),
		).finish();
		const occurrences = ingestScip(store.snapshot(), packed);
		expect(occurrences).toHaveLength(1); // the reference (the definition is not re-emitted)
		expect(occurrences[0]?.file).toBe("app.ts");
		expect(monikers.has(occurrences[0]?.symbol ?? "")).toBe(true); // mapped to the real `Calc` moniker
	});

	it("decodes a multi-line typed range", () => {
		const calc = store.allSymbols().find((s) => s.name === "Calc");
		const nameRange = (calc?.nameRange ?? calc?.range) as [number, number, number, number];
		const Index = scipIndexType();
		const multi = Index.encode(
			Index.create({
				documents: [
					{
						relativePath: "calc.ts",
						positionEncoding: 2,
						occurrences: [
							{
								symbol: "calc#",
								symbolRoles: 1,
								singleLineRange: {
									line: nameRange[0] - 1,
									startCharacter: nameRange[1],
									endCharacter: nameRange[3],
								},
							},
						],
					},
					{
						relativePath: "app.ts",
						positionEncoding: 2,
						occurrences: [
							{
								symbol: "calc#",
								symbolRoles: 0,
								multiLineRange: { startLine: 0, startCharacter: 5, endLine: 1, endCharacter: 3 },
							},
						],
					},
				],
			}),
		).finish();
		const occurrences = ingestScip(store.snapshot(), multi);
		expect(occurrences).toHaveLength(1);
		expect(occurrences[0]?.range).toEqual([1, 5, 2, 3]);
	});

	it.each([
		{ label: "UTF-8 byte", positionEncoding: 1, embedText: false },
		{ label: "UTF-32 code-point", positionEncoding: 3, embedText: true },
	])("maps $label positions after non-ASCII text", async ({ positionEncoding, embedText }) => {
		const unicodeDir = mkdtempSync(join(tmpdir(), "codeindex-scip-unicode-"));
		const source = 'const icon = "💡"; export function tail() {}\nconst other = "💡"; tail();\n';
		writeFileSync(join(unicodeDir, "unicode.ts"), source);
		const opened = openIndex({ root: unicodeDir, dbPath: join(unicodeDir, "i.db") });
		try {
			await opened.indexer.sync();
			const tail = opened.store.allSymbols().find((symbol) => symbol.name === "tail");
			const definition = tail?.nameRange as [number, number, number, number];
			const lines = source.split("\n");
			const referenceStart = lines[1]?.indexOf("tail") ?? -1;
			const encodeColumn = (line: string, column: number): number =>
				positionEncoding === 1
					? Buffer.byteLength(line.slice(0, column), "utf8")
					: [...line.slice(0, column)].length;
			const Index = scipIndexType();
			const document = {
				relativePath: "unicode.ts",
				positionEncoding,
				...(embedText ? { text: source } : {}),
				occurrences: [
					{
						symbol: "pkg tail().",
						symbolRoles: 1,
						singleLineRange: {
							line: definition[0] - 1,
							startCharacter: encodeColumn(lines[0] as string, definition[1]),
							endCharacter: encodeColumn(lines[0] as string, definition[3]),
						},
					},
					{
						symbol: "pkg tail().",
						symbolRoles: 0,
						singleLineRange: {
							line: 1,
							startCharacter: encodeColumn(lines[1] as string, referenceStart),
							endCharacter: encodeColumn(lines[1] as string, referenceStart + 4),
						},
					},
				],
			};
			const encoded = Index.encode(Index.create({ documents: [document] })).finish();
			const occurrences = ingestScip(
				opened.store.snapshot(),
				encoded,
				embedText ? {} : { readSource: () => source },
			);
			expect(occurrences).toHaveLength(1);
			expect(occurrences[0]).toMatchObject({
				symbol: tail?.moniker,
				file: "unicode.ts",
				range: [2, referenceStart, 2, referenceStart + 4],
			});
		} finally {
			opened.store.close();
			rmSync(unicodeDir, { recursive: true, force: true });
		}
	});

	it("removes a file's scip occurrences when the file is deleted", () => {
		store.replaceIngestedOccurrences(ingestScip(store.snapshot(), bytes));
		expect(scipCount(store)).toBeGreaterThan(0); // the scip reference lives in app.ts
		store.deleteFile("app.ts");
		expect(store.allOccurrences().some((o) => o.provenance === "scip" && o.file === "app.ts")).toBe(false);
	});
});

// Regression: when no SCIP rows exist, shadow suppression must be a no-op and must never
// delete heuristic occurrences (the fast-path guard must not silently drop rows).
describe("no SCIP ingested → suppression preserves all heuristic occurrences", () => {
	it("keeps every resolver occurrence across a re-sync when no scip rows exist", async () => {
		const dir = mkdtempSync(join(tmpdir(), "codeindex-nosup-"));
		writeFileSync(join(dir, "m.ts"), "export function add(a, b) { return a + b; }\n");
		writeFileSync(join(dir, "u.ts"), 'import { add } from "./m";\nexport function run() { return add(1, 2); }\n');
		const { store, indexer } = openIndex({ root: dir, dbPath: join(dir, "i.db") });
		try {
			await indexer.sync();
			const before = store.status().occurrences;
			expect(before).toBeGreaterThan(0);
			expect(store.allOccurrences().every((o) => o.provenance !== "scip")).toBe(true);
			await indexer.sync(); // re-sync calls replaceOccurrences → suppressShadowedByScip (guarded)
			expect(store.status().occurrences).toBe(before); // nothing suppressed
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// Regression: a SCIP definition is mapped to our symbol ONLY on an exact name-token match, not by
// containment. A global symbol whose definition sits INSIDE one of our symbols (an interface method
// spec, an attr-generated accessor) must NOT map to that enclosing symbol — otherwise every call to
// it would resolve to its container. This is also the executable encoding ceiling: a def column
// that does not land on a name token (e.g. a UTF-8-emitter offset on a non-ASCII-preceded line) is
// dropped, never rebound to a wrong target.
describe.skipIf(!scipAvailable())("SCIP definitions map by exact name token, never to the container", () => {
	it("drops a global whose def is inside a symbol's body; keeps one whose def is the symbol's name", async () => {
		const dir = mkdtempSync(join(tmpdir(), "codeindex-exact-"));
		writeFileSync(join(dir, "m.ts"), "export function real() { return 1; }\nreal();\n");
		const { store, indexer } = openIndex({ root: dir, dbPath: join(dir, "i.db") });
		try {
			await indexer.sync();
			const real = store.allSymbols().find((s) => s.name === "real");
			const nr = (real?.nameRange ?? real?.range) as [number, number, number, number];
			const Index = scipIndexType();
			const bytes = Index.encode(
				Index.create({
					documents: [
						{
							relativePath: "m.ts",
							positionEncoding: 2,
							occurrences: [
								// AT real's name token -> maps to real.
								{
									symbol: "pkg keep#",
									symbolRoles: 1,
									singleLineRange: { line: nr[0] - 1, startCharacter: nr[1], endCharacter: nr[3] },
								},
								{
									symbol: "pkg keep#",
									symbolRoles: 0,
									singleLineRange: { line: 1, startCharacter: 0, endCharacter: 4 },
								},
								// INSIDE real's body (col 25), not any symbol's name token -> must NOT map. Its ref is
								// at a DISTINCT location so the buggy (containment) path would emit a 2nd row here.
								{
									symbol: "pkg drop#",
									symbolRoles: 1,
									singleLineRange: { line: nr[0] - 1, startCharacter: 25, endCharacter: 31 },
								},
								{
									symbol: "pkg drop#",
									symbolRoles: 0,
									singleLineRange: { line: 1, startCharacter: 6, endCharacter: 10 },
								},
							],
						},
					],
				}),
			).finish();
			const occ = ingestScip(store.snapshot(), bytes);
			// `keep` (def at real's name token) maps; `drop` (def inside the body) is not rebound to the
			// container -> exactly one row. Old containment behaviour emitted a 2nd row for `drop`.
			expect(occ).toHaveLength(1);
			expect(occ[0]?.symbol).toBe(real?.moniker);
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// SCIP `local <id>` symbols are not indexed declarations. Mapping them by containment would create
// references to the enclosing symbol, so ingest skips locals and retains global symbols.
describe.skipIf(!scipAvailable())("SCIP local symbols are skipped; globals still ingested", () => {
	it("skips `local` reads (never maps them to the enclosing symbol) but keeps globals", async () => {
		const dir = mkdtempSync(join(tmpdir(), "codeindex-local-"));
		writeFileSync(join(dir, "a.ts"), "export function aaa() {}\naaa();\n");
		writeFileSync(join(dir, "u.ts"), 'import { aaa } from "./a";\nexport function run() { aaa(); }\n');
		const { store, indexer } = openIndex({ root: dir, dbPath: join(dir, "i.db") });
		try {
			await indexer.sync();
			const aaa = store.allSymbols().find((s) => s.name === "aaa");
			const nr = (aaa?.nameRange ?? aaa?.range) as [number, number, number, number];
			const Index = scipIndexType();
			// A GLOBAL symbol (def in a.ts, ref in u.ts) plus a LOCAL read in a.ts whose "definition"
			// sits on aaa's line — a buggy ingest would map the local read to aaa.
			const bytes = Index.encode(
				Index.create({
					documents: [
						{
							relativePath: "a.ts",
							positionEncoding: 2,
							occurrences: [
								{
									symbol: "pkg aaa#",
									symbolRoles: 1,
									singleLineRange: { line: nr[0] - 1, startCharacter: nr[1], endCharacter: nr[3] },
								},
								{
									symbol: "local 5",
									symbolRoles: 1,
									singleLineRange: { line: nr[0] - 1, startCharacter: nr[1], endCharacter: nr[3] },
								},
								{
									symbol: "local 5",
									symbolRoles: 0,
									singleLineRange: { line: 1, startCharacter: 0, endCharacter: 3 },
								},
							],
						},
						{
							relativePath: "u.ts",
							positionEncoding: 2,
							occurrences: [
								{
									symbol: "pkg aaa#",
									symbolRoles: 0,
									singleLineRange: { line: 1, startCharacter: 25, endCharacter: 28 },
								},
							],
						},
					],
				}),
			).finish();
			const occ = ingestScip(store.snapshot(), bytes);
			// Exactly the one global ref (u.ts) is ingested; the local read (a.ts) is skipped entirely.
			expect(occ).toHaveLength(1);
			expect(occ[0]).toMatchObject({ file: "u.ts", symbol: aaa?.moniker });
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
