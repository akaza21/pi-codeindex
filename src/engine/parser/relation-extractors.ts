/**
 * Per-language inheritance extraction: a file's AST → `extends` / `implements`
 * references. These are ordinary references carrying an inheritance role, so they resolve
 * through the same binders as calls — the resolved target is the base type/interface and
 * the enclosing definition is the subtype. That makes the type hierarchy queryable
 * ("who extends X", "what does X implement") for free.
 *
 * Heritage *syntax* differs per language and lives in one focused function each; the
 * *resolution* of the extracted name reuses resolve/cross-file.ts and the syntactic resolver's binder.
 * Go embedding and Rust `impl ... for` are not modeled as inheritance edges.
 */

import type { Node } from "web-tree-sitter";
import type { ReferenceRole } from "../model/types.ts";
import type { ParsedReference } from "../ports.ts";

type RelationExtractor = (root: Node) => ParsedReference[];

const EXTRACTORS: Record<string, RelationExtractor> = {
	typescript: extractEcmaScript,
	tsx: extractEcmaScript,
	javascript: extractEcmaScript,
	python: extractPython,
	java: extractJava,
	ruby: extractRuby,
	kotlin: extractKotlin,
	csharp: extractCSharp,
	cpp: extractCpp,
	php: extractPhp,
	scala: extractScala,
};

export function extractRelations(langId: string, root: Node): ParsedReference[] {
	return EXTRACTORS[langId]?.(root) ?? [];
}

/** Resolve a heritage entry node to a bindable `{ name, receiver? }` type reference. */
function typeRef(node: Node): { name: string; receiver?: string; node: Node } | undefined {
	switch (node.type) {
		case "identifier":
		case "type_identifier":
		case "constant":
		case "property_identifier":
		case "name": // PHP type/class name
			return node.text ? { name: node.text, node } : undefined;
		// Parameterized base (`Foo<T>`): bind on the constructor name, ignore type args.
		case "generic_type":
		// C# generic base (`Base<int>`): the `generic_name` wraps the identifier + type args.
		case "generic_name":
			return firstChildRef(node.childForFieldName("name") ?? node.namedChildren[0]);
		// C# qualified base (`Ns.Base<int>`, `IFoo.Bar`): bind on the final `name` segment, which may
		// itself be a generic_name, and carry the qualifier as the receiver (matching the `a.b.C` ->
		// receiver `a.b` model) so a namespaced base can be disambiguated.
		case "qualified_name": {
			const seg = node.childForFieldName("name");
			const inner = seg ? typeRef(seg) : undefined;
			if (!inner) return qualifiedRef(node);
			const qualifier = node.childForFieldName("qualifier")?.text;
			return qualifier ? { ...inner, receiver: qualifier } : inner;
		}
		// Python generic base (`Base[T]`): bind on the subscripted value.
		case "subscript":
			return firstChildRef(node.childForFieldName("value") ?? node.namedChildren[0]);
		// Qualified bases (`ns.Base`, `a.b.Base`): bind on the last segment, prefix = receiver.
		case "member_expression":
		case "attribute":
		case "nested_type_identifier":
		case "scoped_type_identifier":
		case "scoped_identifier":
		case "scope_resolution":
			return qualifiedRef(node);
		// Kotlin supertype (`: Base`, `: pkg.Iface`): the user_type wraps the (possibly qualified) name.
		case "user_type":
			return qualifiedRef(node);
		// Reject anything that is not a plain/qualified type reference (e.g. a JS mixin
		// `extends wrap(Base)` call expression) so we never invent a false inheritance edge.
		default:
			return undefined;
	}
}

function firstChildRef(node: Node | null | undefined): ReturnType<typeof typeRef> {
	return node ? typeRef(node) : undefined;
}

/** Last identifier-ish segment is the bound name; everything before it is the receiver. */
function qualifiedRef(node: Node): ReturnType<typeof typeRef> {
	const idents = node.namedChildren.filter((c) => /identifier|constant/.test(c.type));
	const last = idents[idents.length - 1];
	if (!last?.text) return firstChildRef(node.namedChildren[0]);
	// Full qualifier text before the final segment, matching the call receiver model
	// (`a.b.C` -> receiver `a.b`), so the cross-file binders can match a namespace import.
	const receiver = node.text.slice(0, last.startIndex - node.startIndex).replace(/[\s.:]+$/, "");
	return { name: last.text, node: last, ...(receiver ? { receiver } : {}) };
}

function relation(node: Node, role: ReferenceRole): ParsedReference | undefined {
	const ref = typeRef(node);
	if (!ref) return undefined;
	return {
		name: ref.name,
		role,
		range: [
			ref.node.startPosition.row + 1,
			ref.node.startPosition.column,
			ref.node.endPosition.row + 1,
			ref.node.endPosition.column,
		],
		...(ref.receiver ? { receiver: ref.receiver } : {}),
	};
}

/** Emit a relation for every named child of a heritage clause (skipping type-argument nodes). */
function fromClause(clause: Node | null | undefined, role: ReferenceRole, out: ParsedReference[]): void {
	if (!clause) return;
	for (const child of clause.namedChildren) {
		if (child.type === "type_arguments" || child.type === "type_parameters") continue;
		const ref = relation(child, role);
		if (ref) out.push(ref);
	}
}

