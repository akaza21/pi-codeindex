/**
 * Per-language import extraction: a file's AST → normalized `ParsedImport` facts.
 *
 * Each language's import *syntax* lives in exactly one focused function here; the
 * cross-file *resolution* of those facts lives in resolve/cross-file.ts. Keeping the
 * two apart means "how this language writes imports" and "how this language finds the
 * target" never bleed into each other.
 *
 * Normalized model (consumed uniformly by the binders):
 *  - kind "named":     a bound name (`local`) that maps to an exported `imported` name
 *                      in `source` (TS named/default, Python from-import, Java import).
 *  - kind "namespace": a bound name (`local`) you dereference (`local.X`); `source` is
 *                      the module/package (TS `* as`, Go package, Python `import as`).
 *  - kind "wildcard":  all exports of `source` become visible (Java `a.b.*`).
 *  - kind "reexport"/"reexport-star": TS re-exports (followed during resolution).
 *  - kind "side-effect": import with no bindings.
 */

import type { Node } from "web-tree-sitter";
import type { ParsedImport } from "../ports.ts";

type ImportExtractor = (root: Node) => ParsedImport[];

const EXTRACTORS: Record<string, ImportExtractor> = {
	typescript: extractEcmaScript,
	tsx: extractEcmaScript,
	javascript: extractEcmaScript,
	go: extractGo,
	python: extractPython,
	java: extractJava,
};

export function extractImports(langId: string, root: Node): ParsedImport[] {
	return EXTRACTORS[langId]?.(root) ?? [];
}

// Extracts normalized import facts (source module + binding kind) from the
// tree-sitter AST of an ECMAScript/TypeScript file.

function extractEcmaScript(root: Node): ParsedImport[] {
	const imports: ParsedImport[] = [];
	for (const statement of root.namedChildren) {
		if (statement.type === "import_statement") {
			const source = stringValue(statement.childForFieldName("source"));
			if (!source) continue;
			const clause = statement.namedChildren.find((child) => child.type === "import_clause");
			if (!clause) {
				imports.push({ source, kind: "side-effect" });
				continue;
			}
			for (const child of clause.namedChildren) {
				if (child.type === "identifier") {
					imports.push({ source, kind: "default", imported: "default", local: child.text });
				} else if (child.type === "namespace_import") {
					const local = child.namedChildren.find((part) => part.type === "identifier")?.text;
					if (local) imports.push({ source, kind: "namespace", local });
				} else if (child.type === "named_imports") {
					for (const specifier of child.descendantsOfType("import_specifier")) {
						const imported = specifier.childForFieldName("name")?.text;
						const local = specifier.childForFieldName("alias")?.text ?? imported;
						if (imported && local) imports.push({ source, kind: "named", imported, local });
					}
				}
			}
			continue;
		}
		if (statement.type !== "export_statement") continue;
		const source = stringValue(statement.childForFieldName("source"));
		if (!source) continue;
		const specifiers = statement.descendantsOfType("export_specifier");
		if (specifiers.length === 0) {
			imports.push({ source, kind: "reexport-star" });
			continue;
		}
		for (const specifier of specifiers) {
			const imported = specifier.childForFieldName("name")?.text;
			const local = specifier.childForFieldName("alias")?.text ?? imported;
			if (imported && local) imports.push({ source, kind: "reexport", imported, local });
		}
	}
	return imports;
}

// `import "a/b/pkg"` or `import m "a/b/pkg"`. The bound name is the alias, else the
// last path segment (Go convention). References are `pkg.Symbol`.

function extractGo(root: Node): ParsedImport[] {
	const imports: ParsedImport[] = [];
	for (const decl of root.namedChildren) {
		if (decl.type !== "import_declaration") continue;
		const specs = decl.descendantsOfType("import_spec");
		for (const spec of specs) {
			const source = stringValue(spec.childForFieldName("path"));
			if (!source) continue;
			const alias = spec.childForFieldName("name")?.text;
			if (alias === "_") {
				imports.push({ source, kind: "side-effect" }); // blank import: side effects only, binds nothing
			} else if (alias === ".") {
				imports.push({ source, kind: "wildcard" }); // dot import: exposes the package's exported names unqualified
			} else {
				imports.push({ source, kind: "namespace", local: alias ?? lastSegment(source, "/") });
			}
		}
	}
	return imports;
}

