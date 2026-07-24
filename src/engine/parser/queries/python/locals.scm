; Minimal scope rules for the per-file scope graph.
; Hand-authored against tree-sitter-python (npm) node types, seeded by the conventions
; in nvim-treesitter's python/locals.scm (Apache-2.0). Kept small and version-matched
; on purpose: large upstream query files drift against pinned grammar versions.
;
; Scopes: function/lambda bodies and class bodies. The file root is synthetic (added by
; the engine). Tags-symbols (defs of functions/classes/methods) are injected into the
; enclosing scope by the engine; here we only add the lexical locals (params, vars) that
; matter for shadowing, plus the scope ranges.

[
  (function_definition)
  (class_definition)
  (lambda)
] @local.scope

(parameters (identifier) @local.definition)
(default_parameter (identifier) @local.definition)
(typed_parameter (identifier) @local.definition)
(typed_default_parameter (identifier) @local.definition)
(lambda_parameters (identifier) @local.definition)

(assignment left: (identifier) @local.definition)
(for_statement left: (identifier) @local.definition)
