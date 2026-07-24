; Augment the borrowed tree-sitter-c-sharp tags.scm: it captures classes/interfaces/methods/
; namespaces and member-access calls, but not properties or bare (non-member) calls. Add those.
(property_declaration name: (identifier) @name) @definition.property
(invocation_expression function: (identifier) @name) @reference.call

; Generic invocations: the callee identifier is wrapped in a generic_name (e.g. `Foo<int>(x)`,
; `obj.Foo<int>(x)`), which the shipped/identifier-only patterns miss.
(invocation_expression function: (generic_name (identifier) @name)) @reference.call
(invocation_expression function: (member_access_expression name: (generic_name (identifier) @name))) @reference.send
