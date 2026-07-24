import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type OpenedIndex, openIndex } from "../src/engine/index.ts";
import createExtension from "../src/pi/index.ts";

// Regressions for the explore graph query and its tool presentation.
// (source body + char budget + omission disclosure).
let handle: OpenedIndex | undefined;
let dir: string | undefined;

function open(files: Record<string, string>): OpenedIndex {
	dir = mkdtempSync(join(tmpdir(), "codeindex-explore-"));
	for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
	handle = openIndex({ root: dir, dbPath: join(dir, "i.db") });
	return handle;
}

afterEach(() => {
	handle?.store.close();
	if (dir) rmSync(dir, { recursive: true, force: true });
	handle = undefined;
	dir = undefined;
});

/** Minimal ExtensionAPI fake capturing tool registrations (mirrors pi-adapter.test.ts). */
function fakePi() {
	const tools = new Map<string, any>();
	const handlers = new Map<string, any>();
	const api = {
		registerTool: (def: any) => tools.set(def.name, def),
		on: (event: string, handler: any) => handlers.set(event, handler),
		registerCommand: () => {},
		registerShortcut: () => {},
		registerFlag: () => {},
	};
	return { api, tools, handlers };
}

describe("explore (store)", () => {
	it("resolves a unique symbol with its callers and impact counts", async () => {
		const h = open({
			"math.ts": "export function add(a: number, b: number) { return a + b; }\n",
			"app.ts":
				'import { add } from "./math.ts";\nexport function run() { return add(1, 2); }\nexport function run2() { return add(3, 4); }\n',
		});
		await h.indexer.sync();
		const d = h.store.explore({ name: "add" });
		expect(d.ambiguous).toBe(false);
		expect(d.resolved?.name).toBe("add");
		expect(d.callers.map((c) => c.enclosing)).toEqual(expect.arrayContaining(["run", "run2"]));
		expect(d.callerTotal).toBeGreaterThanOrEqual(2);
		expect(d.impactByDepth[1]).toBeGreaterThanOrEqual(2);
	});

	it("lists candidates and does not guess for an ambiguous name", async () => {
		const h = open({
			"a.ts": "export function dup() { return 1; }\n",
			"b.ts": "export function dup() { return 2; }\n",
		});
		await h.indexer.sync();
		const d = h.store.explore({ name: "dup" });
		expect(d.ambiguous).toBe(true);
		expect(d.candidates).toHaveLength(2);
		expect(d.resolved).toBeUndefined();
		expect(d.callers).toHaveLength(0);
		// A moniker from one candidate resolves to exactly that declaration.
		const moniker = d.candidates[0]?.moniker as string;
		expect(h.store.explore({ moniker }).resolved?.moniker).toBe(moniker);
	});
});

describe("codeindex_explore (tool)", () => {
	it("answers 'what is X and who calls it' in one call", async () => {
		const root = mkdtempSync(join(tmpdir(), "codeindex-explore-tool-"));
		writeFileSync(join(root, "math.ts"), "export function add(a: number, b: number) { return a + b; }\n");
		writeFileSync(
			join(root, "app.ts"),
			'import { add } from "./math.ts";\nexport class Calculator { run() { return add(1, 2); } }\n',
		);
		const { api, tools, handlers } = fakePi();
		createExtension(api as any);
		const ctx = { cwd: root };
		try {
			await tools.get("codeindex_sync").execute("s", {}, undefined, undefined, ctx);
			const res = await tools.get("codeindex_explore").execute("e", { name: "add" }, undefined, undefined, ctx);
			const text = res.content[0].text as string;
			expect(text).toContain("function add"); // definition
			expect(text).toContain("return a + b"); // source body head
			expect(text).toContain("callers"); // call graph
			expect(text).toContain("impact:"); // impact summary
		} finally {
			await handlers.get("session_shutdown")?.({}, ctx);
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("respects the char budget and discloses omitted callers", async () => {
		const root = mkdtempSync(join(tmpdir(), "codeindex-explore-budget-"));
		let body = "export function hot() { return 1; }\n";
		for (let i = 0; i < 40; i++) body += `export function c${i}() { return hot(); }\n`;
		writeFileSync(join(root, "hot.ts"), body);
		const { api, tools, handlers } = fakePi();
		createExtension(api as any);
		const ctx = { cwd: root };
		try {
			await tools.get("codeindex_sync").execute("s", {}, undefined, undefined, ctx);
			const budget = 1500;
			const res = await tools
				.get("codeindex_explore")
				.execute("e", { name: "hot", budget }, undefined, undefined, ctx);
			const text = res.content[0].text as string;
			expect(text.length).toBeLessThanOrEqual(Math.round(budget * 1.1));
			expect(text).toContain("more callers"); // omission disclosed
		} finally {
			await handlers.get("session_shutdown")?.({}, ctx);
			rmSync(root, { recursive: true, force: true });
		}
	});
});
