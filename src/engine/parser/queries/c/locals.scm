; Minimal scope rules for the per-file scope graph, hand-authored against tree-sitter-c node types.
; C is block-scoped: function bodies and nested blocks each open a scope.

[
  (function_definition)
  (compound_statement)
] @local.scope

(parameter_declaration declarator: (identifier) @local.definition)
(parameter_declaration declarator: (pointer_declarator declarator: (identifier) @local.definition))
(init_declarator declarator: (identifier) @local.definition)
(init_declarator declarator: (pointer_declarator declarator: (identifier) @local.definition))
