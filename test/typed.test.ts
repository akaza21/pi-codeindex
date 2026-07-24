import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { openIndex, type ResolveSnapshot, type Store } from "../src/engine/index.ts";
import { TypedResolver } from "../src/engine/resolve/l3-typed.ts";
import { TsTypeService } from "../src/engine/resolve/ts-service.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/ts-typed", import.meta.url));

async function indexed(typed: boolean): Promise<{ store: Store; cleanup: () => void }> {
	const tmp = mkdtempSync(join(tmpdir(), "codeindex-typed-"));
	const opened = openIndex({ root: FIXTURE, dbPath: join(tmp, "index.db"), typed });
	await opened.indexer.sync();
	const cleanup = () => {
		opened.store.close();
		rmSync(tmp, { recursive: true, force: true });
	};
	return { store: opened.store, cleanup };
}

describe("L3 typed resolution (in-process TypeScript)", () => {
	it("L1/L2 cannot disambiguate same-name method dispatch (ambiguous, syntactic)", async () => {
		const { store, cleanup } = await indexed(false);
		try {
			const callers = store.callers("run", 20);
			// useA + useB each match BOTH A.run and B.run by name → 4 ambiguous edges.
			expect(callers.length).toBe(4);
			expect(callers.every((h) => h.provenance === "syntactic" && h.confidence < 1)).toBe(true);
		} finally {
			cleanup();
		}
	});

	it("resets the working set once per immutable index snapshot", () => {
		// The cost of L3 is program builds, not per-reference lookups; `available(snapshot)`
		// must register the whole TS/JS working set up front, in one batch, exactly once.
		let resetCalls = 0;
		let preloaded: string[] = [];
		const fake = {
			isAvailable: () => true,
			reset: (files: Iterable<string>) => {
				resetCalls++;
				preloaded = [...files];
			},
			definitions: () => [],
		} as unknown as TsTypeService;
		const resolver = new TypedResolver("/repo", fake);
		const snapshot = {
			references: [{ path: "a.ts" }, { path: "a.ts" }, { path: "b.py" }, { path: "c.tsx" }],
		} as unknown as ResolveSnapshot;
		expect(resolver.available(snapshot)).toBe(true);
		expect(resolver.available(snapshot)).toBe(true); // the same immutable snapshot is idempotent
		expect(resetCalls).toBe(1);
		expect(preloaded.sort()).toEqual(["/repo/a.ts", "/repo/c.tsx"]); // TS/JS only, de-duped

		// A later sync replaces the complete working set so edits/removals cannot stay cached.
		const next = { references: [{ path: "a.ts" }, { path: "d.ts" }] } as unknown as ResolveSnapshot;
		expect(resolver.available(next)).toBe(true);
		expect(resetCalls).toBe(2);
		expect(preloaded.sort()).toEqual(["/repo/a.ts", "/repo/d.ts"]);
	});

	it("L3 binds a.run()/b.run() to the correct class by type (typed, 1.00)", async () => {
		const { store, cleanup } = await indexed(true);
		try {
			const callers = store.callers("run", 20);
			expect(callers.length).toBe(2); // exactly one binding per call site
			expect(callers.every((h) => h.provenance === "typed" && h.confidence === 1)).toBe(true);
			expect(new Set(callers.map((h) => h.enclosing))).toEqual(new Set(["useA", "useB"]));
		} finally {
			cleanup();
		}
	});

	it("invalidates TypeScript snapshots between edits and repeated syncs", async () => {
		const root = mkdtempSync(join(tmpdir(), "codeindex-typed-edit-"));
		writeFileSync(join(root, "a.ts"), "export class A { run() { return 1; } }\n");
		writeFileSync(join(root, "b.ts"), "export class B { run() { return 2; } }\n");
		const main = (ctor: "A" | "B") =>
			'import { A } from "./a.ts";\nimport { B } from "./b.ts";\n' +
			`export function useA() { const value = new ${ctor}(); return value.run(); }\n` +
			"export function useB() { const value = new B(); return value.run(); }\n";
		writeFileSync(join(root, "main.ts"), main("A"));
		const opened = openIndex({ root, dbPath: join(root, ".idx.db"), typed: true });
		try {
			await opened.indexer.sync();
			const runs = opened.store.definitions("run", 10);
			const aRun = runs.find((hit) => hit.ownerType === "A")?.moniker;
			const bRun = runs.find((hit) => hit.ownerType === "B")?.moniker;
			expect(aRun).toBeTruthy();
			expect(bRun).toBeTruthy();
			expect(opened.store.callersByMoniker(aRun as string, 10).map((hit) => hit.enclosing)).toContain("useA");

			writeFileSync(join(root, "main.ts"), `${main("B")}\n`);
			await opened.indexer.sync({ only: ["main.ts"] });
			expect(opened.store.callersByMoniker(aRun as string, 10).map((hit) => hit.enclosing)).not.toContain("useA");
			expect(new Set(opened.store.callersByMoniker(bRun as string, 10).map((hit) => hit.enclosing))).toEqual(
				new Set(["useA", "useB"]),
			);
		} finally {
			opened.store.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("uses tsconfig path aliases in typed mode", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "codeindex-typed-alias-"));
		const root = fileURLToPath(new URL("./fixtures/tsconfig-alias", import.meta.url));
		const service = new TsTypeService(root);
		service.reset([join(root, "main.ts")]);
		expect(service.definitions(join(root, "main.ts"), 3, 8)).toContainEqual({
			file: join(root, "src/app/util.ts"),
			line: 1,
			col: 16,
		});
		const opened = openIndex({ root, dbPath: join(tmp, "index.db"), typed: true });
		try {
			await opened.indexer.sync();
			expect(
				opened.store.callers("aliased", 10).some((hit) => hit.provenance === "typed" && hit.confidence === 1),
			).toBe(true);
		} finally {
			opened.store.close();
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});
