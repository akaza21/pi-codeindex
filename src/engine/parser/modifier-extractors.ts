/**
 * Per-language member-modifier extraction: a definition node → `isStatic` /
 * `isAbstract` / `visibility`. These rank inheritance-aware member resolution (a concrete
 * impl outranks an abstract declaration; a class-level member differs from an instance one).
 * A value is set only when there is a cheap language signal for it; an absent field means
 * "unknown", never a guessed default. Consumers treat the values as ranking hints, not hard
 * exclusions (recall-first), so an imperfect signal can never drop a real candidate.
 *
 * Signals used: TS/JS (`static`/`abstract` keywords, accessibility modifiers), Java
 * (`modifiers` node keywords), Python (`@staticmethod` => static, `@abstractmethod` =>
 * abstract, and the `_`/`__` naming *convention* for visibility — a hint, not enforced).
 * `@classmethod` is left unknown (callable via both class and instance). Go visibility is
 * already captured by export status; Ruby's runtime `private`/`protected` is left unknown.
 */

import type { Node } from "web-tree-sitter";
import type { Visibility } from "../model/types.ts";

interface SymbolModifiers {
	isStatic?: boolean;
	isAbstract?: boolean;
	visibility?: Visibility;
}

type ModifierExtractor = (node: Node, name: string) => SymbolModifiers;

const EXTRACTORS: Record<string, ModifierExtractor> = {
	typescript: ecmaScript,
	tsx: ecmaScript,
	javascript: ecmaScript,
	java: java,
	python: python,
};

export function extractModifiers(langId: string, node: Node, name: string): SymbolModifiers {
	return EXTRACTORS[langId]?.(node, name) ?? {};
}

const VISIBILITY = new Set<string>(["public", "protected", "private"]);

//   `static`/`abstract` keywords and `public`/`private`/`protected` accessibility modifiers,
//   for whichever members the tags query emits as symbols.
function ecmaScript(node: Node, _name: string): SymbolModifiers {
	const mods: SymbolModifiers = {};
	for (const child of node.children ?? []) {
		if (child.type === "accessibility_modifier" && VISIBILITY.has(child.text)) {
			mods.visibility = child.text as Visibility;
		} else if (child.type === "static") {
			mods.isStatic = true;
		} else if (child.type === "abstract") {
			mods.isAbstract = true;
		}
	}
	return mods;
}

//   Modifiers live in a `modifiers` child node holding keyword tokens.
function java(node: Node, _name: string): SymbolModifiers {
	const modifiers = (node.children ?? []).find((child) => child.type === "modifiers");
	if (!modifiers) return {};
	const mods: SymbolModifiers = {};
	for (const child of modifiers.children ?? []) {
		if (VISIBILITY.has(child.type)) mods.visibility = child.type as Visibility;
		else if (child.type === "static") mods.isStatic = true;
		else if (child.type === "abstract") mods.isAbstract = true;
	}
	return mods;
}

//   `@staticmethod` => static; `@abstractmethod` => abstract; leading-underscore naming
//   convention => visibility hint. `@classmethod` stays unknown (dual-callable).
function python(node: Node, name: string): SymbolModifiers {
	const mods: SymbolModifiers = {};
	const decorated = node.parent;
	if (decorated?.type === "decorated_definition") {
		for (const child of decorated.children ?? []) {
			if (child.type !== "decorator") continue;
			const decorator = child.text;
			if (/@\s*staticmethod\b/.test(decorator)) mods.isStatic = true;
			if (/@\s*abstractmethod\b/.test(decorator)) mods.isAbstract = true;
		}
	}
	// `__x` (not dunder) is name-mangled/private; a single leading `_` is conventionally protected.
	if (/^__(?!.*__$)/.test(name)) mods.visibility = "private";
	else if (/^_/.test(name)) mods.visibility = "protected";
	return mods;
}
