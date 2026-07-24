import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exportScip, ingestScip, type OpenedIndex, openIndex } from "../src/engine/index.ts";

// Regressions for the resolver's core safety contract: never confidently wrong, never lose a valid
// call, never let stale data rebind.
let handle: OpenedIndex | undefined;
let dir: string | undefined;

function open(files: Record<string, string>): OpenedIndex {
	dir = mkdtempSync(join(tmpdir(), "codeindex-safety-"));
	for (const [name, body] of Object.entries(files)) {
		const full = join(dir, name);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, body);
	}
	handle = openIndex({ root: dir, dbPath: join(dir, "i.db") });
	return handle;
}

afterEach(() => {
	handle?.store.close();
	if (dir) rmSync(dir, { recursive: true, force: true });
	handle = undefined;
	dir = undefined;
});

describe("resolution safety", () => {
	it("does not lose a this.m() call when a same-named local shadows the member", async () => {
		const h = open({ "a.ts": "class A {\n  m() {}\n  run() {\n    const m = 1;\n    return this.m();\n  }\n}\n" });
		await h.indexer.sync();
		// `this.m()` is a member access, not a reference to the local `m`; the call must still resolve.
		expect(h.store.callers("m", 10).some((c) => c.enclosing === "run")).toBe(true);
	});

	it("never binds a receiver-qualified call to a same-file same-name def at full confidence", async () => {
		// `N::C::m()` cannot be confidently bound to `A::C::m` by name alone (different qualifier).
		const h = open({ "a.cpp": "namespace A { struct C { int m(); }; }\nint caller() { return N::C::m(); }\n" });
		await h.indexer.sync();
		expect(h.store.callers("m", 10).every((c) => c.confidence <= 0.5)).toBe(true);
	});

	it("drops a stale SCIP occurrence when its target symbol is deleted (no rebind via reused rowid)", async () => {
		const h = open({
			"calc.ts": "export class Calc {}\n",
			"app.ts": 'import { Calc } from "./calc.ts";\nexport function run() { return new Calc(); }\n',
		});
		await h.indexer.sync();
		h.store.replaceIngestedOccurrences(
			ingestScip(h.store.snapshot(), exportScip(h.store, { projectRoot: dir as string, repo: "demo" })),
		);
		// Delete the target file and add an unrelated one; the old Calc occurrence must not survive to
		// rebind to a new symbol that reuses Calc's freed rowid.
		unlinkSync(join(dir as string, "calc.ts"));
		writeFileSync(join(dir as string, "zed.ts"), "export class Zed {}\n");
		await h.indexer.sync({ only: ["calc.ts", "zed.ts"] });
		expect(h.store.references("Zed", 10)).toHaveLength(0);
	});

	it("keeps inheritance edges queryable after a SCIP import (suppression is call-graph only)", async () => {
		const h = open({
			"base.ts": "export class Base {}\n",
			"sub.ts": 'import { Base } from "./base.ts";\nexport class Sub extends Base {}\n',
		});
		await h.indexer.sync();
		// Ingesting SCIP (whose occurrences are plain references) must not shadow away the `extends`
		// edge — implementers/supertypes would otherwise silently go empty.
		h.store.replaceIngestedOccurrences(
			ingestScip(h.store.snapshot(), exportScip(h.store, { projectRoot: dir as string, repo: "demo" })),
		);
		expect(h.store.implementers("Base", 10).some((hit) => hit.enclosing === "Sub")).toBe(true);
	});

	it("import-binds a Python `from . import name` to a function in the package __init__", async () => {
		const h = open({
			"pkg/__init__.py": "def helper():\n    return 1\n",
			"pkg/app.py": "from . import helper\ndef run():\n    return helper()\n",
		});
		await h.indexer.sync();
		expect(h.store.callers("helper", 10).some((c) => c.enclosing === "run" && c.confidence > 0.5)).toBe(true);
	});

	it("binds this.m() to the enclosing class's own member, never an unrelated same-name member", async () => {
		const h = open({ "a.ts": "class A { m(){} }\nclass B extends A { m(){} run(){ return this.m(); } }\n" });
		await h.indexer.sync();
		const defs = h.store.definitions("m", 10);
		const bMember = defs.find((d) => d.ownerType === "B")?.moniker;
		const aMember = defs.find((d) => d.ownerType === "A")?.moniker;
		// `this.m()` in B.run binds to B#m (own class), never A#m.
		expect(h.store.callersByMoniker(bMember as string, 10).some((c) => c.enclosing === "run")).toBe(true);
		expect(h.store.callersByMoniker(aMember as string, 10).some((c) => c.enclosing === "run")).toBe(false);
	});

	it("does not confidently bind this.m() when neither the class nor its bases declare it", async () => {
		const h = open({ "a.ts": "class A { m(){} }\nclass B { run(){ return this.m(); } }\n" });
		await h.indexer.sync();
		// B has no `m` and no base with `m`; this.m() must never bind A#m confidently.
		expect(
			h.store
				.callers("m", 10)
				.filter((c) => c.enclosing === "run")
				.every((c) => c.confidence < 0.9),
		).toBe(true);
	});

	it("does not fabricate a self-call from a definition-name capture (non-recursive Ruby method)", async () => {
		// Ruby's community tags.scm captures a `def`'s own name as a reference.call; the parser must
		// drop that coincident capture so a non-recursive method has zero self edges.
		const h = open({ "a.rb": "def work\n  x = 1\n  x + 1\nend\n" });
		await h.indexer.sync();
		expect(h.store.callers("work", 10)).toHaveLength(0);
	});

	it("keeps a genuine recursive self-call (call-site range differs from the def-name range)", async () => {
		const h = open({ "a.rb": "def recurse(n)\n  return 0 if n == 0\n  recurse(n - 1)\nend\n" });
		await h.indexer.sync();
		const callers = h.store.callers("recurse", 10);
		expect(callers).toHaveLength(1);
		// The surviving edge is the real call on line 3, not the dropped def-name token on line 1.
		expect(callers[0]?.range[0]).toBe(3);
	});

	it("import-binds a Java unqualified type through a wildcard package import", async () => {
		const h = open({
			"a/Util.java": "package a;\npublic class Util { public static void hi() {} }\n",
			"b/App.java": "package b;\nimport a.*;\nclass App { void run() { new Util(); } }\n",
		});
		await h.indexer.sync();
		expect(h.store.callers("Util", 10).some((c) => c.enclosing === "run" && c.confidence > 0.5)).toBe(true);
	});
});
