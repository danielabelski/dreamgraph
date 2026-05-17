/**
 * DreamGraph — Kotlin language extractor (wave 2, phases KT-1..KT-3).
 *
 * KT-1: top-level items.
 *   - `package` declaration → Package entity (`com.example.foo`).
 *   - `import` declarations → IMPORTS edges from the file entity to
 *     `kotlin:type:Foo` (or `kotlin:use:foo.bar.*` for wildcards).
 *   - `class_declaration` covers Kotlin `class` / `interface` /
 *     `data class` / `sealed class` / `enum class` / `annotation class`
 *     / `sealed interface`. The grammar uses a single `class_declaration`
 *     node and the kind discriminator lives in `modifiers > class_modifier`
 *     plus the anonymous `class` / `interface` keyword token.
 *   - `object_declaration` (top-level singleton or anonymous object) →
 *     Class entity with `attrs.is_object = true`.
 *
 * KT-2: members and shapes.
 *   - `class_parameter` inside a `primary_constructor` that carries a
 *     `binding_pattern_kind` (val/var) → Field entity on the owning
 *     class (Kotlin's primary-constructor property shorthand).
 *   - `property_declaration` → Field entity. `const val` properties
 *     also surface as Constant entities (mirrors the Java extractor's
 *     `static final` handling).
 *   - `function_declaration` →
 *       * top-level → Function entity.
 *       * inside a class body → Method entity.
 *       * with a `user_type` receiver before the name → Function with
 *         `attrs.receiver_type` + a `REFERENCES_TYPE` edge to the
 *         receiver so extension functions are linkable.
 *   - `primary_constructor` → Constructor entity.
 *   - `enum_entry` → EnumMember entity.
 *   - `companion_object` → Class entity with `attrs.is_companion = true`.
 *
 *   Type-shape classification mirrors the Java extractor's vocabulary:
 *     - `List<T>` / `MutableList<T>` / `Set<T>` / `Sequence<T>` →
 *       CONTAINS_MANY via "list" / "mutable_list" / "set" / "sequence"
 *     - `Map<K,V>` / `MutableMap<K,V>`                    → MAPS_K_TO_V
 *     - `Optional<T>` (java.util) / `Lazy<T>`             → MAY_CONTAIN
 *     - `Array<T>`                                        → CONTAINS_MANY via "array"
 *     - `Flow<T>` / `StateFlow<T>` / `SharedFlow<T>`      → CONTAINS_MANY via "flow"/...
 *     - `Result<T>`                                       → MAY_CONTAIN via "result"
 *     - plain user types                                  → EMBEDS via "value"
 *
 *   Nullability is recorded language-agnostically: `nullable_type`
 *   wrappers set `is_nullable: true` on the Field attrs and the
 *   resulting shape edge's `meta`.
 *
 * KT-3: inheritance and annotations.
 *   - `delegation_specifier` containing a `constructor_invocation` →
 *     EXTENDS edge to the superclass (Kotlin allows exactly one).
 *   - `delegation_specifier` containing a plain `user_type` → IMPLEMENTS
 *     edge to that interface (or EXTENDS for sealed-interface inheritance
 *     where the declaration itself is an interface — symmetrical with
 *     the Java extractor's super-interface handling).
 *   - `@Annotation` on any type/property/function/parameter → HAS_ANNOTATION
 *     edge to `kotlin:type:Annotation`.
 *
 * Coherence note (see polyglot intermediate-layer audit): every Field
 * entity must carry `attrs.owner_qualified_name` so the bridge's
 * `indexEntities` buckets fields onto their owning type without
 * relying on substring parsing of the field's qualifiedName.
 *
 * Language-specific construct labels (`"flow"`, `"data_class"`,
 * `"primary_constructor_property"`, …) live only in `edge.meta.via`
 * or `entity.attrs`. The canonical CodeEntityKind + Relationship
 * vocabulary is shared with the C / C++ / Rust / Java extractors.
 */

import type { SyntaxNode } from "web-tree-sitter";

import {
  CodeEntityKind,
  Confidence,
  Relationship,
  type EdgeEvidence,
} from "../ontology.js";
import { getParser } from "../parser-bootstrap.js";
import type {
  ExtractFileInput,
  ExtractedEdge,
  ExtractedEntity,
  Extractor,
  ExtractorDiagnostic,
  ExtractorOutput,
} from "../types.js";

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

const NAME = "kotlin";
const VERSION = "0.1.0";
const LANGUAGE = "kotlin";
const EXTENSIONS: readonly string[] = [".kt", ".kts"];

function fileId(relPath: string): string {
  return `${LANGUAGE}:${relPath}`;
}

function entityId(relPath: string, kind: string, qualifiedName: string): string {
  return `${LANGUAGE}:${relPath}#${kind}:${qualifiedName}`;
}

function evidence(
  node: SyntaxNode,
  confidence: Confidence = Confidence.High,
): EdgeEvidence {
  return {
    extractor: NAME,
    extractor_version: VERSION,
    parser_backed: true,
    confidence,
    language: LANGUAGE,
    line: node.startPosition.row + 1,
    column: node.startPosition.column + 1,
  };
}

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

function nodeText(node: SyntaxNode | null | undefined): string {
  return node ? node.text : "";
}

function joinTypeQn(prefix: string, name: string): string {
  return prefix ? `${prefix}.${name}` : name;
}

