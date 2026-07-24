; The shipped tree-sitter-php tags.scm tags methods as plain functions; re-tag them as methods
; (dedup keeps the more specific kind). The method_declaration node already spans the body.
(method_declaration name: (name) @name) @definition.method

; The shipped tags only tag qualified (`\Ns\f()`) and variable function calls; add the common case
; of an unqualified function call (`helper()`), whose function is a bare `name` node.
(function_call_expression function: (name) @name) @reference.call
