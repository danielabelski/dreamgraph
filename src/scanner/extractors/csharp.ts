/**
 * DreamGraph — C# language extractor (wave 4, phases CS-1..CS-3).
 *
 * CS-1: file structure + top-level type declarations.
 *   - `compilation_unit` root. Either:
 *       * one `file_scoped_namespace_declaration` (C# 10+) whose name
 *         becomes the module/package qn, OR
 *       * zero-or-more `namespace_declaration` blocks (legacy braced
 *         form), each introducing a nested qn prefix, OR
 *       * no namespace at all — top-level declarations belong to the
 *         global namespace; we use the file stem as a fallback module
 *         qn so source-attached entities have a stable owner.
 *   - `using_directive` → IMPORTS edge from the file entity. Three forms:
 *       * `using System;`             → `csharp:use:System`
 *       * `using static System.Math;` → `csharp:use:System.Math` + meta.static
 *       * `using Alias = System.X;`   → `csharp:use:System.X` + meta.alias
 *   - `class_declaration` / `interface_declaration` / `struct_declaration`
 *     / `record_declaration` / `record_struct_declaration` /
 *     `enum_declaration` / `delegate_declaration` → typed entities (kinds
 *     Class / Interface / Struct / Record / Struct / Enum / TypeAlias).
 *   - `base_list` produces EXTENDS/IMPLEMENTS edges. For classes, records
 *     and structs the FIRST base is treated as EXTENDS (C# only permits
 *     one base class and it must be first); remaining bases are
 *     IMPLEMENTS. For interfaces, every base is EXTENDS (interface
 *     inheritance). Lacking semantic info, this is a syntactic best-effort
 *     classification — it relies on the C# language rule, not on
 *     resolving the targets.
 *   - Generic type-parameter lists are NOT modelled as separate entities
 *     in this wave; we surface them via `attrs.type_parameters`.
 *
 * CS-2: members of a type.
 *   - `field_declaration` → one Field entity per `variable_declarator`.
 *     A `const` modifier additionally emits a Constant. `event` field
 *     declarations (`event_field_declaration`) emit Fields with
 *     `attrs.is_event = true`.
 *   - `property_declaration` → Property entity. `init`-only and
 *     `required` properties carry `attrs.is_init_only` / `attrs.is_required`.
 *   - `indexer_declaration` → Property with `attrs.is_indexer = true`.
 *   - `method_declaration` → Method. `async`, `static`, `virtual`,
 *     `override`, `abstract`, `sealed`, `partial`, `extern` map to
 *     boolean attrs of the same name (prefixed with `is_`).
 *   - `constructor_declaration` → Constructor.
 *   - `destructor_declaration` → Destructor.
 *   - `record_declaration` / `record_struct_declaration` primary
 *     constructors: each `parameter` in the record's `parameter_list`
 *     becomes both a Field and a Constructor parameter — recorded as a
 *     Field entity with `attrs.is_primary_ctor_param = true`.
 *   - `enum_member_declaration` → EnumMember.
 *
 *   Type-shape classification (annotation-derived; C# types ARE
 *   compile-time-checked so these edges carry full confidence rather
 *   than Python's helmet caveat — `meta.from_annotation` is still set
 *   for ontology consistency with other languages):
 *     - `List<T>` / `IList<T>` / `ICollection<T>` / `IEnumerable<T>` /
 *       `IReadOnlyList<T>` / `IReadOnlyCollection<T>` / `HashSet<T>` /
 *       `ISet<T>` / `Stack<T>` / `Queue<T>` / `T[]`
 *                                  → CONTAINS_MANY
 *     - `Dictionary<K,V>` / `IDictionary<K,V>` / `IReadOnlyDictionary<K,V>` /
 *       `SortedDictionary<K,V>` / `ConcurrentDictionary<K,V>`
 *                                  → MAPS_K_TO_V (meta.key_type=K)
 *     - `T?` (nullable_type) on a reference or value type
 *                                  → MAY_CONTAIN via "nullable"
 *     - `Nullable<T>`              → MAY_CONTAIN via "nullable"
 *     - bare user type `T`         → EMBEDS via "value"
 *     - `Task<T>` / `ValueTask<T>` / `Lazy<T>` — unwrap one level and
 *       re-classify; emit EMBEDS via "task"/"value_task"/"lazy" against T
 *
 * CS-3: attributes + qualified-name resolution.
 *   - `attribute_list` on any declaration → HAS_ANNOTATION edges from
 *     the inner entity to `csharp:type:${AttributeName}`. The trailing
 *     `Attribute` suffix is stripped from the short name when present
 *     (`[Serializable]` and `[SerializableAttribute]` both resolve to
 *     `Serializable`). Constructor arguments are dropped — we record
 *     presence, not call shape.
 *   - All entities carry fully-qualified names:
 *       `<namespace>.<OuterType>.<Member>`. For nested types this
 *       chains through declaration scope.
 *
 * Coherence note (polyglot intermediate-layer audit):
 *   - Every Field/Property/Method/Constructor/Destructor entity carries
 *     `attrs.owner_qualified_name` so the bridge's `indexEntities`
 *     buckets members onto their owning type by lookup, not substring
 *     parsing.
 *   - Every type-targeting edge sets `meta.base_type` + `meta.resolved`
 *     so the orchestrator's `resolvePointerTarget` can rewrite
 *     placeholders to concrete entity ids.
 *   - `model_kind = ${entity.language}:${entity.kind.toLowerCase()}`
 *     is computed downstream; no C#-specific branching here.
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

const NAME = "csharp";
const VERSION = "0.1.0";
const LANGUAGE = "csharp";
const EXTENSIONS: readonly string[] = [".cs"];

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

function joinQn(prefix: string, name: string): string {
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
    const c = node.namedChild(i);
    if (c && kinds.has(c.type)) return c;
  }
  return null;
}

function namedChildrenOfKind(
  node: SyntaxNode,
  kinds: ReadonlySet<string>,
): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c && kinds.has(c.type)) out.push(c);
  }
  return out;
}

/**
 * Read the keyword-style modifiers on a declaration. C#'s tree-sitter
 * grammar emits each modifier as a `modifier` node containing a single
 * anonymous child whose `type` IS the keyword (`public`, `static`,
 * `async`, `partial`, `abstract`, `sealed`, `virtual`, `override`,
 * `readonly`, `const`, `required`, `extern`, `unsafe`, `volatile`,
 * `new`, `protected`, `private`, `internal`, `file`, `fixed`, `ref`).
 */