function lastDotSegment(text: string): string {
  const cleaned = text.trim();
  const idx = cleaned.lastIndexOf(".");
  return (idx >= 0 ? cleaned.slice(idx + 1) : cleaned).trim();
}

function namedChildOfKind(
  node: SyntaxNode,
  kinds: ReadonlySet<string>,
): SyntaxNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child && kinds.has(child.type)) return child;
  }
  return null;
}

function namedChildrenOfKind(
  node: SyntaxNode,
  kinds: ReadonlySet<string>,
): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child && kinds.has(child.type)) out.push(child);
  }
  return out;
}

/**
 * Find the first child whose `type` matches one of `keywords`. The
 * tree-sitter-kotlin grammar exposes keywords like `interface`,
 * `object`, `companion`, `sealed`, `fun` as NAMED nodes (unlike
 * tree-sitter-java where they are anonymous tokens). We therefore
 * don't filter by `isNamed` — we match by `type` only.
 */
function hasKeywordChild(node: SyntaxNode, keywords: ReadonlySet<string>): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (!c) continue;
    if (keywords.has(c.type)) return true;
  }
  return false;
}

/** Bare `simple_identifier` name field on a Kotlin declaration. */
function simpleName(node: SyntaxNode): string {
  const direct = namedChildOfKind(node, new Set(["simple_identifier", "type_identifier"]));
  return direct ? direct.text : "";
}

// ---------------------------------------------------------------------------
// Modifiers + annotations
// ---------------------------------------------------------------------------

interface ModifierInfo {
  isAbstract: boolean;
  isOpen: boolean;
  isOverride: boolean;
  isStatic: boolean; // Kotlin has no `static`; surfaced for companion/object membership
  isFinal: boolean;
  isData: boolean;
  isSealed: boolean;
  isInline: boolean;
  isValue: boolean;
  isConst: boolean;
  isSuspend: boolean;
  isCompanion: boolean;
  isAnnotationClass: boolean;
  isEnumClass: boolean;
  visibility: string; // "public" (default), "private", "protected", "internal"
  annotations: Array<{ name: string; node: SyntaxNode }>;
}

function emptyModifiers(): ModifierInfo {
  return {
    isAbstract: false,
    isOpen: false,
    isOverride: false,
    isStatic: false,
    isFinal: false,
    isData: false,
    isSealed: false,
    isInline: false,
    isValue: false,
    isConst: false,
    isSuspend: false,
    isCompanion: false,
    isAnnotationClass: false,
    isEnumClass: false,
    visibility: "public",
    annotations: [],
  };
}

function readModifiers(node: SyntaxNode): ModifierInfo {
  const info = emptyModifiers();
  const wrapper = namedChildOfKind(node, new Set(["modifiers"]));
  const visit = (n: SyntaxNode): void => {
    for (let i = 0; i < n.namedChildCount; i++) {
      const m = n.namedChild(i);
      if (!m) continue;
      switch (m.type) {
        case "annotation":
        case "marker_annotation": {
          const name = annotationName(m);
          if (name) info.annotations.push({ name, node: m });
          break;
        }
        case "class_modifier":
          switch (m.text.trim()) {
            case "data": info.isData = true; break;
            case "sealed": info.isSealed = true; break;
            case "annotation": info.isAnnotationClass = true; break;
            case "enum": info.isEnumClass = true; break;
            case "inner": /* nested-class marker */ break;
            case "value": info.isValue = true; break;
          }
          break;
        case "member_modifier":
          switch (m.text.trim()) {
            case "override": info.isOverride = true; break;
            case "abstract": info.isAbstract = true; break;
            case "open": info.isOpen = true; break;
            case "final": info.isFinal = true; break;
          }
          break;
        case "function_modifier":
          if (m.text.trim() === "suspend") info.isSuspend = true;
          if (m.text.trim() === "inline") info.isInline = true;
          break;
        case "property_modifier":
          if (m.text.trim() === "const") info.isConst = true;
          break;
        case "visibility_modifier":
          info.visibility = m.text.trim();
          break;
        case "inheritance_modifier":
          if (m.text.trim() === "abstract") info.isAbstract = true;
          if (m.text.trim() === "open") info.isOpen = true;
          if (m.text.trim() === "final") info.isFinal = true;
          if (m.text.trim() === "sealed") info.isSealed = true;
          break;
        case "platform_modifier":
        case "reification_modifier":
        case "variance_modifier":
        case "parameter_modifier":
          break;
      }
    }
  };
  if (wrapper) visit(wrapper);
  // `companion` keyword is the leading anonymous token of companion_object.
  if (hasKeywordChild(node, new Set(["companion"]))) info.isCompanion = true;
  return info;
}

function annotationName(ann: SyntaxNode): string {
  // Annotation structure: `annotation > user_type > type_identifier`
  // (`@Foo`) or `annotation > constructor_invocation > user_type > type_identifier`
  // (`@Foo(...)`). Walk down past wrappers.
  const stack: SyntaxNode[] = [ann];
  while (stack.length > 0) {
    const n = stack.shift()!;
    if (n.type === "type_identifier") return n.text;
    for (let i = 0; i < n.namedChildCount; i++) {
      const c = n.namedChild(i);
      if (c) stack.push(c);
    }
  }
  return "";
}

