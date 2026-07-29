; Distinguish interfaces from other Go type declarations. The upstream tags query
; labels every type_spec as definition.type, which is insufficient for capability notices.
(type_spec
  name: (type_identifier) @name
  type: (interface_type)) @definition.interface
