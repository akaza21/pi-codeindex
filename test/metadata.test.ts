import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openIndex, type ResolveSnapshot, type Store, type SymbolHit } from "../src/engine/index.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/members", import.meta.url));
let store: Store;
let tmp: string;

beforeAll(async () => {
	tmp = mkdtempSync(join(tmpdir(), "codeindex-meta-"));
	const opened = openIndex({ root: FIXTURE, dbPath: join(tmp, "index.db") });
	store = opened.store;
	await opened.indexer.sync();
});
afterAll(() => {
	store.close();
	rmSync(tmp, { recursive: true, force: true });
});

const def = (name: string): SymbolHit => {
	const hit = store.definitions(name, 5)[0];
	if (!hit) throw new Error(`no definition for ${name}`);
	return hit;
};

describe("member metadata", () => {
	it("extracts TS static / abstract / visibility", () => {
		expect(def("makeTs").isStatic).toBe(true);
		expect(def("doTs").isAbstract).toBe(true);
		expect(def("secretTs").visibility).toBe("private");
		expect(def("helperTs").visibility).toBe("protected");
		// a plain method carries none of the modifier flags (unknown ≠ false).
		const plain = def("plainTs");
		expect(plain.isStatic).toBeUndefined();
		expect(plain.visibility).toBeUndefined();
	});

	it("extracts Java modifiers from the `modifiers` node", () => {
		const make = def("makeJava");
		expect(make.isStatic).toBe(true);
		expect(make.visibility).toBe("public");
		const handle = def("doJava");
		expect(handle.isAbstract).toBe(true);
		expect(handle.visibility).toBe("protected");
		expect(def("secretJava").visibility).toBe("private");
	});

	it("extracts Python decorators and underscore-convention visibility", () => {
		expect(def("make_py").isStatic).toBe(true); // @staticmethod
		expect(def("do_py").isAbstract).toBe(true); // @abstractmethod
		expect(def("__secret_py").visibility).toBe("private");
		expect(def("_helper_py").visibility).toBe("protected");
	});

	it("leaves @classmethod and plain/undecorated members unknown (no guessed false)", () => {
		const cls = def("cls_py");
		expect(cls.isStatic).toBeUndefined(); // @classmethod is dual-callable, left unknown
		const plain = def("plain_py");
		expect(plain.isStatic).toBeUndefined();
		expect(plain.isAbstract).toBeUndefined();
		expect(plain.visibility).toBeUndefined();
	});

	it("leaves all metadata unknown for languages without a cheap signal (Go)", () => {
		const go = def("DoGo");
		expect(go.isStatic).toBeUndefined();
		expect(go.isAbstract).toBeUndefined();
		expect(go.visibility).toBeUndefined();
	});

	it("surfaces the metadata on the resolve snapshot (what D3 will consume)", () => {
		const snapshot: ResolveSnapshot = store.snapshot();
		const make = snapshot.symbolsByName("makeTs").find((s) => s.name === "makeTs");
		expect(make?.isStatic).toBe(true);
		expect(snapshot.symbolsByName("doTs").find((s) => s.name === "doTs")?.isAbstract).toBe(true);
		expect(snapshot.symbolsByName("secretTs").find((s) => s.name === "secretTs")?.visibility).toBe("private");
		const plain = snapshot.symbolsByName("plainTs").find((s) => s.name === "plainTs");
		expect(plain?.isStatic).toBeUndefined(); // round-trips as unknown, not false
	});
});
