import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type OccurrenceRecord, type OpenedIndex, openIndex, type Store } from "../src/engine/index.ts";

// A scoped incremental sync (`only`) must produce a byte-equivalent (normalized) occurrence set to
// a fresh full rebuild of the same final file contents. Equivalence is asserted
// against the store's own `allOccurrences()` oracle, never argued in prose.

type Files = Record<string, string>;
/** A string replaces the file's contents; null deletes it. */
type Edits = Record<string, string | null>;

const opened: OpenedIndex[] = [];
const dirs: string[] = [];

function build(files: Files): { handle: OpenedIndex; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "codeindex-scoped-"));
	dirs.push(dir);
	for (const [name, body] of Object.entries(files)) {
		const full = join(dir, name);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, body);
	}
	const handle = openIndex({ root: dir, dbPath: join(dir, "i.db") });
	opened.push(handle);
	return { handle, dir };
}

afterEach(() => {
	for (const h of opened) h.store.close();
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	opened.length = 0;
	dirs.length = 0;
});

/** Stable JSON key over the equivalence tuple (row ids already stripped by allOccurrences). */
function normalize(occ: OccurrenceRecord[]): string[] {
	return occ
		.map((o) => JSON.stringify([o.symbol, o.file, o.range, o.role, o.enclosing ?? null, o.provenance, o.confidence]))
		.sort();
}

/** Count which rebuild path the incremental sync takes (reset after the initial full sync). */
function spy(store: Store): { global: number; scoped: number; affected: number[] } {
	const counts = { global: 0, scoped: 0, affected: [] as number[] };
	const g = store.replaceOccurrences.bind(store);
	const s = store.replaceOccurrencesForFiles.bind(store);
	store.replaceOccurrences = (occ) => {
		counts.global++;
		g(occ);
	};
	store.replaceOccurrencesForFiles = (ids, occ) => {
		counts.scoped++;
		counts.affected.push(ids.size);
		s(ids, occ);
	};
	return counts;
}

interface Options {
	/** Assert the incremental sync fell back to the global rebuild (fanned to every file). */
	expectGlobal?: boolean;
	/** Assert the incremental sync took the scoped path. */
	expectScoped?: boolean;
	/** Exact affected-file count for the final scoped rebuild. */
	expectAffected?: number;
	/** Mutate the store just before the `only` sync (e.g. simulate an interrupted rebuild). */
	beforeOnly?: (store: Store) => void;
}

async function expectEquivalent(initial: Files, edits: Edits, only: string[], opts: Options = {}): Promise<void> {
	// A — incremental: full sync, apply edits, then scoped `only` sync.
	const a = build(initial);
	await a.handle.indexer.sync();
	for (const [rel, content] of Object.entries(edits)) {
		if (content === null) unlinkSync(join(a.dir, rel));
		else writeFileSync(join(a.dir, rel), content);
	}
	opts.beforeOnly?.(a.handle.store);
	const counts = spy(a.handle.store);
	await a.handle.indexer.sync({ only });
	const incremental = normalize(a.handle.store.allOccurrences());

	// B — fresh full rebuild of the FINAL contents.
	const final: Files = { ...initial };
	for (const [rel, content] of Object.entries(edits)) {
		if (content === null) delete final[rel];
		else final[rel] = content;
	}
	const b = build(final);
	await b.handle.indexer.sync();
	const full = normalize(b.handle.store.allOccurrences());

	expect(incremental).toEqual(full);
	if (opts.expectGlobal) {
		expect(counts.global).toBeGreaterThanOrEqual(1);
		expect(counts.scoped).toBe(0);
	}
	if (opts.expectScoped) {
		expect(counts.scoped).toBeGreaterThanOrEqual(1);
		expect(counts.global).toBe(0);
	}
	if (opts.expectAffected !== undefined) expect(counts.affected.at(-1)).toBe(opts.expectAffected);
}