function readModifiers(node: SyntaxNode): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (!c || c.type !== "modifier") continue;
    for (let j = 0; j < c.childCount; j++) {
      const k = c.child(j);
      if (k) { out.add(k.type); break; }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Module identity
// ---------------------------------------------------------------------------

interface ModuleIdentity {
  /** Effective namespace for top-level types ("" if global / no namespace). */
  namespaceQn: string;
  /** Module qn used for the Module entity (namespaceQn or file stem). */
  moduleQn: string;
  /** File stem without extension. */
  stem: string;
}

function deriveFileNamespaceFromTree(root: SyntaxNode): string {
  // Look for file_scoped_namespace_declaration first.
  for (let i = 0; i < root.namedChildCount; i++) {
    const c = root.namedChild(i);
    if (!c) continue;
    if (c.type === "file_scoped_namespace_declaration") {
      const name = namedChildOfKind(c, new Set(["qualified_name", "identifier"]));
      return name ? name.text.trim() : "";
    }
  }
  return "";
}

function deriveModuleIdentity(file: ExtractFileInput, root: SyntaxNode): ModuleIdentity {
  const stem = file.name.replace(/\.cs$/i, "");
  const ns = deriveFileNamespaceFromTree(root);
  return {
    namespaceQn: ns,
    moduleQn: ns || stem,
    stem,
  };
}

// ---------------------------------------------------------------------------
// Type-shape vocabulary
// ---------------------------------------------------------------------------

const COLLECTION_VIAS: Record<string, string> = {
  List: "list",
  IList: "list",
  ICollection: "collection",
  IEnumerable: "enumerable",
  IReadOnlyList: "read_only_list",
  IReadOnlyCollection: "read_only_collection",
  HashSet: "set",
  ISet: "set",
  IReadOnlySet: "read_only_set",
  SortedSet: "sorted_set",
  Stack: "stack",
  Queue: "queue",
  LinkedList: "linked_list",
  ObservableCollection: "observable_collection",
  ImmutableList: "immutable_list",
  ImmutableArray: "immutable_array",
  ImmutableHashSet: "immutable_set",
};

const MAP_VIAS: Record<string, string> = {
  Dictionary: "map",
  IDictionary: "map",
  IReadOnlyDictionary: "read_only_map",
  SortedDictionary: "sorted_map",
  ConcurrentDictionary: "concurrent_map",
  ImmutableDictionary: "immutable_map",
  Hashtable: "hashtable",
};

const WRAPPER_VIAS: Record<string, string> = {
  Task: "task",
  ValueTask: "value_task",
  Lazy: "lazy",
  Nullable: "nullable",
};

const PREDEFINED_NAMES = new Set([
  "bool", "byte", "sbyte", "char", "decimal", "double", "float",
  "int", "uint", "long", "ulong", "short", "ushort", "object",
  "string", "void", "nint", "nuint", "dynamic",
]);

// ---------------------------------------------------------------------------
// Type classification (type node → shape)
// ---------------------------------------------------------------------------

interface TypeShape {
  baseType: string;
  typeArgs: string[];
  isNullable: boolean;
  rawHead: string;
  /** True if the original syntax was `T[]` (array). */
  isArray: boolean;
}

function classifyType(typeNode: SyntaxNode | null): TypeShape | null {
  if (!typeNode) return null;
  switch (typeNode.type) {
    case "predefined_type": {
      const t = typeNode.text.trim();
      return { baseType: t, typeArgs: [], isNullable: false, rawHead: t, isArray: false };
    }
    case "identifier": {
      const t = typeNode.text.trim();
      return { baseType: t, typeArgs: [], isNullable: false, rawHead: t, isArray: false };
    }
    case "qualified_name": {
      const t = lastDotSegment(typeNode.text);
      return { baseType: t, typeArgs: [], isNullable: false, rawHead: t, isArray: false };
    }
    case "nullable_type": {
      const inner = typeNode.namedChild(0);
      const sub = classifyType(inner);
      if (!sub) return null;
      // Optional[T] semantics: surface T but mark nullable.
      return { ...sub, isNullable: true };
    }
    case "array_type": {
      // Children: type + array_rank_specifier
      const inner = namedChildOfKind(typeNode, new Set([
        "predefined_type", "identifier", "qualified_name", "generic_name",
        "nullable_type", "array_type",
      ]));
      const sub = inner ? classifyType(inner) : null;
      if (!sub) return null;
      return {
        baseType: sub.baseType,
        typeArgs: [sub.baseType],
        isNullable: false,
        rawHead: "Array",
        isArray: true,
      };
    }
    case "generic_name": {
      const id = namedChildOfKind(typeNode, new Set(["identifier"]));
      const head = id ? id.text : "";
      const args = collectGenericArgs(typeNode);
      // Nullable<T> → unwrap to T as nullable.
      if (head === "Nullable" && args.length === 1) {
        return {
          baseType: args[0]!,
          typeArgs: [],
          isNullable: true,
          rawHead: head,
          isArray: false,
        };
      }
      return {
        baseType: head,
        typeArgs: args,
        isNullable: false,
        rawHead: head,
        isArray: false,
      };
    }
    default:
      return null;
  }
}

function collectGenericArgs(genericNode: SyntaxNode): string[] {
  const tal = namedChildOfKind(genericNode, new Set(["type_argument_list"]));
  if (!tal) return [];
  const out: string[] = [];
  for (let i = 0; i < tal.namedChildCount; i++) {
    const c = tal.namedChild(i);
    if (!c) continue;
    const sub = classifyType(c);
    if (sub) out.push(sub.baseType);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Attribute / annotation handling
// ---------------------------------------------------------------------------

interface AttributeRef {
  fullName: string;
  /** Canonical short name with trailing `Attribute` stripped. */
  shortName: string;
  node: SyntaxNode;
}

function readAttributes(decl: SyntaxNode): AttributeRef[] {
  const out: AttributeRef[] = [];
  for (let i = 0; i < decl.namedChildCount; i++) {
    const c = decl.namedChild(i);
    if (!c || c.type !== "attribute_list") continue;
    for (let j = 0; j < c.namedChildCount; j++) {
      const a = c.namedChild(j);
      if (!a || a.type !== "attribute") continue;
      // attribute → name (identifier|qualified_name|generic_name) + optional attribute_argument_list
      const nameNode = namedChildOfKind(a, new Set([
        "identifier", "qualified_name", "generic_name",
      ]));
      if (!nameNode) continue;
      const full = nameNode.text.trim();
      const short = stripAttributeSuffix(lastDotSegment(full));
      out.push({ fullName: full, shortName: short, node: a });
    }
  }
  return out;
}

function stripAttributeSuffix(name: string): string {
  return name.endsWith("Attribute") && name.length > "Attribute".length
    ? name.slice(0, -"Attribute".length)
    : name;
}

function emitAttributeEdges(
  ctx: WalkCtx,
  attrs: readonly AttributeRef[],
  fromEntityId: string,
): void {
  for (const a of attrs) {
    ctx.edges.push({
      from: fromEntityId,
      to: `${LANGUAGE}:type:${a.shortName}`,
      relationship: Relationship.HAS_ANNOTATION,
      evidence: evidence(a.node),
      meta: {
        via: "attribute",
        base_type: a.shortName,
        attribute_name: a.fullName,
        resolved: false,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Walk context
// ---------------------------------------------------------------------------

interface WalkCtx {
  relPath: string;
  entities: ExtractedEntity[];
  edges: ExtractedEdge[];
  diagnostics: ExtractorDiagnostic[];
  fileEntityId: string;
  /** Current qn prefix (namespace + nested types). */
  prefix: string;
  /** Module's qualified name (for top-level Function/Field owner). */
  moduleQn: string;
  /** Names already emitted as members of the current owner qn — keyed `${ownerQn}#${name}`. */
  emittedMembers: Set<string>;
}

// ---------------------------------------------------------------------------
// Usings
// ---------------------------------------------------------------------------

function handleUsingDirective(node: SyntaxNode, ctx: WalkCtx): void {
  // Children: optional `static`, optional `name_equals` (alias =),
  // then identifier|qualified_name.
  let isStatic = false;
  let alias = "";
  let path = "";
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (!c) continue;
    if (c.type === "name_equals") {
      const id = namedChildOfKind(c, new Set(["identifier"]));
      if (id) alias = id.text;
    } else if (c.type === "identifier" || c.type === "qualified_name") {
      path = c.text.trim();
    }
  }
  // `static` is an anonymous keyword child — scan all children.
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c && c.type === "static") { isStatic = true; break; }
  }
  if (!path) return;
  const meta: Record<string, unknown> = { kind: "namespace" };
  if (isStatic) meta.static = true;
  if (alias) meta.alias = alias;
  ctx.edges.push({
    from: ctx.fileEntityId,
    to: `${LANGUAGE}:use:${path}`,
    relationship: Relationship.IMPORTS,
    evidence: evidence(node),
    meta,
  });
}

// ---------------------------------------------------------------------------
// Type declaration handling
// ---------------------------------------------------------------------------

interface TypeDeclKindInfo {
  kind: CodeEntityKind;
  /** True if interface; bases are EXTENDS rather than first-EXTENDS-rest-IMPLEMENTS. */
  isInterface: boolean;
  /** True if class-like (class/record), so bases are class-first IMPLEMENTS-rest. */
  isClassLike: boolean;
  /** True if struct/record_struct — same syntactic base treatment as class. */
  isStructLike: boolean;
}

function typeDeclKind(node: SyntaxNode): TypeDeclKindInfo | null {
  switch (node.type) {
    case "class_declaration":
      return { kind: CodeEntityKind.Class, isInterface: false, isClassLike: true, isStructLike: false };
    case "interface_declaration":
      return { kind: CodeEntityKind.Interface, isInterface: true, isClassLike: false, isStructLike: false };
    case "struct_declaration":
      return { kind: CodeEntityKind.Struct, isInterface: false, isClassLike: false, isStructLike: true };
    case "record_declaration":
      return { kind: CodeEntityKind.Record, isInterface: false, isClassLike: true, isStructLike: false };
    case "record_struct_declaration":
      return { kind: CodeEntityKind.Struct, isInterface: false, isClassLike: false, isStructLike: true };
    case "enum_declaration":
      return { kind: CodeEntityKind.Enum, isInterface: false, isClassLike: false, isStructLike: false };
    case "delegate_declaration":
      return { kind: CodeEntityKind.TypeAlias, isInterface: false, isClassLike: false, isStructLike: false };
    default:
      return null;
  }
}

function handleNamespaceDeclaration(node: SyntaxNode, ctx: WalkCtx): void {
  // namespace_declaration: namespace <qualified_name|identifier> declaration_list
  const nameNode = namedChildOfKind(node, new Set(["qualified_name", "identifier"]));
  const declList = namedChildOfKind(node, new Set(["declaration_list"]));
  if (!nameNode || !declList) return;
  const nsQn = nameNode.text.trim();
  const childPrefix = joinQn(ctx.prefix, nsQn);
  // Emit a Module entity for the nested namespace too.
  const modEntity: ExtractedEntity = {
    id: entityId(ctx.relPath, CodeEntityKind.Module, childPrefix),
    kind: CodeEntityKind.Module,
    name: lastDotSegment(nsQn),
    qualifiedName: childPrefix,
    language: LANGUAGE,
    relPath: ctx.relPath,
    line: nameNode.startPosition.row + 1,
    column: nameNode.startPosition.column + 1,
    attrs: { is_namespace: true },
  };
  ctx.entities.push(modEntity);

  const childCtx: WalkCtx = { ...ctx, prefix: childPrefix, emittedMembers: new Set<string>() };
  for (let i = 0; i < declList.namedChildCount; i++) {
    const stmt = declList.namedChild(i);
    if (!stmt) continue;
    dispatchTopLevel(stmt, childCtx);
  }
}

function handleTypeDeclaration(node: SyntaxNode, ctx: WalkCtx): void {
  const info = typeDeclKind(node);
  if (!info) return;
  // For delegates the name follows the return type and the return type
  // can itself be an `identifier`, so use `pickNameAfterType`. For all
  // other declarations the name is the first `identifier` child.
  const nameNode = info.kind === CodeEntityKind.TypeAlias
    ? pickNameAfterType(node)
    : namedChildOfKind(node, new Set(["identifier"]));
  if (!nameNode) return;
  const name = nameNode.text;
  const qn = joinQn(ctx.prefix, name);
  const mods = readModifiers(node);
  const attrs: Record<string, unknown> = {};
  applyClassLikeModifierAttrs(mods, attrs);

  // Type-parameter list — record names only.
  const tpl = namedChildOfKind(node, new Set(["type_parameter_list"]));
  if (tpl) {
    const params: string[] = [];
    for (let i = 0; i < tpl.namedChildCount; i++) {
      const c = tpl.namedChild(i);
      if (c && c.type === "type_parameter") {
        const idn = namedChildOfKind(c, new Set(["identifier"]));
        if (idn) params.push(idn.text);
      }
    }
    if (params.length > 0) attrs.type_parameters = params;
  }

  // Delegates have a return type + parameter list; capture return type.
  if (info.kind === CodeEntityKind.TypeAlias) {
    const ret = firstTypeChild(node);
    if (ret) attrs.return_type = ret;
    attrs.delegate = true;
  }

  const entity: ExtractedEntity = {
    id: entityId(ctx.relPath, info.kind, qn),
    kind: info.kind,
    name,
    qualifiedName: qn,
    language: LANGUAGE,
    relPath: ctx.relPath,
    line: nameNode.startPosition.row + 1,
    column: nameNode.startPosition.column + 1,
    attrs,
  };
  ctx.entities.push(entity);

  // Attribute edges.
  const decoratorAttrs = readAttributes(node);
  emitAttributeEdges(ctx, decoratorAttrs, entity.id);

  // Base list.
  const baseList = namedChildOfKind(node, new Set(["base_list"]));
  if (baseList) {
    emitBaseEdges(baseList, entity.id, info, ctx);
  }

  // Primary constructor parameters for records.
  if (info.kind === CodeEntityKind.Record || node.type === "record_struct_declaration") {
    const params = namedChildOfKind(node, new Set(["parameter_list"]));
    if (params) emitPrimaryCtorParams(params, qn, ctx);
  }

  // Enum members.
  if (info.kind === CodeEntityKind.Enum) {
    const list = namedChildOfKind(node, new Set(["enum_member_declaration_list"]));
    if (list) emitEnumMembers(list, qn, ctx);
    return;
  }

  // Delegates have no member body.
  if (info.kind === CodeEntityKind.TypeAlias) return;

  // Walk declaration_list body.
  const body = namedChildOfKind(node, new Set(["declaration_list"]));
  if (!body) return;

  const childCtx: WalkCtx = { ...ctx, prefix: qn, emittedMembers: new Set<string>() };
  for (let i = 0; i < body.namedChildCount; i++) {
    const stmt = body.namedChild(i);
    if (!stmt) continue;
    handleTypeMember(stmt, childCtx, qn, info);
  }
}

function firstTypeChild(node: SyntaxNode): string | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (!c) continue;
    if (c.type === "predefined_type" || c.type === "identifier" ||
        c.type === "qualified_name" || c.type === "generic_name" ||
        c.type === "nullable_type" || c.type === "array_type") {
      return c.text.trim();
    }
  }
  return null;
}

/**
 * Pick the name identifier of a typed declaration (method, property,
 * delegate) where the layout is `<type> <name>`. Because the return /
 * declared type can itself be an `identifier`, we skip the first
 * non-modifier/non-attribute child if it is type-like (including
 * identifier), then return the next identifier we see.
 */
const TYPE_LIKE_NODE_TYPES: ReadonlySet<string> = new Set([
  "predefined_type", "qualified_name", "generic_name",
  "nullable_type", "array_type", "tuple_type", "pointer_type",
  "function_pointer_type", "ref_type",
]);

function pickNameAfterType(node: SyntaxNode): SyntaxNode | null {
  let consumedType = false;
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (!c) continue;
    if (c.type === "modifier" || c.type === "attribute_list") continue;
    if (!consumedType) {
      consumedType = true;
      if (c.type === "identifier" || TYPE_LIKE_NODE_TYPES.has(c.type)) continue;
    }
    if (c.type === "identifier") return c;
  }
  return null;
}

function applyClassLikeModifierAttrs(mods: ReadonlySet<string>, attrs: Record<string, unknown>): void {
  if (mods.has("abstract")) attrs.is_abstract = true;
  if (mods.has("sealed")) attrs.is_sealed = true;
  if (mods.has("static")) attrs.is_static = true;
  if (mods.has("partial")) attrs.is_partial = true;
  if (mods.has("readonly")) attrs.is_readonly = true;
  if (mods.has("ref")) attrs.is_ref = true;
  attrs.visibility = pickVisibility(mods);
}

function pickVisibility(mods: ReadonlySet<string>): string {
  if (mods.has("public")) return "public";
  if (mods.has("private")) return "private";
  if (mods.has("internal") && mods.has("protected")) return "protected_internal";
  if (mods.has("protected")) return "protected";
  if (mods.has("internal")) return "internal";
  if (mods.has("file")) return "file";
  return "internal"; // C# default for top-level types
}

// ---------------------------------------------------------------------------
// Base list
// ---------------------------------------------------------------------------

interface BaseRef {
  shortName: string;
  fullName: string;
  node: SyntaxNode;
}

function readBaseRefs(baseList: SyntaxNode): BaseRef[] {
  const out: BaseRef[] = [];
  for (let i = 0; i < baseList.namedChildCount; i++) {
    const c = baseList.namedChild(i);
    if (!c) continue;
    if (c.type === "identifier" || c.type === "qualified_name") {
      out.push({ shortName: lastDotSegment(c.text), fullName: c.text.trim(), node: c });
    } else if (c.type === "generic_name") {
      const id = namedChildOfKind(c, new Set(["identifier"]));
      const head = id ? id.text : c.text.trim();
      out.push({ shortName: head, fullName: c.text.trim(), node: c });
    } else if (c.type === "predefined_type") {
      // e.g. `enum X : byte` — record the underlying type as a base ref
      // so we still see the dependency, but with via="enum_underlying".
      out.push({ shortName: c.text.trim(), fullName: c.text.trim(), node: c });
    }
  }
  return out;
}

function emitBaseEdges(
  baseList: SyntaxNode,
  ownerId: string,
  info: TypeDeclKindInfo,
  ctx: WalkCtx,
): void {
  const refs = readBaseRefs(baseList);
  if (refs.length === 0) return;

  // For enum: only one entry possible — the underlying type. Skip
  // EXTENDS but optionally record as a REFERENCES_TYPE edge so the
  // dependency is visible without polluting inheritance.
  if (info.kind === CodeEntityKind.Enum) {
    const b = refs[0]!;
    ctx.edges.push({
      from: ownerId,
      to: `${LANGUAGE}:type:${b.shortName}`,
      relationship: Relationship.REFERENCES_TYPE,
      evidence: evidence(b.node),
      meta: { via: "enum_underlying", base_type: b.shortName, base_name: b.fullName, resolved: false },
    });
    return;
  }

  // For interface declarations every base is EXTENDS (interface
  // inheritance). For class/record/struct the first base MAY be a
  // class (EXTENDS) and remainder are interfaces (IMPLEMENTS). C#
  // language rules guarantee that if a class is present, it is first.
  if (info.isInterface) {
    for (const b of refs) {
      ctx.edges.push({
        from: ownerId,
        to: `${LANGUAGE}:type:${b.shortName}`,
        relationship: Relationship.EXTENDS,
        evidence: evidence(b.node),
        meta: { via: "interface_inheritance", base_type: b.shortName, base_name: b.fullName, resolved: false },
      });
    }
    return;
  }

  for (let i = 0; i < refs.length; i++) {
    const b = refs[i]!;
    const rel = i === 0 ? Relationship.EXTENDS : Relationship.IMPLEMENTS;
    ctx.edges.push({
      from: ownerId,
      to: `${LANGUAGE}:type:${b.shortName}`,
      relationship: rel,
      evidence: evidence(b.node),
      meta: {
        via: i === 0 ? "inheritance" : "implementation",
        base_type: b.shortName,
        base_name: b.fullName,
        resolved: false,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Type members
// ---------------------------------------------------------------------------

function handleTypeMember(
  stmt: SyntaxNode,
  ctx: WalkCtx,
  ownerQn: string,
  ownerInfo: TypeDeclKindInfo,
): void {
  switch (stmt.type) {
    case "field_declaration":
      handleFieldDeclaration(stmt, ctx, ownerQn, false);
      break;
    case "event_field_declaration":
      handleFieldDeclaration(stmt, ctx, ownerQn, true);
      break;
    case "property_declaration":
      handlePropertyDeclaration(stmt, ctx, ownerQn, false);
      break;
    case "indexer_declaration":
      handlePropertyDeclaration(stmt, ctx, ownerQn, true);
      break;
    case "method_declaration":
      handleMethodDeclaration(stmt, ctx, ownerQn, ownerInfo);
      break;
    case "constructor_declaration":
      handleConstructorDeclaration(stmt, ctx, ownerQn);
      break;
    case "destructor_declaration":
      handleDestructorDeclaration(stmt, ctx, ownerQn);
      break;
    case "class_declaration":
    case "interface_declaration":
    case "struct_declaration":
    case "record_declaration":
    case "record_struct_declaration":
    case "enum_declaration":
    case "delegate_declaration":
      handleTypeDeclaration(stmt, ctx);
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Fields & events
// ---------------------------------------------------------------------------

function handleFieldDeclaration(
  node: SyntaxNode,
  ctx: WalkCtx,
  ownerQn: string,
  isEvent: boolean,
): void {
  const mods = readModifiers(node);
  const decl = namedChildOfKind(node, new Set(["variable_declaration"]));
  if (!decl) return;
  // variable_declaration → type + variable_declarator+
  const typeNode = firstTypeNodeChild(decl);
  const declarators: SyntaxNode[] = [];
  for (let i = 0; i < decl.namedChildCount; i++) {
    const c = decl.namedChild(i);
    if (c && c.type === "variable_declarator") declarators.push(c);
  }
  const attributes = readAttributes(node);
  for (const dN of declarators) {
    const idNode = namedChildOfKind(dN, new Set(["identifier"]));
    if (!idNode) continue;
    const name = idNode.text;
    const key = `${ownerQn}#${name}`;
    if (ctx.emittedMembers.has(key)) continue;
    ctx.emittedMembers.add(key);

    const fieldQn = joinQn(ownerQn, name);
    const shape = classifyType(typeNode);
    const attrs: Record<string, unknown> = {
      owner_qualified_name: ownerQn,
      is_annotated: true,
      visibility: pickVisibility(mods),
    };
    if (mods.has("static")) attrs.is_static = true;
    if (mods.has("readonly")) attrs.is_readonly = true;
    if (mods.has("const")) attrs.is_const = true;
    if (mods.has("required")) attrs.is_required = true;
    if (mods.has("volatile")) attrs.is_volatile = true;
    if (isEvent) attrs.is_event = true;
    if (typeNode) attrs.type_text = typeNode.text;
    if (shape?.isNullable) attrs.is_nullable = true;

    const fieldId = entityId(ctx.relPath, CodeEntityKind.Field, fieldQn);
    ctx.entities.push({
      id: fieldId,
      kind: CodeEntityKind.Field,
      name,
      qualifiedName: fieldQn,
      language: LANGUAGE,
      relPath: ctx.relPath,
      line: idNode.startPosition.row + 1,
      column: idNode.startPosition.column + 1,
      attrs,
    });

    emitAttributeEdges(ctx, attributes, fieldId);
    if (shape) emitShapeEdges(ctx, fieldId, shape, idNode);

    if (mods.has("const")) {
      const constQn = fieldQn;
      ctx.entities.push({
        id: entityId(ctx.relPath, CodeEntityKind.Constant, constQn),
        kind: CodeEntityKind.Constant,
        name,
        qualifiedName: constQn,
        language: LANGUAGE,
        relPath: ctx.relPath,
        line: idNode.startPosition.row + 1,
        column: idNode.startPosition.column + 1,
        attrs: { owner_qualified_name: ownerQn, is_annotated: true },
      });
    }
  }
}

function firstTypeNodeChild(decl: SyntaxNode): SyntaxNode | null {
  for (let i = 0; i < decl.namedChildCount; i++) {
    const c = decl.namedChild(i);
    if (!c) continue;
    if (c.type === "predefined_type" || c.type === "identifier" ||
        c.type === "qualified_name" || c.type === "generic_name" ||
        c.type === "nullable_type" || c.type === "array_type") {
      return c;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Properties & indexers
// ---------------------------------------------------------------------------

function handlePropertyDeclaration(
  node: SyntaxNode,
  ctx: WalkCtx,
  ownerQn: string,
  isIndexer: boolean,
): void {
  const mods = readModifiers(node);
  const typeNode = firstTypeNodeChild(node);
  const name = isIndexer ? "this[]" : (() => {
    const id = pickNameAfterType(node);
    return id ? id.text : "";
  })();
  if (!name) return;
  const key = `${ownerQn}#${name}`;
  if (ctx.emittedMembers.has(key)) return;
  ctx.emittedMembers.add(key);

  const propQn = joinQn(ownerQn, name);
  const shape = classifyType(typeNode);
  const attrs: Record<string, unknown> = {
    owner_qualified_name: ownerQn,
    is_annotated: true,
    visibility: pickVisibility(mods),
  };
  if (mods.has("static")) attrs.is_static = true;
  if (mods.has("virtual")) attrs.is_virtual = true;
  if (mods.has("override")) attrs.is_override = true;
  if (mods.has("abstract")) attrs.is_abstract = true;
  if (mods.has("sealed")) attrs.is_sealed = true;
  if (mods.has("required")) attrs.is_required = true;
  if (isIndexer) attrs.is_indexer = true;
  if (typeNode) attrs.type_text = typeNode.text;
  if (shape?.isNullable) attrs.is_nullable = true;

  // Detect init-only via accessor_list scan.
  const accList = namedChildOfKind(node, new Set(["accessor_list"]));
  if (accList) {
    for (let i = 0; i < accList.namedChildCount; i++) {
      const a = accList.namedChild(i);
      if (a && a.type === "accessor_declaration") {
        for (let j = 0; j < a.childCount; j++) {
          const k = a.child(j);
          if (k && k.type === "init") { attrs.is_init_only = true; break; }
        }
      }
    }
  }

  const propId = entityId(ctx.relPath, CodeEntityKind.Property, propQn);
  ctx.entities.push({
    id: propId,
    kind: CodeEntityKind.Property,
    name,
    qualifiedName: propQn,
    language: LANGUAGE,
    relPath: ctx.relPath,
    line: node.startPosition.row + 1,
    column: node.startPosition.column + 1,
    attrs,
  });

  emitAttributeEdges(ctx, readAttributes(node), propId);
  if (shape) emitShapeEdges(ctx, propId, shape, node);
}

// ---------------------------------------------------------------------------
// Methods, constructors, destructors
// ---------------------------------------------------------------------------

function handleMethodDeclaration(
  node: SyntaxNode,
  ctx: WalkCtx,
  ownerQn: string,
  ownerInfo: TypeDeclKindInfo,
): void {
  const mods = readModifiers(node);
  const idNode = pickNameAfterType(node);
  if (!idNode) return;
  const name = idNode.text;
  const qn = joinQn(ownerQn, name);
  const attrs: Record<string, unknown> = {
    owner_qualified_name: ownerQn,
    visibility: pickVisibility(mods),
    is_async: mods.has("async"),
  };
  if (mods.has("static")) attrs.is_static = true;
  if (mods.has("virtual")) attrs.is_virtual = true;
  if (mods.has("override")) attrs.is_override = true;
  if (mods.has("abstract")) attrs.is_abstract = true;
  if (mods.has("sealed")) attrs.is_sealed = true;
  if (mods.has("partial")) attrs.is_partial = true;
  if (mods.has("extern")) attrs.is_extern = true;
  if (mods.has("new")) attrs.is_new_slot = true;
  if (ownerInfo.isInterface) attrs.is_abstract = true;

  const retType = firstTypeChild(node);
  if (retType) attrs.return_type = retType;

  const mId = entityId(ctx.relPath, CodeEntityKind.Method, qn);
  ctx.entities.push({
    id: mId,
    kind: CodeEntityKind.Method,
    name,
    qualifiedName: qn,
    language: LANGUAGE,
    relPath: ctx.relPath,
    line: idNode.startPosition.row + 1,
    column: idNode.startPosition.column + 1,
    attrs,
  });
  emitAttributeEdges(ctx, readAttributes(node), mId);
}

function handleConstructorDeclaration(
  node: SyntaxNode,
  ctx: WalkCtx,
  ownerQn: string,
): void {
  const mods = readModifiers(node);
  const idNode = namedChildOfKind(node, new Set(["identifier"]));
  if (!idNode) return;
  const name = idNode.text;
  const qn = joinQn(ownerQn, name);
  const attrs: Record<string, unknown> = {
    owner_qualified_name: ownerQn,
    visibility: pickVisibility(mods),
  };
  if (mods.has("static")) attrs.is_static = true;
  const cId = entityId(ctx.relPath, CodeEntityKind.Constructor, qn);
  ctx.entities.push({
    id: cId,
    kind: CodeEntityKind.Constructor,
    name,
    qualifiedName: qn,
    language: LANGUAGE,
    relPath: ctx.relPath,
    line: idNode.startPosition.row + 1,
    column: idNode.startPosition.column + 1,
    attrs,
  });
  emitAttributeEdges(ctx, readAttributes(node), cId);
}

function handleDestructorDeclaration(
  node: SyntaxNode,
  ctx: WalkCtx,
  ownerQn: string,
): void {
  const idNode = namedChildOfKind(node, new Set(["identifier"]));
  if (!idNode) return;
  const name = `~${idNode.text}`;
  const qn = joinQn(ownerQn, name);
  const dId = entityId(ctx.relPath, CodeEntityKind.Destructor, qn);
  ctx.entities.push({
    id: dId,
    kind: CodeEntityKind.Destructor,
    name,
    qualifiedName: qn,
    language: LANGUAGE,
    relPath: ctx.relPath,
    line: idNode.startPosition.row + 1,
    column: idNode.startPosition.column + 1,
    attrs: { owner_qualified_name: ownerQn },
  });
}

// ---------------------------------------------------------------------------
// Primary ctor params (records) and enum members
// ---------------------------------------------------------------------------

function emitPrimaryCtorParams(paramList: SyntaxNode, ownerQn: string, ctx: WalkCtx): void {
  for (let i = 0; i < paramList.namedChildCount; i++) {
    const p = paramList.namedChild(i);
    if (!p || p.type !== "parameter") continue;
    // parameter: type + identifier (+ attribute_list)
    const typeNode = firstTypeNodeChild(p);
    const idNode = namedChildOfKind(p, new Set(["identifier"]));
    if (!idNode) continue;
    const name = idNode.text;
    const key = `${ownerQn}#${name}`;
    if (ctx.emittedMembers.has(key)) continue;
    ctx.emittedMembers.add(key);

    const fieldQn = joinQn(ownerQn, name);
    const shape = classifyType(typeNode);
    const attrs: Record<string, unknown> = {
      owner_qualified_name: ownerQn,
      is_annotated: true,
      is_primary_ctor_param: true,
      visibility: "public",
    };
    if (typeNode) attrs.type_text = typeNode.text;
    if (shape?.isNullable) attrs.is_nullable = true;

    const fId = entityId(ctx.relPath, CodeEntityKind.Field, fieldQn);
    ctx.entities.push({
      id: fId,
      kind: CodeEntityKind.Field,
      name,
      qualifiedName: fieldQn,
      language: LANGUAGE,
      relPath: ctx.relPath,
      line: idNode.startPosition.row + 1,
      column: idNode.startPosition.column + 1,
      attrs,
    });
    emitAttributeEdges(ctx, readAttributes(p), fId);
    if (shape) emitShapeEdges(ctx, fId, shape, idNode);
  }
}

function emitEnumMembers(list: SyntaxNode, ownerQn: string, ctx: WalkCtx): void {
  for (let i = 0; i < list.namedChildCount; i++) {
    const m = list.namedChild(i);
    if (!m || m.type !== "enum_member_declaration") continue;
    const idNode = namedChildOfKind(m, new Set(["identifier"]));
    if (!idNode) continue;
    const name = idNode.text;
    const qn = joinQn(ownerQn, name);
    ctx.entities.push({
      id: entityId(ctx.relPath, CodeEntityKind.EnumMember, qn),
      kind: CodeEntityKind.EnumMember,
      name,
      qualifiedName: qn,
      language: LANGUAGE,
      relPath: ctx.relPath,
      line: idNode.startPosition.row + 1,
      column: idNode.startPosition.column + 1,
      attrs: { owner_qualified_name: ownerQn },
    });
    emitAttributeEdges(ctx, readAttributes(m), entityId(ctx.relPath, CodeEntityKind.EnumMember, qn));
  }
}

// ---------------------------------------------------------------------------
// Shape edges
// ---------------------------------------------------------------------------

function emitShapeEdges(
  ctx: WalkCtx,
  fromId: string,
  shape: TypeShape,
  anchor: SyntaxNode,
): void {
  // Array syntax `T[]` → CONTAINS_MANY via "array".
  if (shape.isArray) {
    const elem = shape.typeArgs[0] ?? shape.baseType;
    if (elem && !PREDEFINED_NAMES.has(elem)) {
      ctx.edges.push({
        from: fromId,
        to: `${LANGUAGE}:type:${elem}`,
        relationship: Relationship.CONTAINS_MANY,
        evidence: evidence(anchor),
        meta: { via: "array", base_type: elem, from_annotation: true, resolved: false },
      });
    }
    return;
  }

  const head = shape.baseType;

  if (head in COLLECTION_VIAS) {
    const elem = shape.typeArgs[0] ?? "";
    if (elem && !PREDEFINED_NAMES.has(elem)) {
      ctx.edges.push({
        from: fromId,
        to: `${LANGUAGE}:type:${elem}`,
        relationship: Relationship.CONTAINS_MANY,
        evidence: evidence(anchor),
        meta: {
          via: COLLECTION_VIAS[head]!,
          base_type: elem,
          from_annotation: true,
          resolved: false,
          ...(shape.isNullable ? { is_nullable: true } : {}),
        },
      });
    }
    return;
  }

  if (head in MAP_VIAS) {
    const k = shape.typeArgs[0] ?? "";
    const v = shape.typeArgs[1] ?? "";
    if (v && !PREDEFINED_NAMES.has(v)) {
      ctx.edges.push({
        from: fromId,
        to: `${LANGUAGE}:type:${v}`,
        relationship: Relationship.MAPS_K_TO_V,
        evidence: evidence(anchor),
        meta: {
          via: MAP_VIAS[head]!,
          base_type: v,
          from_annotation: true,
          resolved: false,
          ...(k ? { key_type: k } : {}),
          ...(shape.isNullable ? { is_nullable: true } : {}),
        },
      });
    }
    if (k && !PREDEFINED_NAMES.has(k)) {
      ctx.edges.push({
        from: fromId,
        to: `${LANGUAGE}:type:${k}`,
        relationship: Relationship.REFERENCES_TYPE,
        evidence: evidence(anchor),
        meta: { via: "map_key", base_type: k, from_annotation: true, resolved: false },
      });
    }
    return;
  }

  if (head in WRAPPER_VIAS) {
    const inner = shape.typeArgs[0] ?? "";
    if (inner && !PREDEFINED_NAMES.has(inner)) {
      ctx.edges.push({
        from: fromId,
        to: `${LANGUAGE}:type:${inner}`,
        relationship: Relationship.EMBEDS,
        evidence: evidence(anchor),
        meta: {
          via: WRAPPER_VIAS[head]!,
          base_type: inner,
          from_annotation: true,
          resolved: false,
        },
      });
    }
    return;
  }

  // Nullable bare type → MAY_CONTAIN.
  if (shape.isNullable && head && !PREDEFINED_NAMES.has(head)) {
    ctx.edges.push({
      from: fromId,
      to: `${LANGUAGE}:type:${head}`,
      relationship: Relationship.MAY_CONTAIN,
      evidence: evidence(anchor),
      meta: { via: "nullable", base_type: head, from_annotation: true, is_nullable: true, resolved: false },
    });
    return;
  }

  if (PREDEFINED_NAMES.has(head) || !head) return;

  ctx.edges.push({
    from: fromId,
    to: `${LANGUAGE}:type:${head}`,
    relationship: Relationship.EMBEDS,
    evidence: evidence(anchor),
    meta: { via: "value", base_type: head, from_annotation: true, resolved: false },
  });
}

// ---------------------------------------------------------------------------
// Top-level dispatch
// ---------------------------------------------------------------------------

function dispatchTopLevel(stmt: SyntaxNode, ctx: WalkCtx): void {
  switch (stmt.type) {
    case "using_directive":
      handleUsingDirective(stmt, ctx);
      break;
    case "namespace_declaration":
      handleNamespaceDeclaration(stmt, ctx);
      break;
    case "class_declaration":
    case "interface_declaration":
    case "struct_declaration":
    case "record_declaration":
    case "record_struct_declaration":
    case "enum_declaration":
    case "delegate_declaration":
      handleTypeDeclaration(stmt, ctx);
      break;
    default:
      break;
  }
}

function walkCompilationUnit(root: SyntaxNode, ctx: WalkCtx): void {
  for (let i = 0; i < root.namedChildCount; i++) {
    const stmt = root.namedChild(i);
    if (!stmt) continue;
    if (stmt.type === "file_scoped_namespace_declaration") {
      // Items after the `namespace X;` header live as named children
      // of the namespace node itself.
      for (let j = 0; j < stmt.namedChildCount; j++) {
        const inner = stmt.namedChild(j);
        if (!inner) continue;
        if (inner.type === "qualified_name" || inner.type === "identifier") continue;
        dispatchTopLevel(inner, ctx);
      }
      continue;
    }
    dispatchTopLevel(stmt, ctx);
  }
}

// ---------------------------------------------------------------------------
// Extractor
// ---------------------------------------------------------------------------

export const csharpExtractor: Extractor = {
  name: NAME,
  version: VERSION,
  extensions: EXTENSIONS,
  parserBacked: true,
  async extract(file: ExtractFileInput): Promise<ExtractorOutput> {
    const parser = await getParser("csharp");
    const tree = parser.parse(file.source);
    const root = tree.rootNode;

    const ident = deriveModuleIdentity(file, root);
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

    // Module entity for the file's effective namespace (or stem fallback).
    entities.push({
      id: entityId(file.relPath, CodeEntityKind.Module, ident.moduleQn),
      kind: CodeEntityKind.Module,
      name: ident.namespaceQn ? lastDotSegment(ident.namespaceQn) : ident.stem,
      qualifiedName: ident.moduleQn,
      language: LANGUAGE,
      relPath: file.relPath,
      line: 1,
      column: 1,
      attrs: {
        namespace_qualified_name: ident.namespaceQn,
        is_namespace: ident.namespaceQn !== "",
      },
    });

    const diagnostics: ExtractorDiagnostic[] = [];
    if (root.hasError()) {
      diagnostics.push({
        severity: "warning",
        relPath: file.relPath,
        message: "tree-sitter reported parse errors; extraction proceeded best-effort",
      });
    }

    const ctx: WalkCtx = {
      relPath: file.relPath,
      entities,
      edges: [],
      diagnostics,
      fileEntityId: fId,
      prefix: ident.namespaceQn,
      moduleQn: ident.moduleQn,
      emittedMembers: new Set<string>(),
    };

    walkCompilationUnit(root, ctx);

    return {
      entities: ctx.entities,
      edges: ctx.edges,
      shapes: [],
      diagnostics: ctx.diagnostics,
    };
  },
};
