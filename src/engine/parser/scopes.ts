/**
 * Per-file scope-graph builder. Pure geometry over ranges so it is unit
 * testable without tree-sitter. Borrows the scope-graphs idea (A Theory of Name
 * Resolution / stack-graphs): a name binds to the nearest enclosing scope that
 * declares it.
 *
 * Inputs:
 *  - `fileRange`  whole-file range → the synthetic root scope (index 0)
 *  - `scopeRanges` ranges captured by `locals.scm` `@local.scope`
 *  - `localDefs`  `@local.definition` positions (params/vars) — for shadowing
 *  - `symbols`    tags-symbols (functions/classes/...) we want callable by name
 *
 * Placement rule: a symbol binds in the scope ENCLOSING its own definition node, not
 * inside it — otherwise a sibling call could never see it. We achieve this by skipping
 * any scope whose range equals the symbol's definition range when placing it.
 */

import type { ParsedScope, ParsedScopeDef, ParsedSymbol, Range } from "../ports.ts";

export interface LocalDef {
	name: string;
	line: number;
	col: number;
}

export interface ScopeGraph {
	scopes: ParsedScope[];
	scopeDefs: ParsedScopeDef[];
}

export function buildScopeGraph(
	fileRange: Range,
	scopeRanges: Range[],
	localDefs: LocalDef[],
	symbols: ParsedSymbol[],
): ScopeGraph {
	// Index 0 is the synthetic file-root; locals scopes follow.
	const ranges: Range[] = [fileRange, ...scopeRanges];
	const scopes: ParsedScope[] = ranges.map((range, index) => ({
		range,
		parentIndex: index === 0 ? null : innermostContainer(ranges, index),
	}));

	const scopeDefs: ParsedScopeDef[] = [];
	for (const def of localDefs) {
		scopeDefs.push({ name: def.name, scopeIndex: innermostAt(ranges, def.line, def.col, null), symbolIndex: null });
	}
	symbols.forEach((symbol, symbolIndex) => {
		const [line, col] = symbol.range;
		// Skip the symbol's own definition scope so it binds one level out.
		scopeDefs.push({ name: symbol.name, scopeIndex: innermostAt(ranges, line, col, symbol.range), symbolIndex });
	});
	return { scopes, scopeDefs };
}

/** Index of the tightest scope (other than `self`) whose range contains scope `self`. */
function innermostContainer(ranges: Range[], self: number): number {
	const target = ranges[self] as Range;
	let best = 0; // root always contains everything
	for (let i = 0; i < ranges.length; i++) {
		if (i === self) continue;
		const candidate = ranges[i] as Range;
		if (!containsRange(candidate, target)) continue;
		if (tighter(candidate, ranges[best] as Range)) best = i;
	}
	return best;
}

/** Index of the tightest scope containing (line,col); ignores any scope equal to `skip`. */
function innermostAt(ranges: Range[], line: number, col: number, skip: Range | null): number {
	let best = 0;
	for (let i = 0; i < ranges.length; i++) {
		const candidate = ranges[i] as Range;
		if (skip && rangeEquals(candidate, skip)) continue;
		if (!containsPoint(candidate, line, col)) continue;
		if (best === 0 || tighter(candidate, ranges[best] as Range)) best = i;
	}
	return best;
}

function containsPoint(range: Range, line: number, col: number): boolean {
	const [sl, sc, el, ec] = range;
	if (line < sl || line > el) return false;
	if (line === sl && col < sc) return false;
	if (line === el && col > ec) return false;
	return true;
}

function containsRange(outer: Range, inner: Range): boolean {
	return (
		!rangeEquals(outer, inner) && containsPoint(outer, inner[0], inner[1]) && containsPoint(outer, inner[2], inner[3])
	);
}

/** True when `a` is strictly tighter (smaller span) than `b`. */
function tighter(a: Range, b: Range): boolean {
	return span(a) < span(b);
}

function span(range: Range): number {
	// Line-dominant span; columns break ties for same-line scopes.
	return (range[2] - range[0]) * 10_000 + (range[3] - range[1]);
}

function rangeEquals(a: Range, b: Range): boolean {
	return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}
