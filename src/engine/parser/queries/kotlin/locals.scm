; Minimal scope rules for the per-file scope graph, hand-authored against
; @tree-sitter-grammars/tree-sitter-kotlin node types. Kotlin is block-scoped: function
; bodies, blocks, and class bodies each open a scope.

[
  (function_declaration)
  (function_body)
  (block)
  (class_body)
] @local.scope

(parameter (identifier) @local.definition)
(class_parameter (identifier) @local.definition)
(property_declaration (variable_declaration (identifier) @local.definition))
