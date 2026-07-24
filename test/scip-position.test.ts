import { describe, expect, it } from "vitest";
import {
	SCIP_POSITION_UNSPECIFIED,
	SCIP_POSITION_UTF8,
	SCIP_POSITION_UTF16,
	SCIP_POSITION_UTF32,
	scipOccurrenceRange,
} from "../src/engine/scip/position.ts";

const occurrence = (startCharacter: number, endCharacter: number) => ({
	singleLineRange: { line: 0, startCharacter, endCharacter },
});

describe("SCIP position encoding", () => {
	const source = "💡 tail\n";

	it.each([
		["UTF-8 bytes", SCIP_POSITION_UTF8, 5, 9],
		["UTF-16 code units", SCIP_POSITION_UTF16, 3, 7],
		["UTF-32 code points", SCIP_POSITION_UTF32, 2, 6],
	])("converts %s to local UTF-16 columns", (_label, encoding, start, end) => {
		expect(scipOccurrenceRange(occurrence(start, end), encoding, source)).toEqual([1, 3, 1, 7]);
	});

	it("converts both ends of a multi-line range", () => {
		const range = {
			multiLineRange: { startLine: 0, startCharacter: 4, endLine: 1, endCharacter: 7 },
		};
		expect(scipOccurrenceRange(range, SCIP_POSITION_UTF8, "éx tail\n💡 ok\n")).toEqual([1, 3, 2, 5]);
	});

	it("accepts unspecified positions only when every protocol encoding agrees", () => {
		expect(scipOccurrenceRange(occurrence(1, 5), SCIP_POSITION_UNSPECIFIED, " plain\n")).toEqual([1, 1, 1, 5]);
		expect(scipOccurrenceRange(occurrence(2, 6), SCIP_POSITION_UNSPECIFIED, source)).toBeUndefined();
		expect(scipOccurrenceRange(occurrence(0, 1), SCIP_POSITION_UNSPECIFIED, undefined)).toBeUndefined();
	});

	it("rejects malformed, unknown, and character-splitting offsets", () => {
		expect(scipOccurrenceRange(occurrence(1, 5), SCIP_POSITION_UTF8, source)).toBeUndefined();
		expect(scipOccurrenceRange(occurrence(1, 3), SCIP_POSITION_UTF16, source)).toBeUndefined();
		expect(scipOccurrenceRange(occurrence(0, 99), SCIP_POSITION_UTF32, source)).toBeUndefined();
		expect(scipOccurrenceRange(occurrence(0, 1), 99, source)).toBeUndefined();
		expect(
			scipOccurrenceRange(
				{ multiLineRange: { startLine: 2, startCharacter: 0, endLine: 1, endCharacter: 1 } },
				SCIP_POSITION_UTF16,
				source,
			),
		).toBeUndefined();
	});
});
