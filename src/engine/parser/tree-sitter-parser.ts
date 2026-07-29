/**
 * Tree-sitter (WASM) parser adapter implementing the Parser port.
 *
 * Grammars and `tags.scm` come from the official npm grammar packages (prebuilt
 * .wasm, no native compile). The full tags query is compiled once; if a grammar
 * version makes the whole query invalid, we fall back to compiling each top-level
 * pattern individually and skip only the broken ones, so one pattern never disables a
 * language.
 *
 * Reference policy (recall-first but lean): `reference.call` and `reference.class`
 * (constructions) become call occurrences — the useful call graph. `reference.type`
 * is dropped (every annotation would match); any other reference becomes a plain
 * reference occurrence.
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Language, type Node, Query, type QueryMatch, Parser as TsParser } from "web-tree-sitter";
import type {
	ParsedFile,
	ParsedReference,
	ParsedSymbol,
	Parser,
	Range,
	StructuralMatch,
	StructuralQuery,
} from "../ports.ts";
import { callArgCount, paramArity } from "./arity.ts";
import { extractImports } from "./import-extractors.ts";
import { languageForFile, specForLanguage, supportedExtensions } from "./languages.ts";
import { extractModifiers } from "./modifier-extractors.ts";
import { extractRelations } from "./relation-extractors.ts";
import { parseTagCapture, splitPatterns } from "./scm.ts";
import { buildScopeGraph, type LocalDef, type ScopeGraph } from "./scopes.ts";

const require = createRequire(import.meta.url);

const TYPE_CONTAINER_TYPES = new Set([
	"class_declaration",
	"abstract_class_declaration",
	"class_definition",
	"class",
	"interface_declaration",
	"impl_item",
	"module",
	"object",
	"object_declaration", // Kotlin `object X { ... }`
	"class_specifier", // C++
	"struct_specifier", // C++ (methods are legal in C++ structs)
	"object_definition", // Scala `object X { ... }`
	"trait_definition", // Scala `trait X { ... }`
]);

interface LoadedLanguage {
	parser: TsParser;
	language: Language;
	query: Query | undefined;
	locals: Query | undefined;
}

export class TreeSitterParser implements Parser {
	private initPromise?: Promise<void>;
	private readonly loaded = new Map<string, Promise<LoadedLanguage | null>>();

	languageForFile(path: string): string | undefined {
		return languageForFile(path);
	}

	supportedExtensions(): readonly string[] {
		return supportedExtensions();
	}

	async parse(path: string, source: string): Promise<ParsedFile | undefined> {
		const langId = this.languageForFile(path);
		if (!langId) return undefined;
		const loaded = await this.load(langId);
		if (!loaded?.query) return undefined;

		const tree = loaded.parser.parse(source);
		if (!tree) return undefined;
		try {
			const rawSymbols: ParsedSymbol[] = [];
			const references: ParsedReference[] = [];
			for (const match of loaded.query.matches(tree.rootNode)) {
				const extracted = extractMatch(match, langId);
				if (!extracted) continue;
				if (extracted.kind === "symbol") rawSymbols.push(extracted.symbol);
				else if (extracted.kind === "reference") references.push(extracted.reference);
			}
			const symbols = dedupeSymbols(rawSymbols);
			const refs = dropDefinitionNameRefs(dedupeReferences(references), symbols);
			const merged = mergeRelations(refs, extractRelations(langId, tree.rootNode));
			const imports = extractImports(langId, tree.rootNode);
			const { scopes, scopeDefs } = buildScopes(loaded.locals, tree.rootNode, symbols);
			return { symbols, references: merged, imports, scopes, scopeDefs };
		} finally {
			tree.delete();
		}
	}

	async structuralQuery(langId: string, pattern: string): Promise<StructuralQuery> {
		const loaded = await this.load(langId);
		if (!loaded) throw new Error(`structural search: language not available: ${langId}`);
		let query: Query;
		try {
			query = new Query(loaded.language, pattern);
		} catch (error) {
			throw new Error(`structural search: invalid query for ${langId}: ${(error as Error).message}`);
		}
		if (query.captureNames.length === 0) {
			query.delete();
			throw new Error("structural search: the query must capture at least one node (e.g. add a @capture)");
		}
		const tsParser = loaded.parser;
		return {
			match(source: string): StructuralMatch[] {
				const tree = tsParser.parse(source);
				if (!tree) return [];
				try {
					const matches: StructuralMatch[] = [];
					for (const found of query.matches(tree.rootNode)) {
						if (found.captures.length === 0) continue;
						const captures = found.captures.map((c) => ({
							name: c.name,
							range: nodeRange(c.node),
							text: c.node.text,
						}));
						matches.push({ range: spanOf(captures.map((c) => c.range)), captures });
					}
					return matches;
				} finally {
					tree.delete();
				}
			},
			free() {
				query.delete();
			},
		};
	}

	/** Concurrency-safe: concurrent callers for the same language share one in-flight load. */
	private load(langId: string): Promise<LoadedLanguage | null> {
		let job = this.loaded.get(langId);
		if (!job) {
			job = this.loadLanguage(langId);
			this.loaded.set(langId, job);
		}
		return job;
	}

	private async loadLanguage(langId: string): Promise<LoadedLanguage | null> {
		const spec = specForLanguage(langId);
		if (!spec) return null;
		try {
			this.initPromise ??= TsParser.init();
			await this.initPromise;
			const wasmPath = require.resolve(spec.wasm);
			if (!existsSync(wasmPath)) throw new Error(`grammar wasm missing: ${wasmPath}`);
			const language = await Language.load(wasmPath);
			const parser = new TsParser();
			parser.setLanguage(language);
			const localsSources = [
				...spec.localsModules.map(readModuleSource),
				...spec.localsVendored.map(readVendoredSource),
			];
			return {
				parser,
				language,
				query: compileQuery(language, [
					...spec.tagsModules.map(readModuleSource),
					...(spec.tagsVendored ?? []).map(readVendoredSource),
				]),
				locals: localsSources.some((s) => s.trim()) ? compileQuery(language, localsSources) : undefined,
			};
		} catch (error) {
			// Cache the failure (return null) so a broken/missing grammar is not retried per file. `load()`
			// memoizes per language, so this warns exactly once — the missing coverage is visible on stderr
			// instead of silently producing no symbols for that language.
			const reason = error instanceof Error ? error.message : String(error);
			console.warn(`codeindex: language "${langId}" failed to load; its files are skipped (${reason})`);
			return null;
		}
	}
}