//   class C extends Base implements I, J {}   interface I extends A, B {}
function extractEcmaScript(root: Node): ParsedReference[] {
	const out: ParsedReference[] = [];
	walk(root, (node) => {
		switch (node.type) {
			case "extends_clause": // TS `class C extends Base`
			case "extends_type_clause": // TS `interface I extends A, B`
				fromClause(node, "extends", out);
				break;
			case "implements_clause":
				fromClause(node, "implements", out);
				break;
			case "class_heritage":
				// JS form: `class_heritage` directly wraps the superclass expression(s);
				// in TS it wraps `extends_clause`/`implements_clause` (handled above).
				for (const child of node.namedChildren) {
					if (child.type.endsWith("_clause")) continue;
					const ref = relation(child, "extends");
					if (ref) out.push(ref);
				}
				break;
		}
	});
	return out;
}

//   class C(Base, Mixin, metaclass=M):   (no implements; keyword args skipped)
function extractPython(root: Node): ParsedReference[] {
	const out: ParsedReference[] = [];
	walk(root, (node) => {
		if (node.type !== "class_definition") return;
		const bases = node.childForFieldName("superclasses");
		if (!bases) return;
		for (const child of bases.namedChildren) {
			if (child.type === "keyword_argument") continue;
			const ref = relation(child, "extends");
			if (ref) out.push(ref);
		}
	});
	return out;
}

//   class C extends Base implements I, J {}   interface I extends A, B {}
//   Driven by clause node TYPE (robust across grammar field-name changes).
function extractJava(root: Node): ParsedReference[] {
	const out: ParsedReference[] = [];
	walk(root, (node) => {
		switch (node.type) {
			case "superclass": // class extends Base
				fromClause(node, "extends", out);
				break;
			case "super_interfaces": // class implements I, J
				fromClause(typeList(node), "implements", out);
				break;
			case "extends_interfaces": // interface I extends A, B
				fromClause(typeList(node), "extends", out);
				break;
		}
	});
	return out;
}

/** Java heritage clauses wrap a `type_list`; unwrap to the node holding the type entries. */
function typeList(node: Node): Node {
	return node.namedChildren.find((c) => c.type === "type_list") ?? node;
}

//   class C < Base   (`include` and `prepend` are method calls, not superclass syntax)
function extractRuby(root: Node): ParsedReference[] {
	const out: ParsedReference[] = [];
	walk(root, (node) => {
		if (node.type !== "class") return;
		// The `superclass` field wraps `< <Constant>`; bind on the constant after it.
		const target = node.childForFieldName("superclass")?.namedChildren[0];
		const ref = target ? relation(target, "extends") : undefined;
		if (ref) out.push(ref);
	});
	return out;
}

//   class C(...) : Base(), Iface   /   class C : Iface
// Kotlin does not syntactically distinguish a superclass from an implemented interface (both sit
// in `delegation_specifiers`), so every supertype is emitted as `extends` — the hierarchy is what
// queries need; the extends/implements split is secondary and not recoverable without type info.
function extractKotlin(root: Node): ParsedReference[] {
	const out: ParsedReference[] = [];
	walk(root, (node) => {
		if (node.type !== "delegation_specifier") return;
		// A supertype is either a bare `user_type` (interface/class) or, when the superclass
		// constructor is invoked (`Base()`), a `constructor_invocation` wrapping the `user_type`.
		const first = node.namedChildren[0];
		const userType = first?.type === "user_type" ? first : first?.namedChildren.find((c) => c.type === "user_type");
		const ref = userType ? relation(userType, "extends") : undefined;
		if (ref) out.push(ref);
	});
	return out;
}

//   class C extends Base implements IFoo, IBar { ... }
// PHP separates the superclass (`base_clause`) from interfaces (`class_interface_clause`), so the
// roles are exact (unlike Kotlin/C#). The shipped tags tag the implements clause as a generic
// reference; this gives the precise extends/implements edges the hierarchy queries need.
function extractPhp(root: Node): ParsedReference[] {
	const out: ParsedReference[] = [];
	walk(root, (node) => {
		if (node.type === "base_clause") fromClause(node, "extends", out);
		else if (node.type === "class_interface_clause") fromClause(node, "implements", out);
	});
	return out;
}

//   class C extends Base with Trait1 with Trait2
// The `extends_clause` holds the superclass and mixin traits (separated by `with` keyword nodes,
// which typeRef skips); like Kotlin, the superclass/trait split is not recoverable without type
// info, so every entry is emitted as `extends`.
function extractScala(root: Node): ParsedReference[] {
	const out: ParsedReference[] = [];
	walk(root, (node) => {
		if (node.type === "extends_clause") fromClause(node, "extends", out);
	});
	return out;
}

//   class Circle : public Shape, IDrawable { ... }
// A `base_class_clause` holds the bases (with access_specifier tokens, which are unnamed-for-typeRef
// and skipped); every base becomes an `extends` edge — C++ has no separate interface concept.
function extractCpp(root: Node): ParsedReference[] {
	const out: ParsedReference[] = [];
	walk(root, (node) => {
		if (node.type === "base_class_clause") fromClause(node, "extends", out);
	});
	return out;
}

//   class C : Base, IFoo, IBar { }   interface I : IBase { }
// Like Kotlin, C# does not syntactically distinguish a base class from implemented interfaces in
// the `base_list` (the first entry MAY be a class), so every entry is emitted as `extends` — the
// hierarchy is what queries need; the split is not recoverable without type info.
function extractCSharp(root: Node): ParsedReference[] {
	const out: ParsedReference[] = [];
	walk(root, (node) => {
		if (node.type === "base_list") fromClause(node, "extends", out);
	});
	return out;
}

function walk(node: Node, visit: (node: Node) => void): void {
	visit(node);
	for (const child of node.namedChildren) walk(child, visit);
}
