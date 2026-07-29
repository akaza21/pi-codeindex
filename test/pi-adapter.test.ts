import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import createExtension from "../src/pi/index.ts";

/** Minimal ExtensionAPI fake capturing tool/handler registrations. */
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

describe("pi adapter", () => {
	const { api, tools, handlers } = fakePi();
	createExtension(api as any);

	// Isolated single-repo workspace (a temp dir, not a git repo → one "marker" repo).
	let work: string;
	let ctx: any;
	let work2: string | undefined;
	let work3: string | undefined;
	let work4: string | undefined;
	let work5: string | undefined;

	beforeAll(() => {
		work = mkdtempSync(join(tmpdir(), "codeindex-adapter-"));
		writeFileSync(join(work, "math.ts"), "export function add(a: number, b: number) { return a + b; }\n");
		writeFileSync(
			join(work, "app.ts"),
			'import { add } from "./math.ts";\nexport class Calculator { run() { return add(1, 2); } }\n',
		);
		ctx = { cwd: work };
	});

	afterAll(async () => {
		await handlers.get("session_shutdown")?.({}, ctx);
		rmSync(work, { recursive: true, force: true });
		if (work2) rmSync(work2, { recursive: true, force: true });
		if (work3) rmSync(work3, { recursive: true, force: true });
		if (work4) rmSync(work4, { recursive: true, force: true });
		if (work5) rmSync(work5, { recursive: true, force: true });
	});

	it("registers the codeindex_* tool surface", () => {
		for (const name of [
			"codeindex_search",
			"codeindex_def",
			"codeindex_explore",
			"codeindex_callers",
			"codeindex_callees",
			"codeindex_refs",
			"codeindex_implementers",
			"codeindex_supertypes",
			"codeindex_impact",
			"codeindex_files",
			"codeindex_match",
			"codeindex_cycles",
			"codeindex_status",
			"codeindex_sync",
		]) {
			expect(tools.has(name)).toBe(true);
		}
	});

	it("registers lifecycle and advisory steering handlers", () => {
		expect(handlers.has("session_start")).toBe(true);
		expect(handlers.has("session_shutdown")).toBe(true);
		expect(handlers.has("tool_call")).toBe(false);
		expect(handlers.has("before_agent_start")).toBe(true);
	});

	it("constrains tool schemas before SQLite receives invalid inputs", () => {
		const defSchema = tools.get("codeindex_def").parameters;
		const callersSchema = tools.get("codeindex_callers").parameters;
		const matchSchema = tools.get("codeindex_match").parameters;
		expect(defSchema.properties.name.minLength).toBe(1);
		expect(defSchema.properties.limit.minimum).toBe(1);
		expect(defSchema.properties.limit.maximum).toBe(500);
		expect(callersSchema.anyOf).toHaveLength(2);
		expect(tools.get("codeindex_impact").parameters.anyOf[0].properties.depth.maximum).toBe(10);
		expect(tools.get("codeindex_explore").parameters.anyOf[0].properties.budget.maximum).toBe(50_000);
		expect(matchSchema.properties.lang.anyOf).toHaveLength(14);
	});

	it("syncs then answers a definition query through the tools", async () => {
		const sync = await tools.get("codeindex_sync").execute("1", {}, undefined, undefined, ctx);
		expect(sync.content[0].text).toContain("symbols");

		const def = await tools.get("codeindex_def").execute("2", { name: "add" }, undefined, undefined, ctx);
		expect(def.content[0].text).toContain("math.ts");
	});

	it("finds code by shape via codeindex_match", async () => {
		await tools.get("codeindex_sync").execute("s", {}, undefined, undefined, ctx);
		const res = await tools
			.get("codeindex_match")
			.execute(
				"m",
				{ lang: "typescript", pattern: "(function_declaration name: (identifier) @name)" },
				undefined,
				undefined,
				ctx,
			);
		expect(res.content[0].text).toContain("math.ts");
		expect(res.content[0].text).toContain("name=add");
	});

	it("surfaces a malformed structural query as an actionable error", async () => {
		const res = await tools
			.get("codeindex_match")
			.execute("m2", { lang: "typescript", pattern: "(function_declaration" }, undefined, undefined, ctx);
		expect(res.content[0].text).toContain("invalid query");
	});

	it("fans codeindex_match across a multi-repo workspace with [repo] tags", async () => {
		const root = mkdtempSync(join(tmpdir(), "codeindex-multi-"));
		work2 = root;
		for (const [name, fn] of [
			["alpha", "alphaFn"],
			["beta", "betaFn"],
		] as const) {
			const repo = join(root, name);
			mkdirSync(join(repo, ".git"), { recursive: true });
			writeFileSync(join(repo, "main.ts"), `export function ${fn}() { return 1; }\n`);
		}
		const ctx2 = { cwd: root };
		await tools.get("codeindex_sync").execute("s2", {}, undefined, undefined, ctx2);
		const res = await tools
			.get("codeindex_match")
			.execute(
				"m3",
				{ lang: "typescript", pattern: "(function_declaration name: (identifier) @name)" },
				undefined,
				undefined,
				ctx2,
			);
		const text = res.content[0].text;
		expect(text).toContain("[alpha]");
		expect(text).toContain("[beta]");
		expect(text).toContain("name=alphaFn");
		expect(text).toContain("name=betaFn");
	});

	it("disambiguates by moniker: def yields an [id: …] that codeindex_callers accepts", async () => {
		await tools.get("codeindex_sync").execute("s3", {}, undefined, undefined, ctx);
		const def = await tools.get("codeindex_def").execute("d2", { name: "add" }, undefined, undefined, ctx);
		const moniker = /\[id: ([^\]]+)\]/.exec(def.content[0].text)?.[1];
		expect(moniker).toBeTruthy();
		const callers = await tools.get("codeindex_callers").execute("c2", { moniker }, undefined, undefined, ctx);
		expect(callers.content[0].text).toContain("app.ts"); // Calculator.run calls add
	});

	it("codeindex_callers returns a consistent error for invalid targets", async () => {
		const both = await tools
			.get("codeindex_callers")
			.execute("c3", { name: "add", moniker: "x#y@1:1" }, undefined, undefined, ctx);
		const neither = await tools.get("codeindex_callers").execute("c4", {}, undefined, undefined, ctx);
		expect(both.content[0].text).toContain("exactly one");
		expect(neither.content[0].text).toContain("exactly one");
	});

	it("reports an unknown repository filter instead of an empty workspace", async () => {
		const def = await tools
			.get("codeindex_def")
			.execute("r1", { name: "add", repo: "does-not-exist" }, undefined, undefined, ctx);
		const sync = await tools
			.get("codeindex_sync")
			.execute("r2", { repo: "does-not-exist" }, undefined, undefined, ctx);
		expect(def.content[0].text).toContain('No repository matches repo="does-not-exist"');
		expect(sync.content[0].text).toContain('No repository matches repo="does-not-exist"');
	});

	it('resolves repo: "." against the tool cwd', async () => {
		await tools.get("codeindex_sync").execute("rd1", { repo: "." }, undefined, undefined, ctx);
		const def = await tools
			.get("codeindex_def")
			.execute("rd2", { name: "add", repo: "." }, undefined, undefined, ctx);
		expect(def.content[0].text).toContain("math.ts");
	});

	it("labels impact rows by hop depth (direct/transitive), never WillBreak/MayBreak", async () => {
		await tools.get("codeindex_sync").execute("si", {}, undefined, undefined, ctx);
		const res = await tools.get("codeindex_impact").execute("ii", { name: "add" }, undefined, undefined, ctx);
		const text = res.content[0].text;
		expect(text).toContain("direct"); // Calculator.run is a direct caller of add
		expect(text).not.toMatch(/WillBreak|MayBreak/);
	});

	it("explains an empty by-name result instead of returning nothing", async () => {
		await tools.get("codeindex_sync").execute("se", {}, undefined, undefined, ctx);
		const unknown = await tools
			.get("codeindex_callers")
			.execute("e1", { name: "Nonexistent" }, undefined, undefined, ctx);
		expect(unknown.content[0].text).toContain("no symbol named");
		// Calculator is defined but nothing calls/instantiates it: indexed-but-no-edges, not "not found".
		const unused = await tools
			.get("codeindex_callers")
			.execute("e2", { name: "Calculator" }, undefined, undefined, ctx);
		expect(unused.content[0].text).toContain("has no matching edges");
	});

	it("explains a fan-out-suppressed name (ambiguous) through the tools", async () => {
		const root = mkdtempSync(join(tmpdir(), "codeindex-fanout-pi-"));
		work3 = root;
		for (let i = 0; i < 9; i++) writeFileSync(join(root, `d${i}.ts`), `export function widget() { return ${i}; }\n`);
		writeFileSync(join(root, "use.ts"), "export function run() { return widget(); }\n");
		const ctx3 = { cwd: root };
		await tools.get("codeindex_sync").execute("fs", {}, undefined, undefined, ctx3);
		const res = await tools.get("codeindex_callers").execute("fc", { name: "widget" }, undefined, undefined, ctx3);
		expect(res.content[0].text).toContain("ambiguous name-only");
		expect(res.content[0].text).toContain("moniker cannot recover");
		const def = await tools.get("codeindex_def").execute("fd", { name: "widget" }, undefined, undefined, ctx3);
		const moniker = /\[id: ([^\]]+)\]/.exec(def.content[0].text)?.[1];
		const targeted = await tools.get("codeindex_callers").execute("fm", { moniker }, undefined, undefined, ctx3);
		expect(targeted.content[0].text).toContain("moniker cannot recover");
		const explored = await tools.get("codeindex_explore").execute("fe", { moniker }, undefined, undefined, ctx3);
		expect(explored.content[0].text).toContain("moniker cannot recover");
	});

	it("warns about possible suppressed sites even when precise edges exist", async () => {
		const root = mkdtempSync(join(tmpdir(), "codeindex-partial-fanout-pi-"));
		work5 = root;
		for (let i = 0; i < 9; i++) writeFileSync(join(root, `d${i}.ts`), `export function widget() { return ${i}; }\n`);
		writeFileSync(
			join(root, "precise.ts"),
			'import { widget } from "./d0.ts";\nexport function precise() { return widget(); }\n',
		);
		writeFileSync(join(root, "ambiguous.ts"), "export function ambiguous() { return widget(); }\n");
		const ctx3 = { cwd: root };
		await tools.get("codeindex_sync").execute("pfs", {}, undefined, undefined, ctx3);
		const res = await tools.get("codeindex_callers").execute("pfc", { name: "widget" }, undefined, undefined, ctx3);
		expect(res.content[0].text).toContain("precise");
		expect(res.content[0].text).toContain("additional ambiguous sites may be absent");
	});

	it("reports Go structural implementers as unsupported instead of a complete empty answer", async () => {
		const root = mkdtempSync(join(tmpdir(), "codeindex-go-interface-pi-"));
		work4 = root;
		writeFileSync(
			join(root, "main.go"),
			"package sample\n\ntype Runner interface { Run() error }\n\ntype Worker struct{}\nfunc (Worker) Run() error { return nil }\nfunc helper() {}\n",
		);
		const goCtx = { cwd: root };
		await tools.get("codeindex_sync").execute("gs", {}, undefined, undefined, goCtx);
		const definition = await tools
			.get("codeindex_def")
			.execute("gd", { name: "Runner" }, undefined, undefined, goCtx);
		expect(definition.content[0].text).toContain("interface Runner");
		const res = await tools
			.get("codeindex_implementers")
			.execute("gi", { name: "Runner" }, undefined, undefined, goCtx);
		expect(res.content[0].text).toContain("Go uses structural interface satisfaction");
		expect(res.content[0].text).toContain("does not compute");
		const supertypes = await tools
			.get("codeindex_supertypes")
			.execute("gt", { name: "Runner" }, undefined, undefined, goCtx);
		expect(supertypes.content[0].text).toContain("Go type/interface embedding");
		const functionQuery = await tools
			.get("codeindex_implementers")
			.execute("gf", { name: "helper" }, undefined, undefined, goCtx);
		expect(functionQuery.content[0].text).toContain("has no matching edges");
		expect(functionQuery.content[0].text).not.toContain("Go uses structural interface satisfaction");
	});

	it("does not block native grep/find tools", () => {
		expect(handlers.has("tool_call")).toBe(false);
	});
});