/** Read a `.scm` query shipped by an npm grammar package; "" if unavailable. */
function readModuleSource(module: string): string {
	try {
		return readFileSync(require.resolve(module), "utf8");
	} catch {
		return "";
	}
}

/** Read a `.scm` query bundled in this package (path relative to the parser dir). */
function readVendoredSource(relPath: string): string {
	try {
		return readFileSync(fileURLToPath(new URL(relPath, import.meta.url)), "utf8");
	} catch {
		return "";
	}
}

/** Compile a concatenated `.scm` query from sources; per-pattern fallback on failure. */
function compileQuery(language: Language, sources: string[]): Query | undefined {
	const source = sources.join("\n");
	if (!source.trim()) return undefined;
	try {
		return new Query(language, source);
	} catch {
		const kept = splitPatterns(source).filter((pattern) => {
			try {
				new Query(language, pattern);
				return true;
			} catch {
				return false;
			}
		});
		if (kept.length === 0) return undefined;
		try {
			return new Query(language, kept.join("\n"));
		} catch {
			return undefined;
		}
	}
}

type Extracted =
	| { kind: "symbol"; symbol: ParsedSymbol }
	| { kind: "reference"; reference: ParsedReference }
	| undefined;

function extractMatch(match: QueryMatch, langId: string): Extracted {
	let nameNode: Node | undefined;
	let tagNode: Node | undefined;
	let bucket: "definition" | "reference" | undefined;
	let kind = "";
	for (const capture of match.captures) {
		if (capture.name === "name") {
			nameNode = capture.node;
			continue;
		}
		const tag = parseTagCapture(capture.name);
		if (tag) {
			bucket = tag.bucket;
			kind = tag.kind;
			tagNode = capture.node;
		}
	}
	if (!nameNode || !bucket || !tagNode) return undefined;
	const name = nameNode.text;
	if (!name) return undefined;

	if (bucket === "definition") {
		const ownerType = maybeOwnerType(tagNode);
		const arity = paramArity(tagNode);
		return {
			kind: "symbol",
			symbol: {
				kind,
				name,
				range: nodeRange(tagNode),
				nameRange: nodeRange(nameNode),
				exported: isExported(tagNode, langId, name),
				...(isDefaultExport(tagNode) ? { exportedAs: "default" } : {}),
				...(ownerType ? { ownerType } : {}),
				...extractModifiers(langId, tagNode, name),
				...(arity ? { paramCount: arity.paramCount, variadic: arity.variadic } : {}),
			},
		};
	}

	if (kind === "type") return undefined; // every annotation matches; too noisy to store.
	// `reference.send` (C# member invocations) is a call — treat it like `call`/`class` so it carries
	// an argument count and joins the call graph.
	const role = kind === "call" || kind === "class" || kind === "send" ? "call" : "reference";
	const receiver = callReceiver(nameNode);
	const argCount = role === "call" ? callArgCount(nameNode) : undefined;
	return {
		kind: "reference",
		reference: {
			name,
			role,
			range: nodeRange(nameNode),
			...(receiver ? { receiver } : {}),
			...(argCount === undefined ? {} : { argCount }),
		},
	};
}

