; Kotlin symbols + references. Hand-authored against @tree-sitter-grammars/tree-sitter-kotlin
; node types (the grammar package ships a prebuilt .wasm but no queries). Interfaces parse as
; `class_declaration` in this grammar, so they surface as definition.class.

(class_declaration name: (identifier) @name) @definition.class
(object_declaration name: (identifier) @name) @definition.object
(function_declaration name: (identifier) @name) @definition.function
; Only class-body and top-level properties are symbols; `val`/`var` inside a function body is a
; local (Kotlin reuses property_declaration for both) and is handled by locals.scm instead.
(class_body (property_declaration (variable_declaration (identifier) @name)) @definition.property)
(source_file (property_declaration (variable_declaration (identifier) @name)) @definition.property)
; Only `val`/`var` primary-constructor parameters are properties; a plain `class_parameter` (no
; val/var) is just a constructor parameter (a local), handled by locals.scm.
(class_parameter ["val" "var"] (identifier) @name) @definition.property

; Plain call: the callee is the first child identifier of the call expression.
(call_expression . (identifier) @name) @reference.call
; Receiver call `recv.method(...)`: the method is the identifier after the dot. The receiver may be
; any expression (simple `g`, chained `a.b`, or `this`); the parser extracts its text separately.
(call_expression (navigation_expression (_) "." (identifier) @name)) @reference.call

; Type usages (supertypes, parameter/return/property types, annotations).
(user_type (identifier) @name) @reference.type
