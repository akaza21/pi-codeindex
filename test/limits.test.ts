import { describe, expect, it } from "vitest";
import { DEFAULT_INDEX_FILE_LIMIT, DEFAULT_TYPED_INDEX_FILE_LIMIT, effectiveIndexFileLimit } from "../src/limits.ts";

describe("resource limit policy", () => {
	it("uses a lower automatic file cap for typed resolution", () => {
		expect(effectiveIndexFileLimit(false)).toBe(DEFAULT_INDEX_FILE_LIMIT);
		expect(effectiveIndexFileLimit(true)).toBe(DEFAULT_TYPED_INDEX_FILE_LIMIT);
	});

	it("honors an explicit typed cap after validating the global ceiling", () => {
		expect(effectiveIndexFileLimit(true, 750)).toBe(750);
		expect(() => effectiveIndexFileLimit(true, 100_001)).toThrow("no greater than 100,000");
	});
});
