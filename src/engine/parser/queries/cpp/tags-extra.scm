; The shipped tree-sitter-cpp tags.scm tags definitions only (no call/reference edges) and tags
; functions/methods on the inner `function_declarator`, whose range excludes the body — too narrow
; to act as the enclosing scope for calls inside it. Add call references, and re-tag definitions at
; the `function_definition` node so the symbol span includes the body. The name token is identical,
; so dedup collapses the pair and keeps the fuller-range tag.
(call_expression function: (identifier) @name) @reference.call
(call_expression function: (field_expression field: (field_identifier) @name)) @reference.call

(function_definition declarator: (function_declarator declarator: (identifier) @name)) @definition.function
(function_definition declarator: (function_declarator declarator: (field_identifier) @name)) @definition.method

; Qualified members, the common 1- to 3-level forms (`C::m`, `Ns::C::m`, `A::B::C::m`); a 4+ level
; qualifier (tree-sitter queries can't recurse) is unsupported. The owning type is recovered from
; the qualifier in code, and qualified CALLS carry the qualifier as a receiver so the scope resolver
; defers them (a bare `m` would otherwise bind confidently to every same-named `m`).
(call_expression function: (qualified_identifier name: (identifier) @name)) @reference.call
(call_expression function: (qualified_identifier name: (qualified_identifier name: (identifier) @name))) @reference.call
(call_expression function: (qualified_identifier name: (qualified_identifier name: (qualified_identifier name: (identifier) @name)))) @reference.call
(function_definition declarator: (function_declarator declarator: (qualified_identifier name: (identifier) @name))) @definition.method
(function_definition declarator: (function_declarator declarator: (qualified_identifier name: (qualified_identifier name: (identifier) @name)))) @definition.method
(function_definition declarator: (function_declarator declarator: (qualified_identifier name: (qualified_identifier name: (qualified_identifier name: (identifier) @name))))) @definition.method
