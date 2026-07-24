; Minimal scope rules for the per-file scope graph.
; Hand-authored against tree-sitter-go (npm) node types, seeded by nvim-treesitter's
; go/locals.scm (Apache-2.0). Go is block-scoped: function/method bodies, function
; literals, and nested blocks each open a scope.

[
  (function_declaration)
  (method_declaration)
  (func_literal)
  (block)
] @local.scope

(parameter_declaration (identifier) @local.definition)
(variadic_parameter_declaration (identifier) @local.definition)
(short_var_declaration left: (expression_list (identifier) @local.definition))
(var_spec (identifier) @local.definition)
(const_spec (identifier) @local.definition)
(range_clause left: (expression_list (identifier) @local.definition))
