; Minimal scope rules for the per-file scope graph, hand-authored against tree-sitter-php node
; types. PHP variables are function-scoped, so each callable body is a scope; parameters are the
; bindable locals (plain `$var` assignments are not declarations).

[
  (function_definition)
  (method_declaration)
  (anonymous_function)
  (arrow_function)
] @local.scope

(simple_parameter name: (variable_name (name) @local.definition))
