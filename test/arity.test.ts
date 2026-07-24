import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openIndex, type Store } from "../src/engine/index.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/arity", import.meta.url));
let store: Store;
let tmp: string;

beforeAll(async () => {
	tmp = mkdtempSync(join(tmpdir(), "codeindex-arity-"));
	const opened = openIndex({ root: FIXTURE, dbPath: join(tmp, "index.db") });
	store = opened.store;
	await opened.indexer.sync();
});
afterAll(() => {
	store.close();
	rmSync(tmp, { recursive: true, force: true });
});

const confidence = (name: string): number | undefined => store.callers(name, 5)[0]?.confidence;

describe("arity ranking signal (R5)", () => {
	it("does NOT demote extra positional args in JS/TS (they are legal there)", () => {
		// `solo(a)` called with 3 args is valid TS — extra args are ignored, so no penalty.
		expect(confidence("solo")).toBeCloseTo(0.5, 5);
		expect(confidence("pair")).toBeCloseTo(0.5, 5); // exact match
		expect(confidence("variadicFn")).toBeCloseTo(0.5, 5); // variadic
	});

	it("down-weights too-many-args in a strict-arity language (Python)", () => {
		// `py_solo(a)` called with 3 args, not variadic → incompatible in Python → below base.
		expect(confidence("py_solo")).toBeCloseTo(0.25, 5);
	});

	it("treats a variadic callable as compatible regardless of arg count", () => {
		expect(confidence("py_var")).toBeCloseTo(0.5, 5); // *args
	});

	it("leaves a too-few-args call compatible (optional/default params)", () => {
		// `py_pair(a, b)` called with 1 arg → fewer than declared → NOT demoted.
		expect(confidence("py_pair")).toBeCloseTo(0.5, 5);
	});
});
