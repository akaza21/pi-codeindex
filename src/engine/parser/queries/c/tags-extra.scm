; The shipped tree-sitter-c tags.scm tags definitions only (no call edges) and tags functions on the
; inner `function_declarator` (range excludes the body). Add call references and re-tag at the
; `function_definition` node for a body-inclusive span (dedup keeps the fuller one; same name token).
(call_expression function: (identifier) @name) @reference.call
(function_definition declarator: (function_declarator declarator: (identifier) @name)) @definition.function