describe("scoped incremental sync equivalence", () => {
	it("1. body-only edit (add a call, no declaration change)", async () => {
		await expectEquivalent(
			{
				"callee.ts": "export function target() {}\n",
				"caller.ts": 'import { target } from "./callee";\nexport function run() { target(); }\n',
			},
			{ "caller.ts": 'import { target } from "./callee";\nexport function run() { target(); target(); }\n' },
			["caller.ts"],
			{ expectScoped: true, expectAffected: 1 },
		);
	});

	it("1b. body-only callee edit preserves incoming edges and does not fan out to callers", async () => {
		await expectEquivalent(
			{
				"callee.ts": "export function target() { return 1; }\n",
				"a.ts": 'import { target } from "./callee"; export function a() { return target(); }\n',
				"b.ts": 'import { target } from "./callee"; export function b() { return target(); }\n',
			},
			{ "callee.ts": "export function target() { return 2; }\n" },
			["callee.ts"],
			{ expectScoped: true, expectAffected: 1 },
		);
	});

	it("2. add a declaration a name-fallback reference begins resolving to", async () => {
		await expectEquivalent(
			{ "b.ts": "export function run() { widget(); }\n" },
			{ "a.ts": "export function widget() {}\n" },
			["a.ts"],
		);
	});

	it("3. delete a declaration; its dependents lose the edge", async () => {
		await expectEquivalent(
			{ "a.ts": "export function widget() {}\n", "b.ts": "export function run() { widget(); }\n" },
			{ "a.ts": null },
			["a.ts"],
		);
	});

	it("4. rename a declaration; old-name refs drop, new-name refs bind", async () => {
		await expectEquivalent(
			{
				"a.ts": "export function widget() {}\n",
				"b.ts": "export function run() { widget(); }\n",
				"c.ts": "export function go() { gadget(); }\n",
			},
			{ "a.ts": "export function gadget() {}\n" },
			["a.ts"],
		);
	});

	it("5. add a duplicate same-name target (2 -> 3); confidence resplits 1/N", async () => {
		await expectEquivalent(
			{
				"a.ts": "export function dup() {}\n",
				"b.ts": "export function dup() {}\n",
				"caller.ts": "export function run() { dup(); }\n",
			},
			{ "c.ts": "export function dup() {}\n" },
			["c.ts"],
		);
	});

	it("6a. crossing the fan-out cap (8 -> 9) drops all name-only edges", async () => {
		const dups: Files = { "caller.ts": "export function run() { dup(); }\n" };
		for (let i = 0; i < 8; i++) dups[`d${i}.ts`] = "export function dup() {}\n";
		await expectEquivalent(dups, { "d8.ts": "export function dup() {}\n" }, ["d8.ts"]);
	});

	it("6b. dropping back under the cap (9 -> 8) makes the edges reappear", async () => {
		const dups: Files = { "caller.ts": "export function run() { dup(); }\n" };
		for (let i = 0; i < 9; i++) dups[`d${i}.ts`] = "export function dup() {}\n";
		await expectEquivalent(dups, { "d8.ts": null }, ["d8.ts"]);
	});

	it("7a. change an import source to a different module; the reference rebinds", async () => {
		await expectEquivalent(
			{
				"x.ts": "export function foo() {}\n",
				"y.ts": "export function foo() {}\n",
				"caller.ts": 'import { foo } from "./x";\nexport function run() { foo(); }\n',
			},
			{ "caller.ts": 'import { foo } from "./y";\nexport function run() { foo(); }\n' },
			["caller.ts"],
			{ expectScoped: true },
		);
	});

	it("7b. an aliased import newly resolves when its target file is added", async () => {
		await expectEquivalent(
			{ "caller.ts": 'import { foo as f } from "./y";\nexport function run() { f(); }\n' },
			{ "y.ts": "export function foo() {}\n" },
			["y.ts"],
		);
	});

	it("8a. re-export rename: editing the upstream target rebinds the importer (reverse-dependency)", async () => {
		await expectEquivalent(
			{
				"y.ts": "export function foo() {}\n",
				"barrel.ts": 'export { foo as bar } from "./y";\n',
				"app.ts": 'import { bar } from "./barrel";\nexport function run() { bar(); }\n',
			},
			{ "y.ts": "export function gadget() {}\n" },
			["y.ts"],
		);
	});

	it("8b. re-export rename introduced in the barrel makes the importer resolve", async () => {
		await expectEquivalent(
			{
				"y.ts": "export function foo() {}\n",
				"barrel.ts": 'export { foo } from "./y";\n',
				"app.ts": 'import { bar } from "./barrel";\nexport function run() { bar(); }\n',
			},
			{ "barrel.ts": 'export { foo as bar } from "./y";\n' },
			["barrel.ts"],
		);
	});

	it("8c. a dangling renamed re-export going live through an unchanged barrel forces a global rebuild", async () => {
		await expectEquivalent(
			{
				"y.ts": "export function other() {}\n",
				"barrel.ts": 'export { foo as bar } from "./y";\n',
				"app.ts": 'import { bar } from "./barrel";\nexport function run() { bar(); }\n',
			},
			{ "y.ts": "export function other() {}\nexport function foo() {}\n" },
			["y.ts"],
			{ expectGlobal: true },
		);
	});

	it("9a. adding an inherited member re-dispatches this.m() in a subclass (scoped)", async () => {
		await expectEquivalent(
			{
				"base.ts": "export class Base {}\n",
				"sub.ts": 'import { Base } from "./base";\nexport class Sub extends Base { run() { this.greet(); } }\n',
			},
			{ "base.ts": "export class Base { greet() {} }\n" },
			["base.ts"],
			{ expectScoped: true },
		);
	});

	it("9b. swapping a mid-chain extends target forces a global rebuild", async () => {
		await expectEquivalent(
			{
				"grandbase.ts": "export class GrandBase { deep() {} }\n",
				"otherbase.ts": "export class OtherBase { deep() {} }\n",
				"midbase.ts": 'import { GrandBase } from "./grandbase";\nexport class MidBase extends GrandBase {}\n',
				"leaf.ts":
					'import { MidBase } from "./midbase";\nexport class Leaf extends MidBase { go() { this.deep(); } }\n',
			},
			{ "midbase.ts": 'import { OtherBase } from "./otherbase";\nexport class MidBase extends OtherBase {}\n' },
			["midbase.ts"],
			{ expectGlobal: true },
		);
	});

	it("10. adding an owner method binds a this.m() call in the same class", async () => {
		await expectEquivalent(
			{ "a.ts": "export class A { run() { this.m(); } }\n" },
			{ "a.ts": "export class A { m() {} run() { this.m(); } }\n" },
			["a.ts"],
			{ expectScoped: true },
		);
	});

	it("11. deleting an imported file drops its dependents' edges", async () => {
		await expectEquivalent(
			{
				"callee.ts": "export function target() {}\n",
				"caller.ts": 'import { target } from "./callee";\nexport function run() { target(); }\n',
			},
			{ "callee.ts": null },
			["callee.ts"],
		);
	});

	it("12. a tsconfig paths edit re-routes an alias and forces a global rebuild", async () => {
		await expectEquivalent(
			{
				"tsconfig.json": '{ "compilerOptions": { "baseUrl": ".", "paths": { "@app/*": ["v1/*"] } } }\n',
				"v1/util.ts": "export function aliased() {}\n",
				"v2/util.ts": "export function aliased() {}\n",
				"main.ts": 'import { aliased } from "@app/util";\nexport function run() { aliased(); }\n',
			},
			{ "tsconfig.json": '{ "compilerOptions": { "baseUrl": ".", "paths": { "@app/*": ["v2/*"] } } }\n' },
			["tsconfig.json"],
			{ expectGlobal: true },
		);
	});

	it("13. an interrupted (dirty) prior rebuild recovers via a global rebuild", async () => {
		await expectEquivalent(
			{
				"callee.ts": "export function target() {}\n",
				"caller.ts": 'import { target } from "./callee";\nexport function run() { target(); }\n',
			},
			{ "caller.ts": 'import { target } from "./callee";\nexport function run() { target(); target(); }\n' },
			["caller.ts"],
			{ expectGlobal: true, beforeOnly: (store) => store.setMeta("occurrences_dirty", "1") },
		);
	});

	it("14. a repeated unchanged incremental sync is idempotent", async () => {
		const { handle } = build({
			"callee.ts": "export function target() {}\n",
			"caller.ts": 'import { target } from "./callee";\nexport function run() { target(); }\n',
		});
		await handle.indexer.sync();
		const before = normalize(handle.store.allOccurrences());
		await handle.indexer.sync({ only: ["caller.ts"] });
		expect(normalize(handle.store.allOccurrences())).toEqual(before);
		await handle.indexer.sync();
		expect(normalize(handle.store.allOccurrences())).toEqual(before);
	});
});
