; Minimal scope rules for the per-file scope graph, hand-authored against tree-sitter-rust
; node types. Rust is block-scoped: function bodies, closures, and nested blocks each open a scope.

[
  (function_item)
  (closure_expression)
  (block)
] @local.scope

(parameter pattern: (identifier) @local.definition)
(let_declaration pattern: (identifier) @local.definition)
(closure_parameters (identifier) @local.definition)

; Tuple destructuring, one level deep, e.g. `let (a, b) = ...` or `fn f((x, y): ...)`. Nested
; patterns bind only their outermost names (rare in practice; deeper recursion not worth the query).
(parameter pattern: (tuple_pattern (identifier) @local.definition))
(let_declaration pattern: (tuple_pattern (identifier) @local.definition))
