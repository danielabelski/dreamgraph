/**
 * DreamGraph — Scanner ontology.
 *
 * Controlled vocabulary for the polyglot graph scanner. This module is the
 * single source of truth for the kinds of nodes the scanner emits and the
 * relationships it draws between them. Every extractor MUST import these
 * constants instead of writing raw string literals into entity or edge
 * fields.
 *
 * Companion to plans/polyglot-graph-scanning-native-jvm-plan.md and
 * plans/polyglot-graph-scanning-implementation-plan.md.
 *
 * Layering:
 *   - `EntityKind` maps onto `DataModelEntity.entity_kind` and similar
 *     string slots in src/types/index.ts. No type changes required.
 *   - `Relationship` maps onto `GraphLink.relationship`.
 *   - `Confidence` maps onto `GraphLink.meta.confidence`.
 *
 * This file is pure data: no I/O, no behaviour. Safe to import from
 * anywhere (tools, extractors, tests, explorer).
 */

// ---------------------------------------------------------------------------
// Entity kinds
// ---------------------------------------------------------------------------

/**
 * Core code-level entities. Cover declarations and definitions for the
 * languages targeted in wave 1 (C, C++, Rust) and the languages that wave 2
 * will add (Java, Kotlin, C#, Go, Swift, Objective-C).
 */
export const CodeEntityKind = {
  // Containers
  Repository: "Repository",
  Workspace: "Workspace",
  Package: "Package",
  BuildTarget: "BuildTarget",
  Module: "Module",
  Namespace: "Namespace",

  // Files
  File: "File",
  HeaderFile: "HeaderFile",
  SourceFile: "SourceFile",
  GeneratedFile: "GeneratedFile",

  // Type declarations
  Type: "Type",
  Struct: "Struct",
  Class: "Class",
  Record: "Record",
  Union: "Union",
  Interface: "Interface",
  Trait: "Trait",
  Enum: "Enum",
  EnumMember: "EnumMember",
  TypeAlias: "TypeAlias",

  // Callables
  Function: "Function",
  Method: "Method",
  Constructor: "Constructor",
  Destructor: "Destructor",

  // Members
  Field: "Field",
  Property: "Property",
  Constant: "Constant",
  Macro: "Macro",

  // Annotations
  Annotation: "Annotation",
  Attribute: "Attribute",

  // Function shape
  Parameter: "Parameter",
  ReturnType: "ReturnType",
  LocalVariable: "LocalVariable",
} as const;

export type CodeEntityKind =
  (typeof CodeEntityKind)[keyof typeof CodeEntityKind];

/**
 * Type-shape entities. Describe the surface of a type expression
 * (pointer depth, optionality, smart-pointer kind, generic instantiation).
 * Modelled as separate node kinds so they can be reused across languages
 * — `PointerType` in C, `Box<T>` in Rust, `unique_ptr<T>` in C++ all map
 * onto either `PointerType` or `SmartPointerType`.
 */
export const TypeShapeKind = {
  PointerType: "PointerType",
  PointerToPointerType: "PointerToPointerType",
  ReferenceType: "ReferenceType",
  NullableType: "NullableType",
  ArrayType: "ArrayType",
  SliceType: "SliceType",
  VectorType: "VectorType",
  MapType: "MapType",
  SetType: "SetType",
  OptionType: "OptionType",
  ResultType: "ResultType",
  SmartPointerType: "SmartPointerType",
  FunctionPointerType: "FunctionPointerType",
  CallbackType: "CallbackType",
  GenericType: "GenericType",
  TemplateType: "TemplateType",
} as const;

export type TypeShapeKind =
  (typeof TypeShapeKind)[keyof typeof TypeShapeKind];

/**
 * Architecture / data-shape entities. Higher-level structural patterns
 * recognized across language boundaries — a singly-linked list looks the
 * same whether expressed in C, Rust, or Kotlin.
 */
export const DataShapeKind = {
  LinkedListShape: "LinkedListShape",
  DoublyLinkedListShape: "DoublyLinkedListShape",
  IntrusiveListShape: "IntrusiveListShape",
  TreeShape: "TreeShape",
  GraphShape: "GraphShape",
  HashTableShape: "HashTableShape",
  ArrayWithCountShape: "ArrayWithCountShape",
  ArenaAllocatorShape: "ArenaAllocatorShape",
  ObjectPoolShape: "ObjectPoolShape",
  HandleTableShape: "HandleTableShape",
  OwnershipShape: "OwnershipShape",
  BorrowingShape: "BorrowingShape",
  ObserverShape: "ObserverShape",
  CallbackRegistryShape: "CallbackRegistryShape",
  FFIBridge: "FFIBridge",
  GeneratedBinding: "GeneratedBinding",
  SchemaContract: "SchemaContract",
} as const;

export type DataShapeKind =
  (typeof DataShapeKind)[keyof typeof DataShapeKind];

/**
 * Union of all entity kinds emitted by the scanner. Use this type when
 * writing into `entity_kind` slots that previously accepted freeform
 * strings.
 */
export type EntityKind = CodeEntityKind | TypeShapeKind | DataShapeKind;

// ---------------------------------------------------------------------------
// Relationships (edge labels)
// ---------------------------------------------------------------------------

