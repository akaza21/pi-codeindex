/**
 * Arity extraction: a callable definition's parameter count (and whether it is
 * variadic), and a call site's argument count. These feed a conservative ranking
 * signal — among ambiguous same-name candidates, one that cannot accept the call's
 * argument count is down-weighted (never dropped), so recall is preserved.
 *
 * Counting is structural (named children of the parameter/argument list), which is
 * uniform enough across languages; only variadic detection is language-flavoured.
 * Where a grammar doesn't expose a parameter/argument list the result is `undefined`
 * (unknown), and the ranking signal simply doesn't fire.
 */

import type { Node } from "web-tree-sitter";

/** Node types that hold a parameter list, across the supported grammars. */
const PARAM_LIST = /^(formal_parameters|parameters|parameter_list|method_parameters)$/;
/** Node types that hold a call's argument list. */
const ARG_LIST = /^(arguments|argument_list)$/;
/** Call-expression node types whose argument list gives a call site its arity. */
const CALL_NODE =
	/^(call_expression|call|method_invocation|function_call_expression|new_expression|invocation_expression|member_call_expression)$/;
/** Parameter node types that make a callable accept a variable number of arguments. */
const VARIADIC_PARAM = /rest|spread|splat|variadic/;

interface ParamArity {
	paramCount: number;
	variadic: boolean;
}

/** Declared parameter arity of a callable definition node, or undefined if it has no list. */
export function paramArity(defNode: Node): ParamArity | undefined {
	const list = findChild(defNode, PARAM_LIST);
	if (!list) return undefined;
	const params = list.namedChildren.filter((child) => child.type !== "comment");
	return { paramCount: params.length, variadic: params.some(isVariadicParam) };
}

/** A param is variadic if it (or its immediate pattern child, e.g. TS `...rest`) is a rest/splat. */
function isVariadicParam(param: Node): boolean {
	return VARIADIC_PARAM.test(param.type) || param.namedChildren.some((child) => VARIADIC_PARAM.test(child.type));
}

/** Argument count of the call enclosing a callee name node, or undefined if not a call. */
export function callArgCount(nameNode: Node): number | undefined {
	// The callee name is the call's own child (`foo(...)`), or nested in a member/selector
	// expression (`obj.foo(...)`), or both plus a generic_name wrapper (`obj.foo<T>(...)`); the call
	// node is up to three levels up.
	let node: Node | null = nameNode.parent;
	for (let depth = 0; node && depth < 3; depth++, node = node.parent) {
		if (CALL_NODE.test(node.type)) {
			const args = findChild(node, ARG_LIST);
			return args ? args.namedChildren.filter((child) => child.type !== "comment").length : 0;
		}
	}
	return undefined;
}

function findChild(node: Node, pattern: RegExp): Node | undefined {
	return node.namedChildren.find((child) => pattern.test(child.type));
}
