import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { applyTsLayout, buildProjectLayout } from "../src/engine/imports/project-layout.ts";
import { openIndex, type Store } from "../src/engine/index.ts";
import type { FileStat, FileSystem } from "../src/engine/ports.ts";

/** FileSystem fake serving fixed config-file contents. */
function fakeFs(files: Record<string, string>): FileSystem {
	return {
		readFile: (path) => files[path],
		stat: (): FileStat | undefined => undefined,
		exists: (path) => path in files,
		walk: () => [],
	};
}

describe("buildProjectLayout / applyTsLayout", () => {
	it("reads tsconfig baseUrl + paths and maps a wildcard alias with the right separator", () => {
		const root = "r";
		const layout = buildProjectLayout(
			fakeFs({
				[join(root, "tsconfig.json")]: '{"compilerOptions":{"baseUrl":".","paths":{"@app/*":["src/app/*"]}}}',
			}),
			root,
		);
		expect(layout.tsBaseUrl).toBe("");
		expect(applyTsLayout(layout, "@app/util")).toEqual(["src/app/util"]); // not "src/apputil"
		expect(applyTsLayout(layout, "bare/mod")).toEqual(["bare/mod"]); // baseUrl fallback
	});

	it("tolerates comments/trailing commas in tsconfig and reads the go.mod module", () => {
		const root = "r";
		const layout = buildProjectLayout(
			fakeFs({
				[join(root, "tsconfig.json")]: '{\n// c\n"compilerOptions":{"baseUrl":"src",},\n}',
				[join(root, "go.mod")]: "module example.com/m\n\ngo 1.21\n",
			}),
			root,
		);
		expect(layout.tsBaseUrl).toBe("src");
		expect(layout.goModule).toBe("example.com/m");
	});

	it("degrades safely on a malformed tsconfig (paths value not an array)", () => {
		const root = "r";
		const layout = buildProjectLayout(
			fakeFs({ [join(root, "tsconfig.json")]: '{"compilerOptions":{"paths":{"@app/*":"src/app/*"}}}' }),
			root,
		);
		expect(layout.tsPaths).toEqual([]); // bad entry ignored, no throw
	});

	it("maps non-wildcard aliases and preserves multi-target order", () => {
		const root = "r";
		const layout = buildProjectLayout(
			fakeFs({
				[join(root, "tsconfig.json")]: '{"compilerOptions":{"paths":{"@x":["a/x.ts"],"@y/*":["p/*","q/*"]}}}',
			}),
			root,
		);
		expect(applyTsLayout(layout, "@x")).toEqual(["a/x.ts"]);
		expect(applyTsLayout(layout, "@y/z")).toEqual(["p/z", "q/z"]);
	});
});

describe("config-aware import resolution (integration)", () => {
	const opened: Array<{ store: Store; tmp: string }> = [];
	afterAll(() => {
		for (const { store, tmp } of opened) {
			store.close();
			rmSync(tmp, { recursive: true, force: true });
		}
	});
	async function index(name: string): Promise<Store> {
		const tmp = mkdtempSync(join(tmpdir(), "codeindex-pc-"));
		const root = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
		const o = openIndex({ root, dbPath: join(tmp, "index.db") });
		await o.indexer.sync();
		opened.push({ store: o.store, tmp });
		return o.store;
	}

	it("resolves a tsconfig path alias (@app/*) precisely", async () => {
		const store = await index("tsconfig-alias");
		const callers = store.callers("aliased", 10);
		expect(callers.some((h) => h.enclosing === "run" && h.confidence >= 0.8 && h.provenance === "syntactic")).toBe(
			true,
		);
	});

	it("resolves a Go import via the go.mod module prefix precisely", async () => {
		const store = await index("go-mod");
		const callers = store.callers("Do", 10);
		expect(callers.some((h) => h.enclosing === "run" && h.confidence >= 0.8 && h.provenance === "syntactic")).toBe(
			true,
		);
	});

	it("refreshes resolution after a config-only edit (no source file changed)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "codeindex-cfg-"));
		mkdirSync(join(dir, "src/app"), { recursive: true });
		writeFileSync(join(dir, "src/app/util.ts"), "export function aliased() { return 1; }\n");
		writeFileSync(
			join(dir, "main.ts"),
			'import { aliased } from "@app/util";\nexport function run() { return aliased(); }\n',
		);
		const write = (target: string) =>
			writeFileSync(
				join(dir, "tsconfig.json"),
				`{"compilerOptions":{"baseUrl":".","paths":{"@app/*":["${target}"]}}}`,
			);
		write("src/app/*");
		const { store, indexer } = openIndex({ root: dir, dbPath: join(dir, ".idx.db") });
		try {
			await indexer.sync();
			expect(store.callers("aliased", 10).some((h) => h.confidence >= 0.8)).toBe(true);
			write("src/missing/*"); // only tsconfig changes; alias now points nowhere
			await indexer.sync();
			expect(store.callers("aliased", 10).every((h) => h.confidence < 0.8)).toBe(true);
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("a corrupt project_layout meta value does not crash snapshot load", async () => {
		const dir = mkdtempSync(join(tmpdir(), "codeindex-meta-"));
		const { store } = openIndex({ root: dir, dbPath: join(dir, ".idx.db") });
		try {
			store.setMeta("project_layout", "{ not json");
			expect(() => store.snapshot()).not.toThrow();
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