/**
 * Canonical edge labels emitted by the scanner. Use these constants when
 * populating `GraphLink.relationship`. New extractors that need a new edge
 * type MUST add the constant here first.
 */
export const Relationship = {
  // Declaration / definition
  DECLARES: "DECLARES",
  DEFINES: "DEFINES",
  DECLARES_TYPE: "DECLARES_TYPE",
  DECLARES_FUNCTION: "DECLARES_FUNCTION",
  DECLARES_FIELD: "DECLARES_FIELD",
  DECLARES_METHOD: "DECLARES_METHOD",
  DECLARES_CONSTANT: "DECLARES_CONSTANT",
  DECLARES_ENUM_MEMBER: "DECLARES_ENUM_MEMBER",

  // Function shape
  HAS_PARAMETER: "HAS_PARAMETER",
  RETURNS: "RETURNS",

  // Types
  HAS_TYPE: "HAS_TYPE",
  REFERENCES_TYPE: "REFERENCES_TYPE",

  // Pointers / ownership
  POINTS_TO: "POINTS_TO",
  POINTS_TO_POINTER: "POINTS_TO_POINTER",
  OWNS: "OWNS",
  OWNS_SHARED: "OWNS_SHARED",
  BORROWS: "BORROWS",
  BORROWS_WEAK: "BORROWS_WEAK",

  // Containment
  CONTAINS: "CONTAINS",
  CONTAINS_MANY: "CONTAINS_MANY",
  MAY_CONTAIN: "MAY_CONTAIN",
  MAPS_K_TO_V: "MAPS_K_TO_V",
  EMBEDS: "EMBEDS",
  PARTICIPATES_IN: "PARTICIPATES_IN",

  // Inheritance
  EXTENDS: "EXTENDS",
  IMPLEMENTS: "IMPLEMENTS",
  IMPLEMENTS_TRAIT: "IMPLEMENTS_TRAIT",
  USES_TRAIT: "USES_TRAIT",
  SPECIALIZES: "SPECIALIZES",

  // Annotations / attributes
  HAS_ANNOTATION: "HAS_ANNOTATION",

  // Call / data flow
  CALLS: "CALLS",
  READS_FIELD: "READS_FIELD",
  WRITES_FIELD: "WRITES_FIELD",

  // Module / file graph
  INCLUDES: "INCLUDES",
  IMPORTS: "IMPORTS",
  EXPORTS: "EXPORTS",

  // Cross-file binding
  BINDS_DECLARATION_TO_DEFINITION: "BINDS_DECLARATION_TO_DEFINITION",

  // Generated code / contracts
  GENERATES: "GENERATES",
  GENERATED_FROM: "GENERATED_FROM",
  BRIDGES_TO: "BRIDGES_TO",
  SERIALIZES_AS: "SERIALIZES_AS",
  DESERIALIZES_FROM: "DESERIALIZES_FROM",

  // Build / lifecycle
  CONFIGURES: "CONFIGURES",
  BUILDS: "BUILDS",
  TESTS: "TESTS",
} as const;

export type Relationship = (typeof Relationship)[keyof typeof Relationship];

// ---------------------------------------------------------------------------
// Field roles within a data shape
// ---------------------------------------------------------------------------

/**
 * Role of a field within a recognized data shape. Attached as edge meta
 * when a `Field` participates in a `LinkedListShape` / `TreeShape` /
 * `ArrayWithCountShape` / etc.
 */
export const FieldRole = {
  // Linked list / tree
  Next: "next",
  Previous: "prev",
  Head: "head",
  Tail: "tail",
  Parent: "parent",
  Left: "left",
  Right: "right",
  FirstChild: "first_child",
  NextSibling: "next_sibling",
  Children: "children",

  // Array with count
  Pointer: "pointer",
  Count: "count",
  Capacity: "capacity",

  // Hash table
  Buckets: "buckets",
  Hash: "hash",

  // Callback registry
  Callback: "callback",
  UserData: "user_data",
} as const;

export type FieldRole = (typeof FieldRole)[keyof typeof FieldRole];

// ---------------------------------------------------------------------------
// Confidence
// ---------------------------------------------------------------------------

/**
 * Confidence assigned to a heuristic detection. Edges below `medium`
 * confidence may still be emitted, but downstream consumers (LLM
 * enrichment, explorer rendering) treat them as candidates rather than
 * facts.
 */
export const Confidence = {
  Low: "low",
  Medium: "medium",
  High: "high",
} as const;

export type Confidence = (typeof Confidence)[keyof typeof Confidence];

// ---------------------------------------------------------------------------
// Edge evidence
// ---------------------------------------------------------------------------

/**
 * Required evidence fields on every scanner-emitted edge. Populated into
 * `GraphLink.meta` (which is freeform, so no type change is needed).
 */
export interface EdgeEvidence {
  /** Extractor that emitted this edge (e.g. "c", "cpp", "rust"). */
  extractor: string;
  /** Extractor version — bump when extraction logic changes. */
  extractor_version: string;
  /** True when emitted by a parser-backed extractor (tree-sitter etc.). */
  parser_backed: boolean;
  /** Heuristic confidence. */
  confidence: Confidence;
  /** Source language of the file the evidence was found in. */
  language: string;
  /** 1-based line of the evidence in the source file. */
  line?: number;
  /** 1-based column of the evidence in the source file. */
  column?: number;
}
