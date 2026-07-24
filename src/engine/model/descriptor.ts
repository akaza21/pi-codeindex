/**
 * SCIP-style descriptors. A descriptor encodes a declaration's kind into its name via a
 * trailing marker, so a symbol id is self-describing and can be emitted directly as a SCIP
 * symbol. The marker names which namespace the identifier lives in:
 *
 *   `#`   a type      — class, interface, enum, struct, trait, type alias, …
 *   `().` a method    — function, method, constructor
 *   `/`   a namespace — module, package
 *   `.`   a term      — variable, constant, field, property, enum member, …  (the default)
 *
 * Kinds come from the language `tags.scm` capture names, which vary by grammar; the sets
 * below are generous, and any unrecognised kind falls back to a term (`.`), the safe and
 * most common case.
 */

type DescriptorSuffix = "#" | "()." | "/" | ".";

const TYPE_KINDS: ReadonlySet<string> = new Set([
	"class",
	"interface",
	"type",
	"type_alias",
	"typealias",
	"enum",
	"struct",
	"trait",
	"record",
	"annotation",
	"union",
	"typedef",
	"protocol",
	"delegate",
	"template",
]);

const CALLABLE_KINDS: ReadonlySet<string> = new Set(["function", "method", "constructor", "func"]);

const NAMESPACE_KINDS: ReadonlySet<string> = new Set(["module", "namespace", "package"]);

/** The descriptor marker for a declaration kind. */
export function descriptorSuffix(kind: string): DescriptorSuffix {
	if (TYPE_KINDS.has(kind)) return "#";
	if (CALLABLE_KINDS.has(kind)) return "().";
	if (NAMESPACE_KINDS.has(kind)) return "/";
	return ".";
}

/** A name with its kind encoded as a descriptor suffix, e.g. `Foo#`, `bar().`, `x.`. */
export function descriptor(name: string, kind: string): string {
	return `${escapeName(name)}${descriptorSuffix(kind)}`;
}

/**
 * SCIP name escaping: a simple identifier is emitted bare; any other name (one containing
 * reserved characters — e.g. Ruby `@ivar`, a `#private` member, whitespace) is backtick-
 * quoted with embedded backticks doubled, so its characters can never be mistaken for a
 * descriptor marker or a moniker's structural delimiters.
 */
function escapeName(name: string): string {
	return /^[\w$]+$/.test(name) ? name : `\`${name.replaceAll("`", "``")}\``;
}