/**
 * `extends`/`implements` names are also matched by `tags.scm` as plain call/reference
 * captures; the inheritance role is the precise one, so a generic reference sharing a
 * relation's exact range is dropped in favour of the relation.
 */
function mergeRelations(references: ParsedReference[], relations: ParsedReference[]): ParsedReference[] {
	if (relations.length === 0) return references;
	const claimed = new Set(relations.map(rangeKey));
	return [...references.filter((ref) => !claimed.has(rangeKey(ref))), ...relations];
}

/**
 * Drop a reference whose range is exactly a definition's own name token. Community `tags.scm` files
 * capture every identifier as `@reference.call` (e.g. Ruby's `[(identifier)(constant)] @name
 * @reference.call`), including the identifier that IS a definition's name — which would otherwise
 * become a fabricated `f -> f` self-call at the def site. A genuine recursive call sits at a distinct
 * call-site range and is unaffected. Language-agnostic: one guard for all grammars.
 */
function dropDefinitionNameRefs(references: ParsedReference[], symbols: ParsedSymbol[]): ParsedReference[] {
	if (symbols.length === 0) return references;
	const defNameRanges = new Set(symbols.map((s) => s.nameRange.join(":")));
	return references.filter((ref) => !defNameRanges.has(rangeKey(ref)));
}

/**
 * Collapse symbols that are the SAME declaration tagged more than once. Distinct declarations have
 * distinct name-token positions, so a shared name range means one node matched two `tags.scm`
 * patterns (e.g. a Rust `impl` method matches both `definition.method` and `definition.function`).
 * Keep the more specific entry: a member (`method`, or one carrying an ownerType) beats a bare
 * `function`; on a tie, keep the one with the fuller declaration span (some grammars tag the inner
 * signature node and a separate pattern tags the whole definition incl. body — the body span is the
 * one that can enclose calls). Runs before scope building so scope-def symbol indices stay consistent.
 */
function dedupeSymbols(symbols: ParsedSymbol[]): ParsedSymbol[] {
	const byNameToken = new Map<string, ParsedSymbol>();
	for (const symbol of symbols) {
		const key = (symbol.nameRange ?? symbol.range).join(",");
		const existing = byNameToken.get(key);
		if (!existing || isMoreSpecific(symbol, existing)) byNameToken.set(key, symbol);
	}
	return [...byNameToken.values()];
}

