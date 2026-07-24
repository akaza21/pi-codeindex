/**
 * SCIP source ranges use a per-document column encoding. The local index uses UTF-16 code-unit
 * columns (the coordinate system exposed by web-tree-sitter), so imported UTF-8/UTF-32 positions
 * must be translated against the exact source line before they can be matched safely.
 */

import type { Range } from "../model/types.ts";

export const SCIP_POSITION_UNSPECIFIED = 0;
export const SCIP_POSITION_UTF8 = 1;
export const SCIP_POSITION_UTF16 = 2;
export const SCIP_POSITION_UTF32 = 3;

export interface ScipEncodedOccurrence {
	range?: number[];
	singleLineRange?: { line?: number; startCharacter?: number; endCharacter?: number } | null;
	multiLineRange?: { startLine?: number; startCharacter?: number; endLine?: number; endCharacter?: number } | null;
}

type RawRange = readonly [number, number, number, number];
export type ScipRangeDecoder = (occurrence: ScipEncodedOccurrence) => Range | undefined;

/** Build a reusable range decoder for one SCIP document. */
export function createScipRangeDecoder(positionEncoding: number, source: string | undefined): ScipRangeDecoder {
	const lines = source === undefined ? undefined : source.split("\n");
	const sourceAvailable = source !== undefined;
	return (occurrence) => translatedOccurrenceRange(occurrence, positionEncoding, lines, sourceAvailable);
}

/**
 * Decode and translate one SCIP occurrence range into local coordinates.
 *
 * UTF-8 and UTF-32 conversion requires the document text. An unspecified encoding is accepted only
 * when all three protocol encodings map the supplied columns to the same UTF-16 boundaries. This
 * preserves ASCII-era indexes without guessing after non-ASCII text. Malformed lines, columns,
 * reversed ranges, and offsets inside a multi-unit character are rejected.
 */
export function scipOccurrenceRange(
	occurrence: ScipEncodedOccurrence,
	positionEncoding: number,
	source: string | undefined,
): Range | undefined {
	return createScipRangeDecoder(positionEncoding, source)(occurrence);
}

function translatedOccurrenceRange(
	occurrence: ScipEncodedOccurrence,
	positionEncoding: number,
	lines: readonly string[] | undefined,
	sourceAvailable: boolean,
): Range | undefined {
	const raw = rawOccurrenceRange(occurrence);
	if (!raw) return undefined;
	const [startLine, startColumn, endLine, endColumn] = raw;
	if (
		![startLine, startColumn, endLine, endColumn].every((value) => Number.isInteger(value) && value >= 0) ||
		endLine < startLine
	) {
		return undefined;
	}

	const start = localColumn(lines?.[startLine], startColumn, positionEncoding, sourceAvailable);
	const end = localColumn(lines?.[endLine], endColumn, positionEncoding, sourceAvailable);
	if (start === undefined || end === undefined || (startLine === endLine && end <= start)) return undefined;
	return [startLine + 1, start, endLine + 1, end];
}

function rawOccurrenceRange(occurrence: ScipEncodedOccurrence): RawRange | undefined {
	const single = occurrence.singleLineRange;
	if (single) {
		const line = single.line ?? 0;
		return [line, single.startCharacter ?? 0, line, single.endCharacter ?? 0];
	}
	const multi = occurrence.multiLineRange;
	if (multi) {
		return [multi.startLine ?? 0, multi.startCharacter ?? 0, multi.endLine ?? 0, multi.endCharacter ?? 0];
	}
	const packed = occurrence.range ?? [];
	if (packed.length === 3) return [packed[0] as number, packed[1] as number, packed[0] as number, packed[2] as number];
	if (packed.length === 4) return [packed[0] as number, packed[1] as number, packed[2] as number, packed[3] as number];
	return undefined;
}

function localColumn(
	line: string | undefined,
	column: number,
	encoding: number,
	sourceAvailable: boolean,
): number | undefined {
	if (encoding === SCIP_POSITION_UTF16) {
		// UTF-16 is already the local coordinate system. When source is available, still reject
		// out-of-line positions and boundaries in the middle of a surrogate pair.
		return sourceAvailable ? utf16Column(line, column) : column;
	}
	if (line === undefined) return undefined;
	if (encoding === SCIP_POSITION_UTF8) return utf8Column(line, column);
	if (encoding === SCIP_POSITION_UTF32) return utf32Column(line, column);
	if (encoding !== SCIP_POSITION_UNSPECIFIED) return undefined;

	// An unspecified producer encoding is genuinely ambiguous. Retain a coordinate only when the
	// same numeric offset denotes the same boundary under every encoding SCIP permits.
	const candidates = [utf8Column(line, column), utf16Column(line, column), utf32Column(line, column)];
	const first = candidates[0];
	return first !== undefined && candidates.every((candidate) => candidate === first) ? first : undefined;
}

function utf16Column(line: string | undefined, units: number): number | undefined {
	if (line === undefined || units > line.length) return undefined;
	// A valid source position cannot split a surrogate pair.
	if (
		units > 0 &&
		units < line.length &&
		isHighSurrogate(line.charCodeAt(units - 1)) &&
		isLowSurrogate(line.charCodeAt(units))
	) {
		return undefined;
	}
	return units;
}

function utf8Column(line: string, bytes: number): number | undefined {
	let consumedBytes = 0;
	let utf16 = 0;
	for (const codePoint of line) {
		if (consumedBytes === bytes) return utf16;
		consumedBytes += Buffer.byteLength(codePoint, "utf8");
		utf16 += codePoint.length;
		if (consumedBytes > bytes) return undefined;
	}
	return consumedBytes === bytes ? utf16 : undefined;
}

function utf32Column(line: string, codePoints: number): number | undefined {
	let consumedCodePoints = 0;
	let utf16 = 0;
	for (const codePoint of line) {
		if (consumedCodePoints === codePoints) return utf16;
		consumedCodePoints++;
		utf16 += codePoint.length;
	}
	return consumedCodePoints === codePoints ? utf16 : undefined;
}

function isHighSurrogate(unit: number): boolean {
	return unit >= 0xd800 && unit <= 0xdbff;
}

function isLowSurrogate(unit: number): boolean {
	return unit >= 0xdc00 && unit <= 0xdfff;
}
