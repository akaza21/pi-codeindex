; Minimal scope rules for the per-file scope graph, hand-authored against tree-sitter-c-sharp
; node types. C# is block-scoped: method/constructor/local-function bodies, lambdas, and nested
; blocks each open a scope.

[
  (method_declaration)
  (constructor_declaration)
  (local_function_statement)
  (lambda_expression)
  (block)
] @local.scope

(parameter name: (identifier) @local.definition)
(variable_declarator (identifier) @local.definition)
(foreach_statement left: (identifier) @local.definition)
(catch_declaration name: (identifier) @local.definition)
