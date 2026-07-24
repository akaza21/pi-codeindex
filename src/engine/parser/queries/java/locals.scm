; Minimal scope rules for the per-file scope graph.
; Hand-authored against tree-sitter-java (npm) node types, seeded by nvim-treesitter's
; java/locals.scm (Apache-2.0). Java is block-scoped: class bodies, method/constructor
; bodies, lambdas, and nested blocks each open a scope.

[
  (class_body)
  (method_declaration)
  (constructor_declaration)
  (block)
  (lambda_expression)
  (for_statement)
  (enhanced_for_statement)
] @local.scope

(formal_parameter name: (identifier) @local.definition)
(spread_parameter (variable_declarator name: (identifier) @local.definition))
(catch_formal_parameter name: (identifier) @local.definition)
(variable_declarator name: (identifier) @local.definition)
(enhanced_for_statement name: (identifier) @local.definition)