// `from pkg.mod import name [as alias]` → named (bare reference). `import pkg.mod [as a]`
// → namespace (dereferenced). Relative imports keep their leading dots in `source`.

function extractPython(root: Node): ParsedImport[] {
	const imports: ParsedImport[] = [];
	for (const statement of root.namedChildren) {
		if (statement.type === "import_statement") {
			for (const child of statement.namedChildren) {
				if (child.type === "aliased_import") {
					const source = dottedText(child.childForFieldName("name"));
					const alias = child.childForFieldName("alias")?.text;
					if (source && alias) imports.push({ source, kind: "namespace", local: alias });
				} else if (child.type === "dotted_name") {
					const source = child.text;
					imports.push({ source, kind: "namespace", local: firstSegment(source, ".") });
				}
			}
			continue;
		}
		if (statement.type !== "import_from_statement") continue;
		const source = moduleSource(statement.childForFieldName("module_name"));
		if (!source) continue;
		for (const child of statement.childrenForFieldName("name")) {
			if (child.type === "aliased_import") {
				const imported = dottedText(child.childForFieldName("name"));
				const alias = child.childForFieldName("alias")?.text;
				if (imported && alias) imports.push({ source, kind: "named", imported, local: alias });
			} else if (child.type === "dotted_name") {
				const imported = child.text;
				imports.push({ source, kind: "named", imported, local: imported });
			}
		}
	}
	return imports;
}

// `import a.b.C` → class C in package a.b (named). `import static a.b.C.m` → member m
// of class a.b.C. `import a.b.*` → wildcard over package a.b.

function extractJava(root: Node): ParsedImport[] {
	const imports: ParsedImport[] = [];
	for (const decl of root.namedChildren) {
		if (decl.type !== "import_declaration") continue;
		const fqn = decl.namedChildren.find((c) => c.type === "scoped_identifier" || c.type === "identifier")?.text;
		if (!fqn) continue;
		const wildcard = decl.namedChildren.some((c) => c.type === "asterisk");
		const isStatic = /^import\s+static\b/.test(decl.text);
		if (wildcard) {
			// `import a.b.*` (package) or `import static a.b.C.*` (members of class a.b.C).
			imports.push({ source: fqn, kind: "wildcard", ...(isStatic ? { isStatic: true } : {}) });
		} else if (isStatic) {
			// `import static a.b.C.m` → member `m` of class `a.b.C`. source = the class FQN.
			imports.push({
				source: dropLast(fqn, "."),
				kind: "named",
				imported: lastSegment(fqn, "."),
				local: lastSegment(fqn, "."),
				isStatic: true,
			});
		} else {
			// `import a.b.C` → class `C` in package `a.b`. source = the package.
			imports.push({
				source: dropLast(fqn, "."),
				kind: "named",
				imported: lastSegment(fqn, "."),
				local: lastSegment(fqn, "."),
			});
		}
	}
	return imports;
}

function moduleSource(node: Node | null): string | undefined {
	if (!node) return undefined;
	if (node.type === "relative_import") {
		const prefix = node.namedChildren.find((c) => c.type === "import_prefix")?.text ?? ".";
		const dotted = node.namedChildren.find((c) => c.type === "dotted_name")?.text ?? "";
		return prefix + dotted;
	}
	return node.text;
}

function dottedText(node: Node | null): string | undefined {
	return node?.text;
}

function stringValue(node: Node | null): string | undefined {
	if (!node) return undefined;
	const fragment = node.descendantsOfType(["string_fragment", "interpreted_string_literal_content"])[0]?.text;
	if (fragment) return fragment;
	const text = node.text;
	if (text.length >= 2 && (text[0] === "'" || text[0] === '"' || text[0] === "`")) return text.slice(1, -1);
	return text;
}

function lastSegment(value: string, sep: string): string {
	const parts = value.split(sep).filter(Boolean);
	return parts.at(-1) ?? value;
}

function firstSegment(value: string, sep: string): string {
	return value.split(sep).filter(Boolean)[0] ?? value;
}

function dropLast(value: string, sep: string): string {
	const parts = value.split(sep);
	return parts.slice(0, -1).join(sep);
}