function isMoreSpecific(candidate: ParsedSymbol, current: ParsedSymbol): boolean {
	const byKind = symbolSpecificity(candidate) - symbolSpecificity(current);
	if (byKind !== 0) return byKind > 0;
	return rangeSpan(candidate) > rangeSpan(current);
}

function symbolSpecificity(symbol: ParsedSymbol): number {
	if (symbol.kind === "interface") return 3;
	if (symbol.kind === "method") return 2;
	return symbol.ownerType ? 1 : 0;
}

function rangeSpan(symbol: ParsedSymbol): number {
	const [sLine, sCol, eLine, eCol] = symbol.range;
	return (eLine - sLine) * 100_000 + (eCol - sCol);
}

/**
 * Drop references that are identical in name, role, range and receiver. Some grammars' `tags.scm`
 * match the same identifier under more than one pattern (e.g. `new Calc()` captured twice), which
 * would otherwise become duplicate occurrences inflating reference/caller counts. A range uniquely
 * identifies a syntactic site, so collapsing exact duplicates loses nothing.
 */
function dedupeReferences(references: ParsedReference[]): ParsedReference[] {
	const seen = new Set<string>();
	const out: ParsedReference[] = [];
	for (const ref of references) {
		const key = `${ref.name}\u0000${ref.role}\u0000${ref.range.join(",")}\u0000${ref.receiver ?? ""}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(ref);
	}
	return out;
}

function rangeKey(ref: ParsedReference): string {
	return ref.range.join(":");
}

function nodeRange(node: Node): [number, number, number, number] {
	return [node.startPosition.row + 1, node.startPosition.column, node.endPosition.row + 1, node.endPosition.column];
}

/** Smallest range covering all of `ranges` (which must be non-empty). */
function spanOf(ranges: Range[]): Range {
	const first = ranges[0];
	if (!first) throw new Error("spanOf requires at least one range");
	let [sLine, sCol, eLine, eCol] = first;
	for (const [rsLine, rsCol, reLine, reCol] of ranges) {
		if (rsLine < sLine || (rsLine === sLine && rsCol < sCol)) [sLine, sCol] = [rsLine, rsCol];
		if (reLine > eLine || (reLine === eLine && reCol > eCol)) [eLine, eCol] = [reLine, reCol];
	}
	return [sLine, sCol, eLine, eCol];
}

/** Build the per-file scope graph from `locals.scm` captures + the tags-symbols. */
function buildScopes(locals: Query | undefined, root: Node, symbols: ParsedSymbol[]): ScopeGraph {
	if (!locals) return { scopes: [], scopeDefs: [] };
	const scopeRanges: Range[] = [];
	const localDefs: LocalDef[] = [];
	for (const capture of locals.captures(root)) {
		if (capture.name === "local.scope") {
			scopeRanges.push(nodeRange(capture.node));
		} else if (capture.name === "local.definition" || capture.name.startsWith("local.definition.")) {
			const name = capture.node.text;
			if (name)
				localDefs.push({ name, line: capture.node.startPosition.row + 1, col: capture.node.startPosition.column });
		}
	}
	const fileRange: Range = [1, 0, root.endPosition.row + 1, root.endPosition.column];
	return buildScopeGraph(fileRange, scopeRanges, localDefs, symbols);
}

function maybeOwnerType(node: Node): string | undefined {
	let current = node.parent;
	// C++ out-of-class member definition (`int C::m() { ... }`): the owner is the qualifier inside the
	// declarator (a descendant), not an enclosing class_specifier (there is none). Check that first.
	const qualified = qualifiedDeclaratorScope(node);
	if (qualified) return qualified;
	while (current) {
		// Rust associates members with an `impl` block, which has no `name` — the owning type is its
		// `type` field (`impl Trait for Circle { ... }` → owner `Circle`).
		if (current.type === "impl_item") {
			const implType = current.childForFieldName("type");
			if (implType?.text) return implType.text;
		} else if (TYPE_CONTAINER_TYPES.has(current.type)) {
			const name = current.childForFieldName("name");
			if (name?.text) return name.text;
		}
		current = current.parent;
	}
	return undefined;
}

/** Descend a definition's `declarator` chain to a C++ `qualified_identifier` and return its scope. */
function qualifiedDeclaratorScope(node: Node): string | undefined {
	let declarator = node.childForFieldName("declarator");
	for (let depth = 0; declarator && depth < 4; depth++) {
		if (declarator.type === "qualified_identifier") {
			// Descend nested qualifiers (`Ns::C::m`) to the innermost, whose scope is the owning type.
			let qualified = declarator;
			for (let n = 0; n < 4 && qualified.childForFieldName("name")?.type === "qualified_identifier"; n++) {
				const inner = qualified.childForFieldName("name");
				if (!inner) break;
				qualified = inner;
			}
			return qualified.childForFieldName("scope")?.text;
		}
		declarator = declarator.childForFieldName("declarator");
	}
	return undefined;
}

function isExported(node: Node, langId: string, name: string): boolean {
	let current: Node | null = node;
	while (current) {
		if (current.type === "export_statement") return true;
		current = current.parent;
	}
	// Go exports by capitalization of top-level identifiers.
	if (langId === "go") return /^[A-Z]/.test(name);
	return false;
}

function isDefaultExport(node: Node): boolean {
	let current: Node | null = node;
	while (current) {
		if (current.type === "export_statement") return /^export\s+default\b/.test(current.text);
		current = current.parent;
	}
	return false;
}

/** Receiver/namespace text in `recv.name(...)`, across languages' member-access nodes. */
const RECEIVER_PARENTS = new Set([
	"member_expression", // JS/TS
	"selector_expression", // Go
	"attribute", // Python
	"method_invocation", // Java
	"field_access", // Java
	"call", // Ruby (`receiver` field); harmless for Python bare calls (no receiver field)
	"navigation_expression", // Kotlin (`recv.method` — no field; receiver is the first child)
	"field_expression", // Rust (`recv.method` — receiver is the `value` field)
	"member_access_expression", // C# (`recv.Method` — receiver is the `expression` field)
	"member_call_expression", // PHP (`$recv->method()` — receiver is the `object` field)
	"qualified_identifier", // C++ (`Ns::C::m()` — the qualifier is the `scope` field)
]);

function callReceiver(node: Node): string | undefined {
	// See through a generic-call wrapper (`recv.Method<T>()`): the callee identifier sits inside a
	// `generic_name`, so the receiver lives on its parent.
	const parent = node.parent?.type === "generic_name" ? node.parent.parent : node.parent;
	if (!parent || !RECEIVER_PARENTS.has(parent.type)) return undefined;
	const receiver =
		parent.childForFieldName("object")?.text ?? // JS/TS, Python, Java
		parent.childForFieldName("operand")?.text ?? // Go
		parent.childForFieldName("receiver")?.text ?? // Ruby
		parent.childForFieldName("expression")?.text ?? // C# member access
		parent.childForFieldName("value")?.text ?? // Rust field access
		parent.childForFieldName("argument")?.text ?? // C++ field access (`a.b` / `a->b`)
		parent.childForFieldName("scope")?.text ?? // C++ qualified call (`Ns::C::m()` — qualifier narrows the target)
		(parent.type === "navigation_expression" ? parent.child(0)?.text : undefined); // Kotlin (no field)
	// Capture ANY receiver (incl. chained `a.b.c()`), not just simple identifiers: the
	// scope-graph resolver's guard must defer every qualified call. A simple identifier still
	// matches the cross-file binders exactly; a complex receiver simply won't match and falls
	// back to the syntactic resolver.
	return receiver?.trim() || undefined;
}
