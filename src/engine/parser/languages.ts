/**
 * Language registry: uses prebuilt grammar `.wasm` and the
 * community `tags.scm` from each grammar package instead of hand-writing queries.
 *
 * `tagsModules` lists the query files to concatenate, base language first, because a
 * grammar's `tags.scm` often only carries its own additions and relies on an
 * `; inherits:` comment (which web-tree-sitter does not process) to pull in the base
 * grammar's patterns. We make inheritance explicit here.
 */

interface LanguageSpec {
	id: string;
	/** module-relative wasm path, resolved via require.resolve. */
	wasm: string;
	/** tags.scm module paths to concatenate (base grammar first). */
	tagsModules: string[];
	/** tags.scm paths bundled in this package (for grammars that ship a .wasm but no queries). */
	tagsVendored?: string[];
	/** locals.scm npm module paths for the scope graph (resolved via require.resolve). */
	localsModules: string[];
	/** locals.scm paths bundled in this package, relative to the parser dir (for grammars
	 * that don't ship their own). */
	localsVendored: string[];
	extensions: string[];
}

const LANGUAGES: readonly LanguageSpec[] = [
	{
		id: "typescript",
		wasm: "tree-sitter-typescript/tree-sitter-typescript.wasm",
		tagsModules: ["tree-sitter-javascript/queries/tags.scm", "tree-sitter-typescript/queries/tags.scm"],
		localsModules: ["tree-sitter-javascript/queries/locals.scm", "tree-sitter-typescript/queries/locals.scm"],
		localsVendored: [],
		extensions: [".ts", ".mts", ".cts"],
	},
	{
		id: "tsx",
		wasm: "tree-sitter-typescript/tree-sitter-tsx.wasm",
		tagsModules: ["tree-sitter-javascript/queries/tags.scm", "tree-sitter-typescript/queries/tags.scm"],
		localsModules: ["tree-sitter-javascript/queries/locals.scm", "tree-sitter-typescript/queries/locals.scm"],
		localsVendored: [],
		extensions: [".tsx"],
	},
	{
		id: "javascript",
		wasm: "tree-sitter-javascript/tree-sitter-javascript.wasm",
		tagsModules: ["tree-sitter-javascript/queries/tags.scm"],
		localsModules: ["tree-sitter-javascript/queries/locals.scm"],
		localsVendored: [],
		extensions: [".js", ".mjs", ".cjs", ".jsx"],
	},
	{
		id: "python",
		wasm: "tree-sitter-python/tree-sitter-python.wasm",
		tagsModules: ["tree-sitter-python/queries/tags.scm"],
		localsModules: [],
		localsVendored: ["queries/python/locals.scm"],
		extensions: [".py", ".pyi"],
	},
	{
		id: "go",
		wasm: "tree-sitter-go/tree-sitter-go.wasm",
		tagsModules: ["tree-sitter-go/queries/tags.scm"],
		tagsVendored: ["queries/go/tags-extra.scm"],
		localsModules: [],
		localsVendored: ["queries/go/locals.scm"],
		extensions: [".go"],
	},
	{
		id: "ruby",
		wasm: "tree-sitter-ruby/tree-sitter-ruby.wasm",
		tagsModules: ["tree-sitter-ruby/queries/tags.scm"],
		localsModules: ["tree-sitter-ruby/queries/locals.scm"],
		localsVendored: [],
		extensions: [".rb", ".rake"],
	},
	{
		id: "java",
		wasm: "tree-sitter-java/tree-sitter-java.wasm",
		tagsModules: ["tree-sitter-java/queries/tags.scm"],
		localsModules: [],
		localsVendored: ["queries/java/locals.scm"],
		extensions: [".java"],
	},
	{
		// tree-sitter-c-sharp ships tags.scm (classes/interfaces/methods/namespaces + member calls);
		// locals + a few extras (properties, bare calls) are vendored. The wasm filename uses an
		// underscore (`c_sharp`).
		id: "csharp",
		wasm: "tree-sitter-c-sharp/tree-sitter-c_sharp.wasm",
		tagsModules: ["tree-sitter-c-sharp/queries/tags.scm"],
		tagsVendored: ["queries/csharp/tags-extra.scm"],
		localsModules: [],
		localsVendored: ["queries/csharp/locals.scm"],
		extensions: [".cs"],
	},
	{
		// tree-sitter-scala ships tags.scm AND locals.scm + the prebuilt wasm, so nothing is vendored.
		// Member references (`c.area`) are NOT tagged: Scala's uniform access makes a member selection
		// syntactically identical to a package/type path (`a.b.C`), so tagging field accesses would bind
		// path segments to same-named definitions (a confidently-wrong edge). Bare calls are covered by
		// the shipped tags; precise member resolution would need semantic type information
		// (e.g. from an external SCIP index), not syntax alone.
		id: "scala",
		wasm: "tree-sitter-scala/tree-sitter-scala.wasm",
		tagsModules: ["tree-sitter-scala/queries/tags.scm"],
		localsModules: ["tree-sitter-scala/queries/locals.scm"],
		localsVendored: [],
		extensions: [".scala", ".sbt", ".sc"],
	},
	{
		// tree-sitter-php ships a rich tags.scm (classes/interfaces/traits/methods + function/scoped/
		// member calls) + the prebuilt wasm. Vendored: a method re-tag, bare unqualified-call tagging,
		// and locals. The full PHP
		// grammar (not php_only) is used so files mixing HTML and `<?php` blocks parse.
		id: "php",
		wasm: "tree-sitter-php/tree-sitter-php.wasm",
		tagsModules: ["tree-sitter-php/queries/tags.scm"],
		tagsVendored: ["queries/php/tags-extra.scm"],
		localsModules: [],
		localsVendored: ["queries/php/locals.scm"],
		extensions: [".php"],
	},
	{
		// tree-sitter-c ships tags.scm (definitions only) + the prebuilt wasm; calls + locals vendored.
		// `.h` headers are handled by C++ (a superset), so C owns only `.c`.
		id: "c",
		wasm: "tree-sitter-c/tree-sitter-c.wasm",
		tagsModules: ["tree-sitter-c/queries/tags.scm"],
		tagsVendored: ["queries/c/tags-extra.scm"],
		localsModules: [],
		localsVendored: ["queries/c/locals.scm"],
		extensions: [".c"],
	},
	{
		// tree-sitter-cpp ships tags.scm (definitions only) + the prebuilt wasm; calls/method-tags and
		// locals are vendored. `.h` is treated as C++ (a superset of C, so it also parses plain C headers).
		id: "cpp",
		wasm: "tree-sitter-cpp/tree-sitter-cpp.wasm",
		tagsModules: ["tree-sitter-cpp/queries/tags.scm"],
		tagsVendored: ["queries/cpp/tags-extra.scm"],
		localsModules: [],
		localsVendored: ["queries/cpp/locals.scm"],
		extensions: [".cpp", ".cc", ".cxx", ".c++", ".hpp", ".hh", ".hxx", ".h"],
	},
	{
		id: "rust",
		wasm: "tree-sitter-rust/tree-sitter-rust.wasm",
		tagsModules: ["tree-sitter-rust/queries/tags.scm"],
		localsModules: [],
		localsVendored: ["queries/rust/locals.scm"],
		extensions: [".rs"],
	},
	{
		// @tree-sitter-grammars/tree-sitter-kotlin ships a prebuilt .wasm but no query files, so
		// both tags and locals are vendored here (authored against its node types).
		id: "kotlin",
		wasm: "@tree-sitter-grammars/tree-sitter-kotlin/tree-sitter-kotlin.wasm",
		tagsModules: [],
		tagsVendored: ["queries/kotlin/tags.scm"],
		localsModules: [],
		localsVendored: ["queries/kotlin/locals.scm"],
		extensions: [".kt", ".kts"],
	},
];

const extensionToLanguage = new Map<string, LanguageSpec>();
for (const spec of LANGUAGES) {
	for (const ext of spec.extensions) extensionToLanguage.set(ext, spec);
}

export function languageForFile(path: string): string | undefined {
	const dot = path.lastIndexOf(".");
	if (dot === -1) return undefined;
	return extensionToLanguage.get(path.slice(dot).toLowerCase())?.id;
}

/** Registered language ids, in registry order. Used to document the structural-search surface. */
export const languageIds: readonly string[] = LANGUAGES.map((spec) => spec.id);

export function specForLanguage(id: string): LanguageSpec | undefined {
	return LANGUAGES.find((spec) => spec.id === id);
}

/** File extensions for languages that have scope rules (npm-shipped or vendored). */
export function scopedExtensions(): string[] {
	const out: string[] = [];
	for (const spec of LANGUAGES) {
		if (spec.localsModules.length > 0 || spec.localsVendored.length > 0) out.push(...spec.extensions);
	}
	return out;
}

export function supportedExtensions(): string[] {
	return [...extensionToLanguage.keys()];
}