function emitAnnotationEdges(
  ctx: WalkCtx,
  fromId: string,
  annotations: ModifierInfo["annotations"],
): void {
  for (const ann of annotations) {
    ctx.edges.push({
      from: fromId,
      to: `${LANGUAGE}:type:${ann.name}`,
      relationship: Relationship.HAS_ANNOTATION,
      evidence: evidence(ann.node),
      meta: {
        via: "annotation",
        base_type: ann.name,
        resolved: false,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Type-shape classification (KT-2)
// ---------------------------------------------------------------------------

interface TypeShape {
  relationship: typeof Relationship[keyof typeof Relationship];
  via: string;
  baseType: string;
  secondaryType?: string;
  extraMeta?: Record<string, unknown>;
  isNullable: boolean;
}

const COLLECTION_VIAS: Record<string, string> = {
  List: "list",
  MutableList: "mutable_list",
  ArrayList: "arraylist",
  Set: "set",
  MutableSet: "mutable_set",
  HashSet: "hashset",
  LinkedHashSet: "linkedhashset",
  Collection: "collection",
  MutableCollection: "mutable_collection",
  Iterable: "iterable",
  MutableIterable: "mutable_iterable",
  Sequence: "sequence",
  Array: "array",
  IntArray: "int_array",
  LongArray: "long_array",
  ByteArray: "byte_array",
  CharArray: "char_array",
  ShortArray: "short_array",
  FloatArray: "float_array",
  DoubleArray: "double_array",
  BooleanArray: "boolean_array",
};

const MAP_VIAS: Record<string, string> = {
  Map: "map",
  MutableMap: "mutable_map",
  HashMap: "hashmap",
  LinkedHashMap: "linkedhashmap",
  TreeMap: "treemap",
  ConcurrentHashMap: "concurrenthashmap",
};

const OPTIONAL_VIAS: Record<string, string> = {
  Optional: "optional",
  Lazy: "lazy",
  Result: "result",
};

const STREAM_VIAS: Record<string, string> = {
  Flow: "flow",
  StateFlow: "state_flow",
  MutableStateFlow: "mutable_state_flow",
  SharedFlow: "shared_flow",
  MutableSharedFlow: "mutable_shared_flow",
};

/**
 * Inspect a Kotlin type node and decide which relationship + via label
 * it represents. Returns `null` for unrecognised constructs; the caller
 * still records the raw `type_text` on the Field entity.
 */
function classifyType(typeNode: SyntaxNode | null): TypeShape | null {
  if (!typeNode) return null;
  if (typeNode.type === "nullable_type") {
    // Unwrap and mark nullable.
    const inner = firstNonCommentNamedChild(typeNode);
    const shape = classifyType(inner);
    if (shape) return { ...shape, isNullable: true };
    return null;
  }
  if (typeNode.type !== "user_type") {
    // Function types, parenthesized types, etc. — not handled in KT-2.
    return null;
  }
  const headNode = namedChildOfKind(typeNode, new Set(["type_identifier"]));
  const head = headNode ? headNode.text : "";
  if (!head) return null;

  const argsNode = namedChildOfKind(typeNode, new Set(["type_arguments"]));
  const argTypes = argsNode ? collectTypeArgs(argsNode) : [];
  const first = argTypes[0] ?? "";

  if (STREAM_VIAS[head] && first) {
    return {
      relationship: Relationship.CONTAINS_MANY,
      via: STREAM_VIAS[head]!,
      baseType: first,
      isNullable: false,
    };
  }
  if (COLLECTION_VIAS[head] && (first || head.endsWith("Array"))) {
    return {
      relationship: Relationship.CONTAINS_MANY,
      via: COLLECTION_VIAS[head]!,
      baseType: first || head, // primitive arrays keep the head name as base
      isNullable: false,
    };
  }
  if (MAP_VIAS[head] && argTypes.length >= 2) {
    return {
      relationship: Relationship.MAPS_K_TO_V,
      via: MAP_VIAS[head]!,
      baseType: argTypes[1]!,
      secondaryType: argTypes[0],
      extraMeta: { key_type: argTypes[0] },
      isNullable: false,
    };
  }
  if (OPTIONAL_VIAS[head]) {
    return {
      relationship: Relationship.MAY_CONTAIN,
      via: OPTIONAL_VIAS[head]!,
      baseType: first || head,
      isNullable: false,
    };
  }
  return {
    relationship: Relationship.EMBEDS,
    via: "value",
    baseType: head,
    extraMeta: argTypes.length > 0 ? { type_arguments: argTypes } : undefined,
    isNullable: false,
  };
}

function firstNonCommentNamedChild(node: SyntaxNode): SyntaxNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (!c) continue;
    if (c.type === "line_comment" || c.type === "block_comment") continue;
    return c;
  }
  return null;
}

function innerUserTypeName(typeNode: SyntaxNode | null | undefined): string {
  if (!typeNode) return "";
  if (typeNode.type === "nullable_type") {
    return innerUserTypeName(firstNonCommentNamedChild(typeNode));
  }
  if (typeNode.type === "user_type") {
    const head = namedChildOfKind(typeNode, new Set(["type_identifier"]));
    return head ? head.text : "";
  }
  if (typeNode.type === "type_identifier") return typeNode.text;
  if (typeNode.type === "type_projection") {
    return innerUserTypeName(firstNonCommentNamedChild(typeNode));
  }
  return "";
}

function collectTypeArgs(args: SyntaxNode): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.namedChildCount; i++) {
    const child = args.namedChild(i);
    if (!child) continue;
    if (child.type === "type_projection") {
      const inner = firstNonCommentNamedChild(child);
      const name = innerUserTypeName(inner);
      out.push(name || (inner ? inner.text : "?"));
    } else if (child.type !== "line_comment" && child.type !== "block_comment") {
      out.push(innerUserTypeName(child) || child.text);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Walker context
// ---------------------------------------------------------------------------

interface WalkCtx {
  relPath: string;
  entities: ExtractedEntity[];
  edges: ExtractedEdge[];
  diagnostics: ExtractorDiagnostic[];
  fileEntityId: string;
  /** `.`-joined package + outer-type prefix. */
  typePrefix: string;
  /** Bare package name (e.g. `com.example.foo`). */
  packageName: string;
}

function emitEntity(
  ctx: WalkCtx,
  entity: ExtractedEntity,
  ownedByFile = true,
): void {
  ctx.entities.push(entity);
  if (ownedByFile) {
    ctx.edges.push({
      from: ctx.fileEntityId,
      to: entity.id,
      relationship: Relationship.DECLARES,
      evidence: {
        extractor: NAME,
        extractor_version: VERSION,
        parser_backed: true,
        confidence: Confidence.High,
        language: LANGUAGE,
        line: entity.line,
        column: entity.column,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Package + imports (KT-1)
// ---------------------------------------------------------------------------

function handlePackage(node: SyntaxNode, ctx: WalkCtx): void {
  const ident = namedChildOfKind(node, new Set(["identifier"]));
  const name = ident ? ident.text.trim() : "";
  if (!name) return;
  ctx.packageName = name;
  ctx.typePrefix = name;
  const id = entityId(ctx.relPath, CodeEntityKind.Package, name);
  emitEntity(ctx, {
    id,
    kind: CodeEntityKind.Package,
    name: lastDotSegment(name),
    qualifiedName: name,
    language: LANGUAGE,
    relPath: ctx.relPath,
    line: node.startPosition.row + 1,
    column: node.startPosition.column + 1,
    attrs: { dotted: name },
  });
}

function handleImport(node: SyntaxNode, ctx: WalkCtx): void {
  // import_header { identifier { simple_identifier... } } with optional
  // trailing `.*` or `as alias`. Use the source text to detect wildcard
  // since tree-sitter-kotlin represents the `*` as an anonymous token.
  const raw = node.text.replace(/^import\s+/, "").trim();
  if (!raw) return;
  // Strip trailing `;` (rare in Kotlin) and any `as Alias` suffix.
  const cleaned = raw.replace(/;\s*$/, "");
  const aliasMatch = cleaned.match(/^(.*?)\s+as\s+(\S+)\s*$/);
  const path = aliasMatch ? aliasMatch[1]!.trim() : cleaned;
  const alias = aliasMatch ? aliasMatch[2]!.trim() : undefined;
  const isWildcard = path.endsWith(".*");
  const targetName = isWildcard ? path : lastDotSegment(path);
  const targetSlot = isWildcard ? "use" : "type";
  const meta: Record<string, unknown> = {
    path,
    wildcard: isWildcard,
  };
  if (alias) meta.alias = alias;
  ctx.edges.push({
    from: ctx.fileEntityId,
    to: `${LANGUAGE}:${targetSlot}:${targetName}`,
    relationship: Relationship.IMPORTS,
    evidence: evidence(node),
    meta,
  });
}

// ---------------------------------------------------------------------------
// Type declarations (KT-1 + KT-3)
// ---------------------------------------------------------------------------

interface ClassDeclShape {
  kind: typeof CodeEntityKind[keyof typeof CodeEntityKind];
  isInterface: boolean;
  attrs: Record<string, unknown>;
}

function classifyClassDecl(node: SyntaxNode, mods: ModifierInfo): ClassDeclShape {
  // Determine kind from modifier + grammar keyword.
  // Order matters: enum/annotation are stronger discriminators than data/sealed.
  if (mods.isEnumClass || namedChildOfKind(node, new Set(["enum_class_body"]))) {
    return {
      kind: CodeEntityKind.Enum,
      isInterface: false,
      attrs: { is_enum_class: true },
    };
  }
  if (mods.isAnnotationClass) {
    return {
      kind: CodeEntityKind.Annotation,
      isInterface: false,
      attrs: { is_annotation_class: true },
    };
  }
  const isInterfaceDecl = hasKeywordChild(node, new Set(["interface"]));
  if (isInterfaceDecl) {
    return {
      kind: CodeEntityKind.Interface,
      isInterface: true,
      attrs: { is_sealed: mods.isSealed },
    };
  }
  const attrs: Record<string, unknown> = {};
  if (mods.isData) attrs.is_data_class = true;
  if (mods.isSealed) attrs.is_sealed = true;
  if (mods.isValue) attrs.is_value_class = true;
  if (mods.isInline) attrs.is_inline_class = true;
  return { kind: CodeEntityKind.Class, isInterface: false, attrs };
}

function handleClassDecl(node: SyntaxNode, ctx: WalkCtx): void {
  const name = simpleName(node);
  if (!name) return;
  const mods = readModifiers(node);
  const shape = classifyClassDecl(node, mods);
  const qn = joinTypeQn(ctx.typePrefix, name);
  const id = entityId(ctx.relPath, shape.kind, qn);
  emitEntity(ctx, {
    id,
    kind: shape.kind,
    name,
    qualifiedName: qn,
    language: LANGUAGE,
    relPath: ctx.relPath,
    line: node.startPosition.row + 1,
    column: node.startPosition.column + 1,
    attrs: {
      package: ctx.packageName,
      visibility: mods.visibility,
      is_abstract: mods.isAbstract,
      is_open: mods.isOpen,
      ...shape.attrs,
    },
  });
  emitAnnotationEdges(ctx, id, mods.annotations);

  // Primary constructor → Constructor entity + primary-constructor-property fields.
  const primary = namedChildOfKind(node, new Set(["primary_constructor"]));
  if (primary) handlePrimaryConstructor(primary, ctx, id, qn);

  // Inheritance via `delegation_specifier` children of the class_declaration.
  const delegations = namedChildrenOfKind(node, new Set(["delegation_specifier"]));
  for (const d of delegations) emitDelegationEdge(d, ctx, id, shape.isInterface);

  // Body.
  const bodyKinds = new Set(["class_body", "enum_class_body"]);
  const body = namedChildOfKind(node, bodyKinds);
  if (!body) return;
  const childCtx: WalkCtx = { ...ctx, typePrefix: qn };
  for (let i = 0; i < body.namedChildCount; i++) {
    const child = body.namedChild(i);
    if (!child) continue;
    dispatch(child, childCtx, /* ownerId */ id, /* ownerQn */ qn);
  }
}

function handleObjectDecl(node: SyntaxNode, ctx: WalkCtx, ownerId: string | null, ownerQn: string): void {
  const name = simpleName(node);
  if (!name) return;
  const mods = readModifiers(node);
  const qn = joinTypeQn(ctx.typePrefix, name);
  const id = entityId(ctx.relPath, CodeEntityKind.Class, qn);
  emitEntity(ctx, {
    id,
    kind: CodeEntityKind.Class,
    name,
    qualifiedName: qn,
    language: LANGUAGE,
    relPath: ctx.relPath,
    line: node.startPosition.row + 1,
    column: node.startPosition.column + 1,
    attrs: {
      package: ctx.packageName,
      visibility: mods.visibility,
      is_object: true,
    },
  }, /* ownedByFile */ ownerId === null);
  if (ownerId) {
    ctx.edges.push({
      from: ownerId,
      to: id,
      relationship: Relationship.DECLARES,
      evidence: evidence(node),
      meta: { via: "nested_object" },
    });
  }
  emitAnnotationEdges(ctx, id, mods.annotations);

  const delegations = namedChildrenOfKind(node, new Set(["delegation_specifier"]));
  for (const d of delegations) emitDelegationEdge(d, ctx, id, /* selfIsInterface */ false);

  const body = namedChildOfKind(node, new Set(["class_body"]));
  if (!body) return;
  const childCtx: WalkCtx = { ...ctx, typePrefix: qn };
  for (let i = 0; i < body.namedChildCount; i++) {
    const child = body.namedChild(i);
    if (!child) continue;
    dispatch(child, childCtx, id, qn);
  }
  // Suppress unused parameter warning — kept for symmetry with other handlers.
  void ownerQn;
}

function handleCompanionObject(node: SyntaxNode, ctx: WalkCtx, ownerId: string, ownerQn: string): void {
  // Companion may have an explicit name (`companion object Foo`) or be
  // anonymous (defaults to `Companion` by Kotlin convention).
  const explicit = simpleName(node);
  const name = explicit || "Companion";
  const mods = readModifiers(node);
  const qn = joinTypeQn(ownerQn, name);
  const id = entityId(ctx.relPath, CodeEntityKind.Class, qn);
  emitEntity(ctx, {
    id,
    kind: CodeEntityKind.Class,
    name,
    qualifiedName: qn,
    language: LANGUAGE,
    relPath: ctx.relPath,
    line: node.startPosition.row + 1,
    column: node.startPosition.column + 1,
    attrs: {
      package: ctx.packageName,
      visibility: mods.visibility,
      is_object: true,
      is_companion: true,
    },
  }, /* ownedByFile */ false);
  ctx.edges.push({
    from: ownerId,
    to: id,
    relationship: Relationship.DECLARES,
    evidence: evidence(node),
    meta: { via: "companion_object" },
  });
  emitAnnotationEdges(ctx, id, mods.annotations);

  const body = namedChildOfKind(node, new Set(["class_body"]));
  if (!body) return;
  const childCtx: WalkCtx = { ...ctx, typePrefix: qn };
  for (let i = 0; i < body.namedChildCount; i++) {
    const child = body.namedChild(i);
    if (!child) continue;
    dispatch(child, childCtx, id, qn);
  }
}

function emitDelegationEdge(
  node: SyntaxNode,
  ctx: WalkCtx,
  fromId: string,
  selfIsInterface: boolean,
): void {
  // delegation_specifier > (constructor_invocation | user_type | explicit_delegation)
  const inner = firstNonCommentNamedChild(node);
  if (!inner) return;

  // `constructor_invocation` indicates a superclass call → EXTENDS.
  if (inner.type === "constructor_invocation") {
    const userType = namedChildOfKind(inner, new Set(["user_type"]));
    const baseType = innerUserTypeName(userType);
    if (!baseType) return;
    ctx.edges.push({
      from: fromId,
      to: `${LANGUAGE}:type:${baseType}`,
      relationship: Relationship.EXTENDS,
      evidence: evidence(node),
      meta: { via: "class_extends", base_type: baseType, resolved: false },
    });
    return;
  }

  // Plain `user_type`: for interfaces it's IMPLEMENTS, for sealed
  // interfaces extending a parent interface use EXTENDS (mirrors Java
  // extractor's super-interface handling).
  if (inner.type === "user_type") {
    const baseType = innerUserTypeName(inner);
    if (!baseType) return;
    const rel = selfIsInterface ? Relationship.EXTENDS : Relationship.IMPLEMENTS;
    const via = selfIsInterface ? "interface_extends" : "interface_impl";
    ctx.edges.push({
      from: fromId,
      to: `${LANGUAGE}:type:${baseType}`,
      relationship: rel,
      evidence: evidence(node),
      meta: { via, base_type: baseType, resolved: false },
    });
    return;
  }

  // explicit_delegation (`by other`) — treat as IMPLEMENTS of the
  // first user_type with via="delegation". Future work: record the
  // delegated-to expression.
  const userType = namedChildOfKind(inner, new Set(["user_type"]));
  const baseType = innerUserTypeName(userType);
  if (baseType) {
    ctx.edges.push({
      from: fromId,
      to: `${LANGUAGE}:type:${baseType}`,
      relationship: Relationship.IMPLEMENTS,
      evidence: evidence(node),
      meta: { via: "delegation", base_type: baseType, resolved: false },
    });
  }
}

// ---------------------------------------------------------------------------
// Members (KT-2)
// ---------------------------------------------------------------------------

function handlePrimaryConstructor(
  node: SyntaxNode,
  ctx: WalkCtx,
  ownerId: string,
  ownerQn: string,
): void {
  const mods = readModifiers(node);
  const qn = `${ownerQn}.<init>`;
  const id = `${entityId(ctx.relPath, CodeEntityKind.Constructor, qn)}@${node.startPosition.row + 1}`;
  emitEntity(ctx, {
    id,
    kind: CodeEntityKind.Constructor,
    name: "<init>",
    qualifiedName: qn,
    language: LANGUAGE,
    relPath: ctx.relPath,
    line: node.startPosition.row + 1,
    column: node.startPosition.column + 1,
    attrs: {
      owner_qualified_name: ownerQn,
      is_definition: true,
      is_primary: true,
    },
  }, /* ownedByFile */ false);
  ctx.edges.push({
    from: ownerId,
    to: id,
    relationship: Relationship.DECLARES_METHOD,
    evidence: evidence(node),
    meta: { via: "primary_constructor" },
  });
  emitAnnotationEdges(ctx, id, mods.annotations);

  // Each `class_parameter` with a `binding_pattern_kind` (val/var)
  // is a Kotlin primary-constructor property — emit a Field entity
  // on the owning class so it surfaces in data-model entries.
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child || child.type !== "class_parameter") continue;
    const bindKind = namedChildOfKind(child, new Set(["binding_pattern_kind"]));
    if (!bindKind) continue; // plain ctor param without val/var — not a property
    emitFieldFromParameter(child, ctx, ownerId, ownerQn, bindKind.text.trim());
  }
}

function emitFieldFromParameter(
  node: SyntaxNode,
  ctx: WalkCtx,
  ownerId: string,
  ownerQn: string,
  bindingKind: string,
): void {
  const nameNode = namedChildOfKind(node, new Set(["simple_identifier"]));
  const name = nameNode ? nameNode.text : "";
  if (!name) return;
  const typeNode = firstTypeNode(node);
  const mods = readModifiers(node);
  const qn = `${ownerQn}.${name}`;
  const id = entityId(ctx.relPath, CodeEntityKind.Field, qn);
  const shape = classifyType(typeNode);
  const isNullable = typeNode?.type === "nullable_type" || (shape?.isNullable ?? false);
  emitEntity(ctx, {
    id,
    kind: CodeEntityKind.Field,
    name,
    qualifiedName: qn,
    language: LANGUAGE,
    relPath: ctx.relPath,
    line: node.startPosition.row + 1,
    column: node.startPosition.column + 1,
    attrs: {
      type_text: nodeText(typeNode).trim(),
      base_type: shape?.baseType ?? "",
      via: shape?.via,
      is_nullable: isNullable,
      is_mutable: bindingKind === "var",
      is_primary_constructor_property: true,
      visibility: mods.visibility,
      owner_qualified_name: ownerQn,
    },
  }, /* ownedByFile */ false);
  ctx.edges.push({
    from: ownerId,
    to: id,
    relationship: Relationship.DECLARES_FIELD,
    evidence: evidence(node),
    meta: { via: "primary_constructor_property" },
  });
  emitAnnotationEdges(ctx, id, mods.annotations);
  emitShapeEdges(ctx, id, node, shape, isNullable);
}

function handlePropertyDecl(
  node: SyntaxNode,
  ctx: WalkCtx,
  ownerId: string | null,
  ownerQn: string,
): void {
  const varDecl = namedChildOfKind(node, new Set(["variable_declaration"]));
  if (!varDecl) return;
  const nameNode = namedChildOfKind(varDecl, new Set(["simple_identifier"]));
  const name = nameNode ? nameNode.text : "";
  if (!name) return;
  const mods = readModifiers(node);
  // Property type may be inside the variable_declaration (Kotlin syntax:
  // `val foo: List<User> = ...`). Walk for the first type-like node.
  const typeNode = firstTypeNode(varDecl) ?? firstTypeNode(node);
  const shape = classifyType(typeNode);
  const isNullable = typeNode?.type === "nullable_type" || (shape?.isNullable ?? false);

  // For top-level properties without an owning class, qualify under the
  // package so the entity id stays stable and unique.
  const effectiveOwnerQn = ownerQn || ctx.packageName;
  const qn = effectiveOwnerQn ? `${effectiveOwnerQn}.${name}` : name;
  const id = entityId(ctx.relPath, CodeEntityKind.Field, qn);
  emitEntity(ctx, {
    id,
    kind: CodeEntityKind.Field,
    name,
    qualifiedName: qn,
    language: LANGUAGE,
    relPath: ctx.relPath,
    line: node.startPosition.row + 1,
    column: node.startPosition.column + 1,
    attrs: {
      type_text: nodeText(typeNode).trim(),
      base_type: shape?.baseType ?? "",
      via: shape?.via,
      is_nullable: isNullable,
      is_const: mods.isConst,
      visibility: mods.visibility,
      owner_qualified_name: effectiveOwnerQn,
      is_top_level: ownerId === null,
    },
  }, /* ownedByFile */ ownerId === null);
  if (ownerId) {
    ctx.edges.push({
      from: ownerId,
      to: id,
      relationship: Relationship.DECLARES_FIELD,
      evidence: evidence(node),
    });
  }
  emitAnnotationEdges(ctx, id, mods.annotations);
  emitShapeEdges(ctx, id, node, shape, isNullable);

  // `const val` → also surface as Constant.
  if (mods.isConst) {
    const cid = entityId(ctx.relPath, CodeEntityKind.Constant, qn);
    emitEntity(ctx, {
      id: cid,
      kind: CodeEntityKind.Constant,
      name,
      qualifiedName: qn,
      language: LANGUAGE,
      relPath: ctx.relPath,
      line: node.startPosition.row + 1,
      column: node.startPosition.column + 1,
      attrs: {
        is_const: true,
        visibility: mods.visibility,
        owner_qualified_name: effectiveOwnerQn,
        type_text: nodeText(typeNode).trim(),
      },
    }, /* ownedByFile */ ownerId === null);
    if (ownerId) {
      ctx.edges.push({
        from: ownerId,
        to: cid,
        relationship: Relationship.DECLARES_CONSTANT,
        evidence: evidence(node),
      });
    }
  }
}

function emitShapeEdges(
  ctx: WalkCtx,
  fromId: string,
  evidenceNode: SyntaxNode,
  shape: TypeShape | null,
  isNullable: boolean,
): void {
  if (!shape) return;
  const meta: Record<string, unknown> = {
    via: shape.via,
    base_type: shape.baseType,
    resolved: false,
    is_nullable: isNullable,
    ...(shape.extraMeta ?? {}),
  };
  ctx.edges.push({
    from: fromId,
    to: `${LANGUAGE}:type:${shape.baseType}`,
    relationship: shape.relationship,
    evidence: evidence(evidenceNode),
    meta,
  });
  if (shape.secondaryType) {
    ctx.edges.push({
      from: fromId,
      to: `${LANGUAGE}:type:${shape.secondaryType}`,
      relationship: Relationship.REFERENCES_TYPE,
      evidence: evidence(evidenceNode),
      meta: {
        via: `${shape.via}_key`,
        base_type: shape.secondaryType,
        resolved: false,
      },
    });
  }
}

function firstTypeNode(node: SyntaxNode): SyntaxNode | null {
  const typeKinds = new Set([
    "user_type",
    "nullable_type",
    "function_type",
    "parenthesized_type",
  ]);
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c && typeKinds.has(c.type)) return c;
  }
  return null;
}

function handleFunctionDecl(
  node: SyntaxNode,
  ctx: WalkCtx,
  ownerId: string | null,
  ownerQn: string,
): void {
  // Tree-sitter-kotlin places the optional receiver type BEFORE the
  // simple_identifier. So if the first named child of the function_declaration
  // (after modifiers + type_parameters) is a `user_type` or `nullable_type`,
  // that's the receiver and we have an extension function.
  let receiverType: SyntaxNode | null = null;
  let nameNode: SyntaxNode | null = null;
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (!c) continue;
    if (c.type === "modifiers" || c.type === "type_parameters") continue;
    if (!nameNode && (c.type === "user_type" || c.type === "nullable_type")) {
      receiverType = c;
      continue;
    }
    if (c.type === "simple_identifier") {
      nameNode = c;
      break;
    }
  }
  if (!nameNode) return;
  const name = nameNode.text;
  const mods = readModifiers(node);

  const kind = ownerId ? CodeEntityKind.Method : CodeEntityKind.Function;
  const effectiveOwnerQn = ownerQn || ctx.packageName;
  const qn = effectiveOwnerQn ? `${effectiveOwnerQn}.${name}` : name;
  const baseId = entityId(ctx.relPath, kind, qn);
  const id = `${baseId}@${node.startPosition.row + 1}`;

  // Return type: the user_type / nullable_type immediately after the
  // function_value_parameters. Walk children to find it.
  let returnType: SyntaxNode | null = null;
  let seenParams = false;
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (!c) continue;
    if (c.type === "function_value_parameters") {
      seenParams = true;
      continue;
    }
    if (seenParams && (c.type === "user_type" || c.type === "nullable_type")) {
      returnType = c;
      break;
    }
  }

  const body = namedChildOfKind(node, new Set(["function_body"]));
  const receiverName = receiverType ? innerUserTypeName(receiverType) : "";
  const attrs: Record<string, unknown> = {
    is_definition: !!body,
    is_abstract: mods.isAbstract,
    is_suspend: mods.isSuspend,
    is_inline: mods.isInline,
    is_override: mods.isOverride,
    visibility: mods.visibility,
    owner_qualified_name: effectiveOwnerQn,
    return_type_text: nodeText(returnType).trim(),
    is_top_level: ownerId === null,
    is_extension: !!receiverType,
  };
  if (receiverName) attrs.receiver_type = receiverName;

  emitEntity(ctx, {
    id,
    kind,
    name,
    qualifiedName: qn,
    language: LANGUAGE,
    relPath: ctx.relPath,
    line: node.startPosition.row + 1,
    column: node.startPosition.column + 1,
    attrs,
  }, /* ownedByFile */ ownerId === null);
  if (ownerId) {
    ctx.edges.push({
      from: ownerId,
      to: id,
      relationship: Relationship.DECLARES_METHOD,
      evidence: evidence(node),
    });
  }
  emitAnnotationEdges(ctx, id, mods.annotations);

  // Extension-function receiver gets a REFERENCES_TYPE link so the
  // intermediate layer can bind it to its receiver type.
  if (receiverName) {
    ctx.edges.push({
      from: id,
      to: `${LANGUAGE}:type:${receiverName}`,
      relationship: Relationship.REFERENCES_TYPE,
      evidence: evidence(receiverType!),
      meta: {
        via: "extension_receiver",
        base_type: receiverName,
        resolved: false,
      },
    });
  }
}

function handleEnumEntry(
  node: SyntaxNode,
  ctx: WalkCtx,
  ownerId: string,
  ownerQn: string,
): void {
  const nameNode = namedChildOfKind(node, new Set(["simple_identifier"]));
  const name = nameNode ? nameNode.text : "";
  if (!name) return;
  const qn = `${ownerQn}.${name}`;
  const id = entityId(ctx.relPath, CodeEntityKind.EnumMember, qn);
  emitEntity(ctx, {
    id,
    kind: CodeEntityKind.EnumMember,
    name,
    qualifiedName: qn,
    language: LANGUAGE,
    relPath: ctx.relPath,
    line: node.startPosition.row + 1,
    column: node.startPosition.column + 1,
    attrs: { owner_qualified_name: ownerQn },
  }, /* ownedByFile */ false);
  ctx.edges.push({
    from: ownerId,
    to: id,
    relationship: Relationship.DECLARES_ENUM_MEMBER,
    evidence: evidence(node),
  });
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

function dispatch(
  node: SyntaxNode,
  ctx: WalkCtx,
  ownerId: string | null,
  ownerQn: string,
): void {
  switch (node.type) {
    case "package_header":
      handlePackage(node, ctx);
      return;
    case "import_list": {
      for (let i = 0; i < node.namedChildCount; i++) {
        const c = node.namedChild(i);
        if (c && c.type === "import_header") handleImport(c, ctx);
      }
      return;
    }
    case "import_header":
      handleImport(node, ctx);
      return;
    case "class_declaration":
      handleClassDecl(node, ctx);
      return;
    case "object_declaration":
      handleObjectDecl(node, ctx, ownerId, ownerQn);
      return;
    case "companion_object":
      if (ownerId) handleCompanionObject(node, ctx, ownerId, ownerQn);
      return;
    case "property_declaration":
      handlePropertyDecl(node, ctx, ownerId, ownerQn);
      return;
    case "function_declaration":
      handleFunctionDecl(node, ctx, ownerId, ownerQn);
      return;
    case "enum_entry":
      if (ownerId) handleEnumEntry(node, ctx, ownerId, ownerQn);
      return;
    default:
      return;
  }
}

function walk(root: SyntaxNode, ctx: WalkCtx): void {
  for (let i = 0; i < root.namedChildCount; i++) {
    const child = root.namedChild(i);
    if (!child) continue;
    dispatch(child, ctx, /* ownerId */ null, /* ownerQn */ ctx.typePrefix);
  }
}

// ---------------------------------------------------------------------------
// Extractor
// ---------------------------------------------------------------------------

export const kotlinExtractor: Extractor = {
  name: NAME,
  version: VERSION,
  extensions: EXTENSIONS,
  parserBacked: true,
  async extract(file: ExtractFileInput): Promise<ExtractorOutput> {
    const parser = await getParser("kotlin");
    const tree = parser.parse(file.source);
    const root = tree.rootNode;

    const fId = fileId(file.relPath);
    const entities: ExtractedEntity[] = [
      {
        id: fId,
        kind: CodeEntityKind.SourceFile,
        name: file.name,
        qualifiedName: file.relPath,
        language: LANGUAGE,
        relPath: file.relPath,
        line: 1,
        column: 1,
      },
    ];

    const ctx: WalkCtx = {
      relPath: file.relPath,
      entities,
      edges: [],
      diagnostics: [],
      fileEntityId: fId,
      typePrefix: "",
      packageName: "",
    };

    if (root.hasError()) {
      ctx.diagnostics.push({
        severity: "warning",
        relPath: file.relPath,
        message: "tree-sitter reported parse errors; extraction proceeded best-effort",
      });
    }

    walk(root, ctx);

    return {
      entities: ctx.entities,
      edges: ctx.edges,
      shapes: [],
      diagnostics: ctx.diagnostics,
    };
  },
};
