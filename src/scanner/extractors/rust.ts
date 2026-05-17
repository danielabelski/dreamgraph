/**
 * DreamGraph — Rust language extractor (wave 1, phases RS-1..RS-3).
 *
 * RS-1: top-level items.
 *   - Module entities (`mod` blocks; nested modules push a `::`-joined
 *     qualifiedName prefix into the walker context, mirroring how the
 *     C++ extractor handles namespaces).
 *   - Struct / TupleStruct → Struct entities. Named fields and tuple
 *     fields both emit Field entities owned by the struct.
 *   - Enum entities, with EnumMember per variant. Variant payloads
 *     (tuple / struct shape) are stored in `attrs.shape` for later
 *     phases; the variant is still a single EnumMember entity.
 *   - Trait entities, with method *declarations* (Method entities,
 *     attrs.is_definition=false).
 *   - TypeAlias (`type Foo = ...;`).
 *   - Constant (`const`, `static`).
 *   - Function (`fn` outside an impl block; attrs.is_definition=true).
 *   - `use ... ;` → IMPORTS edges on the file with the resolved path
 *     in edge.meta.
 *
 * RS-2: ownership / borrowing shapes on field types.
 *   - `Box<T>`        → OWNS via "box"
 *   - `Rc<T>`         → OWNS_SHARED via "rc"
 *   - `Arc<T>`        → OWNS_SHARED via "arc"
 *   - `Weak<T>`       → BORROWS_WEAK via "weak"
 *   - `Option<T>`     → MAY_CONTAIN via "option"
 *   - `Result<T,E>`   → MAY_CONTAIN via "result" (carries `error_type`)
 *   - `Vec<T>`        → CONTAINS_MANY via "vec"
 *   - `HashMap<K,V>`  → MAPS_K_TO_V via "hashmap"
 *   - `BTreeMap<K,V>` → MAPS_K_TO_V via "btreemap"
 *   - `HashSet<T>`    → CONTAINS_MANY via "hashset"
 *   - `BTreeSet<T>`   → CONTAINS_MANY via "btreeset"
 *   - `&T`            → BORROWS via "shared_ref"
 *   - `&mut T`        → BORROWS via "mut_ref"
 *   - `*const T`      → POINTS_TO via "raw_ptr"
 *   - `*mut T`        → POINTS_TO via "raw_mut_ptr"
 *   - Plain user type → EMBEDS via "value"
 *
 *   Targets are emitted as language-agnostic placeholders
 *   `rust:type:Name`; the orchestrator binds them through the same
 *   resolver that handles C / C++ placeholders.
 *
 * RS-3: impl blocks.
 *   - `impl Type { ... fn foo(...) {...} ... }` → Method entities
 *     with qualifiedName `Type::foo`, attrs.is_definition=true.
 *     A `DECLARES_METHOD` edge binds the Type to the Method (cross-file
 *     binding via the orchestrator).
 *   - `impl Trait for Type { ... }` → IMPLEMENTS_TRAIT edge from the
 *     Type entity to `rust:type:Trait`, plus Method entities for the
 *     individual implementations.
 *   - Associated `const` / `type` in an impl block surface as
 *     Constant / TypeAlias entities qualified by the impl target type.
 *
 * Everything emitted by this extractor uses the canonical
 * `CodeEntityKind` and `Relationship` vocabulary from `../ontology.js`.
 * Language-specific construct names (e.g. "box", "rc") only ever live
 * inside `edge.meta.via` so semantic binding remains language-agnostic.
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

const NAME = "rust";
const VERSION = "0.1.0";
const LANGUAGE = "rust";
const EXTENSIONS: readonly string[] = [".rs"];

function fileId(relPath: string): string {
  return `${LANGUAGE}:${relPath}`;
}

function entityId(
  relPath: string,
  kind: string,
  qualifiedName: string,
): string {
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

function joinQn(prefix: string, name: string): string {
  return prefix ? `${prefix}::${name}` : name;
}

function fieldName(node: SyntaxNode): string {
  return nodeText(node.childForFieldName("name"));
}

// ---------------------------------------------------------------------------
// Rust type-shape classification (RS-2)
// ---------------------------------------------------------------------------

interface TypeShape {
  /** Canonical relationship to emit. */
  relationship: typeof Relationship[keyof typeof Relationship];
  /** Language-specific construct label (goes into edge.meta.via). */
  via: string;
  /** Primary referenced type name (the OWNS / BORROWS target). */
  baseType: string;
  /** Additional referenced type for K/V containers. */
  secondaryType?: string;
  /** Extra meta to attach to the edge (mutability, raw-ptr-ness, …). */
  extraMeta?: Record<string, unknown>;
}

/**
 * Smart-pointer-like generics that carry ownership semantics in std.
 * Keyed by the leading type identifier (`Box`, `Rc`, …); we
 * intentionally do NOT match fully-qualified paths like
 * `std::boxed::Box` because cross-crate path resolution is out of
 * scope for RS-2.
 */
const GENERIC_OWNERSHIP: Record<string, { relationship: typeof Relationship[keyof typeof Relationship]; via: string }> = {
  Box:        { relationship: Relationship.OWNS,         via: "box" },
  Rc:         { relationship: Relationship.OWNS_SHARED,  via: "rc" },
  Arc:        { relationship: Relationship.OWNS_SHARED,  via: "arc" },
  Weak:       { relationship: Relationship.BORROWS_WEAK, via: "weak" },
  Cell:       { relationship: Relationship.OWNS,         via: "cell" },
  RefCell:    { relationship: Relationship.OWNS,         via: "refcell" },
  Mutex:      { relationship: Relationship.OWNS,         via: "mutex" },
  RwLock:     { relationship: Relationship.OWNS,         via: "rwlock" },
};

const GENERIC_OPTIONAL: Record<string, string> = {
  Option: "option",
  Result: "result",
};

const GENERIC_COLLECTION: Record<string, string> = {
  Vec:       "vec",
  VecDeque:  "vecdeque",
  LinkedList: "linkedlist",
  HashSet:   "hashset",
  BTreeSet:  "btreeset",
};

const GENERIC_MAP: Record<string, string> = {
  HashMap:  "hashmap",
  BTreeMap: "btreemap",
};

/**
 * Inspect a Rust type expression node and decide which relationship +
 * via label it represents. Returns `null` when the type carries no
 * recognisable shape (e.g. a primitive or a function pointer) — the
 * caller emits no relationship in that case but still records the
 * `type_text` on the Field entity.
 */
function classifyType(typeNode: SyntaxNode | null): TypeShape | null {
  if (!typeNode) return null;
  switch (typeNode.type) {
    case "reference_type": {
      const isMut = hasMutableSpecifier(typeNode);
      const inner = typeNode.childForFieldName("type");
      const base = innerTypeName(inner);
      if (!base) return null;
      return {
        relationship: Relationship.BORROWS,
        via: isMut ? "mut_ref" : "shared_ref",
        baseType: base,
        extraMeta: { is_mutable: isMut },
      };
    }
    case "pointer_type": {
      const isMut = hasMutableSpecifier(typeNode);
      const inner = typeNode.childForFieldName("type");
      const base = innerTypeName(inner);
      if (!base) return null;
      return {
        relationship: Relationship.POINTS_TO,
        via: isMut ? "raw_mut_ptr" : "raw_ptr",
        baseType: base,
        extraMeta: { is_mutable: isMut, is_raw_pointer: true },
      };
    }
    case "generic_type": {
      const typeIdent = typeNode.childForFieldName("type");
      const head = lastPathSegment(nodeText(typeIdent));
      const args = typeNode.childForFieldName("type_arguments");
      const argTypes = args ? collectTypeArgs(args) : [];
      const first = argTypes[0] ?? "";

      if (GENERIC_OWNERSHIP[head] && first) {
        const spec = GENERIC_OWNERSHIP[head]!;
        return { relationship: spec.relationship, via: spec.via, baseType: first };
      }
      if (GENERIC_OPTIONAL[head] && first) {
        return {
          relationship: Relationship.MAY_CONTAIN,
          via: GENERIC_OPTIONAL[head]!,
          baseType: first,
          extraMeta: argTypes[1] ? { error_type: argTypes[1] } : undefined,
        };
      }
      if (GENERIC_COLLECTION[head] && first) {
        return {
          relationship: Relationship.CONTAINS_MANY,
          via: GENERIC_COLLECTION[head]!,
          baseType: first,
        };
      }
      if (GENERIC_MAP[head] && argTypes.length >= 2) {
        return {
          relationship: Relationship.MAPS_K_TO_V,
          via: GENERIC_MAP[head]!,
          baseType: argTypes[1]!,
          secondaryType: argTypes[0],
          extraMeta: { key_type: argTypes[0] },
        };
      }
      // Other generic, unknown to RS-2 — treat as an embedded value
      // referencing the head type. The first generic argument is
      // surfaced in attrs only, not in the relationship.
      return {
        relationship: Relationship.EMBEDS,
        via: "generic_value",
        baseType: head,
        extraMeta: argTypes.length > 0 ? { type_arguments: argTypes } : undefined,
      };
    }
    case "array_type":
    case "slice_type": {
      const inner = typeNode.childForFieldName("element") ?? typeNode.childForFieldName("type");
      const base = innerTypeName(inner);
      if (!base) return null;
      return {
        relationship: Relationship.CONTAINS_MANY,
        via: typeNode.type === "array_type" ? "array" : "slice",
        baseType: base,
      };
    }
    case "tuple_type":
    case "function_type":
    case "primitive_type":
      return null;
    case "type_identifier":
    case "scoped_type_identifier":
    case "scoped_identifier": {
      const base = innerTypeName(typeNode);
      if (!base) return null;
      return {
        relationship: Relationship.EMBEDS,
        via: "value",
        baseType: base,
      };
    }
    default:
      return null;
  }
}

/**
 * Extract a plain leaf type name from a `type_identifier`,
 * `scoped_type_identifier`, or other simple type node. Returns the
 * trailing segment for scoped paths (`std::vec::Vec` → `Vec`).
 */
function innerTypeName(typeNode: SyntaxNode | null | undefined): string {
  if (!typeNode) return "";
  if (typeNode.type === "type_identifier") return typeNode.text;
  if (typeNode.type === "scoped_type_identifier" ||
      typeNode.type === "scoped_identifier") {
    return lastPathSegment(typeNode.text);
  }
  if (typeNode.type === "generic_type") {
    return lastPathSegment(nodeText(typeNode.childForFieldName("type")));
  }
  if (typeNode.type === "reference_type" ||
      typeNode.type === "pointer_type") {
    return innerTypeName(typeNode.childForFieldName("type"));
  }
  return "";
}

function lastPathSegment(text: string): string {
  const cleaned = text.trim();
  const idx = cleaned.lastIndexOf("::");
  return (idx >= 0 ? cleaned.slice(idx + 2) : cleaned).trim();
}

/**
 * tree-sitter-rust exposes `mutable_specifier` as an unnamed-field
 * named child on both `reference_type` and `pointer_type`. Walk the
 * direct children to detect it.
 */
function hasMutableSpecifier(node: SyntaxNode): boolean {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child && child.type === "mutable_specifier") return true;
  }
  return false;
}

function collectTypeArgs(args: SyntaxNode): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.namedChildCount; i++) {
    const child = args.namedChild(i);
    if (!child) continue;
    if (child.type === "lifetime" || child.type === "block_comment" ||
        child.type === "line_comment") continue;
    // Type arguments may themselves be reference / pointer / generic
    // nodes; for the RS-2 surface we record the inner-most type name.
    out.push(innerTypeName(child) || child.text);
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
  /** `::`-joined module path of the surrounding `mod` blocks. */
  modulePath: string;
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
// Per-node handlers (RS-1)
// ---------------------------------------------------------------------------

function handleMod(node: SyntaxNode, ctx: WalkCtx): void {
  const name = nodeText(node.childForFieldName("name"));
  if (!name) return;
  const qn = joinQn(ctx.modulePath, name);
  const id = entityId(ctx.relPath, CodeEntityKind.Module, qn);
  emitEntity(ctx, {
    id,
    kind: CodeEntityKind.Module,
    name,
    qualifiedName: qn,
    language: LANGUAGE,
    relPath: ctx.relPath,
    line: node.startPosition.row + 1,
    column: node.startPosition.column + 1,
  });
  const body = node.childForFieldName("body");
  if (!body) return; // external mod
  const childCtx: WalkCtx = { ...ctx, modulePath: qn };
  for (let i = 0; i < body.namedChildCount; i++) {
    const child = body.namedChild(i);
    if (!child) continue;
    dispatch(child, childCtx);
  }
}

function handleStruct(node: SyntaxNode, ctx: WalkCtx): void {
  const name = nodeText(node.childForFieldName("name"));
  if (!name) return;
  const qn = joinQn(ctx.modulePath, name);
  const id = entityId(ctx.relPath, CodeEntityKind.Struct, qn);
  emitEntity(ctx, {
    id,
    kind: CodeEntityKind.Struct,
    name,
    qualifiedName: qn,
    language: LANGUAGE,
    relPath: ctx.relPath,
    line: node.startPosition.row + 1,
    column: node.startPosition.column + 1,
    attrs: { module_path: ctx.modulePath },
  });

  const body = node.childForFieldName("body");
  if (!body) return; // unit struct
  if (body.type === "field_declaration_list") {
    for (let i = 0; i < body.namedChildCount; i++) {
      const child = body.namedChild(i);
      if (!child || child.type !== "field_declaration") continue;
      handleNamedField(child, ctx, qn, id);
    }
  } else if (body.type === "ordered_field_declaration_list") {
    // Tuple-struct: positional fields. Synthesise field names .0, .1, …
    let pos = 0;
    for (let i = 0; i < body.namedChildCount; i++) {
      const child = body.namedChild(i);
      if (!child) continue;
      if (child.type !== "ordered_field_declaration" &&
          child.type !== "visibility_modifier" &&
          child.type !== "attribute_item") {
        // Some grammars emit just the type node directly.
      }
      if (child.type === "ordered_field_declaration") {
        handleTupleField(child, ctx, qn, id, pos);
        pos += 1;
      }
    }
  }
}

function handleNamedField(
  node: SyntaxNode,
  ctx: WalkCtx,
  ownerQn: string,
  ownerId: string,
): void {
  const name = fieldName(node);
  if (!name) return;
  const typeNode = node.childForFieldName("type");
  const qn = `${ownerQn}.${name}`;
  const id = entityId(ctx.relPath, CodeEntityKind.Field, qn);
  emitField(ctx, id, name, qn, typeNode, node, ownerId, { owner_qualified_name: ownerQn });
}

function handleTupleField(
  node: SyntaxNode,
  ctx: WalkCtx,
  ownerQn: string,
  ownerId: string,
  pos: number,
): void {
  const typeNode = node.childForFieldName("type") ?? firstTypeChild(node);
  const name = String(pos);
  const qn = `${ownerQn}.${name}`;
  const id = entityId(ctx.relPath, CodeEntityKind.Field, qn);
  emitField(ctx, id, name, qn, typeNode, node, ownerId, { is_tuple_field: true, position: pos, owner_qualified_name: ownerQn });
}

function firstTypeChild(node: SyntaxNode): SyntaxNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (child.type === "visibility_modifier" || child.type === "attribute_item") continue;
    return child;
  }
  return null;
}

function emitField(
  ctx: WalkCtx,
  id: string,
  name: string,
  qualifiedName: string,
  typeNode: SyntaxNode | null,
  declNode: SyntaxNode,
  ownerId: string,
  extraAttrs?: Record<string, unknown>,
): void {
  const shape = classifyType(typeNode);
  emitEntity(
    ctx,
    {
      id,
      kind: CodeEntityKind.Field,
      name,
      qualifiedName,
      language: LANGUAGE,
      relPath: ctx.relPath,
      line: declNode.startPosition.row + 1,
      column: declNode.startPosition.column + 1,
      attrs: {
        type_text: nodeText(typeNode).trim(),
        base_type: shape?.baseType ?? "",
        via: shape?.via,
        ...(extraAttrs ?? {}),
      },
    },
    /* ownedByFile */ false,
  );
  ctx.edges.push({
    from: ownerId,
    to: id,
    relationship: Relationship.DECLARES_FIELD,
    evidence: evidence(declNode),
  });

  if (shape) {
    ctx.edges.push({
      from: id,
      to: `${LANGUAGE}:type:${shape.baseType}`,
      relationship: shape.relationship,
      evidence: evidence(declNode),
      meta: {
        via: shape.via,
        base_type: shape.baseType,
        resolved: false,
        ...(shape.extraMeta ?? {}),
      },
    });
    if (shape.secondaryType) {
      // K-V maps: also emit a CONTAINS_MANY-style hint for the key
      // type so explorers can reach it; the primary MAPS_K_TO_V
      // edge above is the canonical relationship.
      ctx.edges.push({
        from: id,
        to: `${LANGUAGE}:type:${shape.secondaryType}`,
        relationship: Relationship.REFERENCES_TYPE,
        evidence: evidence(declNode),
        meta: {
          via: `${shape.via}_key`,
          base_type: shape.secondaryType,
          resolved: false,
        },
      });
    }
  }
}

function handleEnum(node: SyntaxNode, ctx: WalkCtx): void {
  const name = nodeText(node.childForFieldName("name"));
  if (!name) return;
  const qn = joinQn(ctx.modulePath, name);
  const id = entityId(ctx.relPath, CodeEntityKind.Enum, qn);
  emitEntity(ctx, {
    id,
    kind: CodeEntityKind.Enum,
    name,
    qualifiedName: qn,
    language: LANGUAGE,
    relPath: ctx.relPath,
    line: node.startPosition.row + 1,
    column: node.startPosition.column + 1,
    attrs: { module_path: ctx.modulePath },
  });
  const body = node.childForFieldName("body");
  if (!body) return;
  for (let i = 0; i < body.namedChildCount; i++) {
    const child = body.namedChild(i);
    if (!child || child.type !== "enum_variant") continue;
    const vname = nodeText(child.childForFieldName("name"));
    if (!vname) continue;
    const vqn = `${qn}.${vname}`;
    const vid = entityId(ctx.relPath, CodeEntityKind.EnumMember, vqn);
    const body2 = child.childForFieldName("body");
    const shape =
      !body2 ? "unit"
      : body2.type === "ordered_field_declaration_list" ? "tuple"
      : body2.type === "field_declaration_list" ? "struct"
      : "unknown";
    emitEntity(
      ctx,
      {
        id: vid,
        kind: CodeEntityKind.EnumMember,
        name: vname,
        qualifiedName: vqn,
        language: LANGUAGE,
        relPath: ctx.relPath,
        line: child.startPosition.row + 1,
        column: child.startPosition.column + 1,
        attrs: { variant_shape: shape },
      },
      /* ownedByFile */ false,
    );
    ctx.edges.push({
      from: id,
      to: vid,
      relationship: Relationship.DECLARES_ENUM_MEMBER,
      evidence: evidence(child),
    });
  }
}

function handleTrait(node: SyntaxNode, ctx: WalkCtx): void {
  const name = nodeText(node.childForFieldName("name"));
  if (!name) return;
  const qn = joinQn(ctx.modulePath, name);
  const id = entityId(ctx.relPath, CodeEntityKind.Trait, qn);
  emitEntity(ctx, {
    id,
    kind: CodeEntityKind.Trait,
    name,
    qualifiedName: qn,
    language: LANGUAGE,
    relPath: ctx.relPath,
    line: node.startPosition.row + 1,
    column: node.startPosition.column + 1,
    attrs: { module_path: ctx.modulePath },
  });
  const body = node.childForFieldName("body");
  if (!body) return;
  for (let i = 0; i < body.namedChildCount; i++) {
    const child = body.namedChild(i);
    if (!child) continue;
    if (child.type === "function_signature_item" || child.type === "function_item") {
      handleMethodInOwner(child, ctx, qn, id, child.type === "function_item");
    }
  }
}

function handleTypeAlias(node: SyntaxNode, ctx: WalkCtx): void {
  const name = nodeText(node.childForFieldName("name"));
  if (!name) return;
  const qn = joinQn(ctx.modulePath, name);
  const id = entityId(ctx.relPath, CodeEntityKind.TypeAlias, qn);
  emitEntity(ctx, {
    id,
    kind: CodeEntityKind.TypeAlias,
    name,
    qualifiedName: qn,
    language: LANGUAGE,
    relPath: ctx.relPath,
    line: node.startPosition.row + 1,
    column: node.startPosition.column + 1,
    attrs: { aliased_text: node.text.trim() },
  });
}

function handleConstOrStatic(node: SyntaxNode, ctx: WalkCtx): void {
  const name = nodeText(node.childForFieldName("name"));
  if (!name) return;
  const qn = joinQn(ctx.modulePath, name);
  const id = entityId(ctx.relPath, CodeEntityKind.Constant, qn);
  const typeNode = node.childForFieldName("type");
  emitEntity(ctx, {
    id,
    kind: CodeEntityKind.Constant,
    name,
    qualifiedName: qn,
    language: LANGUAGE,
    relPath: ctx.relPath,
    line: node.startPosition.row + 1,
    column: node.startPosition.column + 1,
    attrs: {
      is_static: node.type === "static_item",
      type_text: nodeText(typeNode).trim(),
    },
  });
}

function handleFreeFunction(node: SyntaxNode, ctx: WalkCtx): void {
  const name = nodeText(node.childForFieldName("name"));
  if (!name) return;
  const qn = joinQn(ctx.modulePath, name);
  const id = entityId(ctx.relPath, CodeEntityKind.Function, qn);
  emitEntity(ctx, {
    id,
    kind: CodeEntityKind.Function,
    name,
    qualifiedName: qn,
    language: LANGUAGE,
    relPath: ctx.relPath,
    line: node.startPosition.row + 1,
    column: node.startPosition.column + 1,
    attrs: { is_definition: true },
  });
}

function handleUse(node: SyntaxNode, ctx: WalkCtx): void {
  // Capture the raw path text; cross-crate resolution is out of scope.
  const arg = node.childForFieldName("argument");
  const raw = nodeText(arg).trim() || node.text.replace(/^use\s+/, "").replace(/;$/, "").trim();
  if (!raw) return;
  ctx.edges.push({
    from: ctx.fileEntityId,
    to: `${LANGUAGE}:use:${raw}`,
    relationship: Relationship.IMPORTS,
    evidence: evidence(node),
    meta: { path: raw },
  });
}

// ---------------------------------------------------------------------------
// RS-3: impl blocks
// ---------------------------------------------------------------------------

function handleImpl(node: SyntaxNode, ctx: WalkCtx): void {
  // `impl_item` exposes a `type` field (the Self type) and an optional
  // `trait` field (the implemented trait). The grammar also supports
  // generic parameters via `type_parameters` — we ignore those for RS-3.
  const selfType = node.childForFieldName("type");
  const traitType = node.childForFieldName("trait");
  const selfName = innerTypeName(selfType);
  if (!selfName) return;
  const selfQn = joinQn(ctx.modulePath, selfName);

  if (traitType) {
    const traitName = innerTypeName(traitType);
    if (traitName) {
      // Emit IMPLEMENTS_TRAIT from the Self type to a `rust:type:Trait`
      // placeholder. The orchestrator resolves it like any other
      // type-target placeholder, so a Trait defined in a different
      // file binds automatically.
      ctx.edges.push({
        from: entityId(ctx.relPath, CodeEntityKind.Struct, selfQn),
        to: `${LANGUAGE}:type:${traitName}`,
        relationship: Relationship.IMPLEMENTS_TRAIT,
        evidence: evidence(node),
        meta: {
          via: "trait_impl",
          base_type: traitName,
          self_type: selfName,
          resolved: false,
        },
      });
    }
  }

  const body = node.childForFieldName("body");
  if (!body) return;
  for (let i = 0; i < body.namedChildCount; i++) {
    const child = body.namedChild(i);
    if (!child) continue;
    if (child.type === "function_item") {
      handleMethodInOwner(child, ctx, selfQn, /* ownerId */ null, /* isDefinition */ true);
    } else if (child.type === "const_item" || child.type === "static_item") {
      handleAssociatedConst(child, ctx, selfQn);
    } else if (child.type === "type_item") {
      handleAssociatedTypeAlias(child, ctx, selfQn);
    }
  }
}

function handleMethodInOwner(
  node: SyntaxNode,
  ctx: WalkCtx,
  ownerQn: string,
  ownerId: string | null,
  isDefinition: boolean,
): void {
  const name = nodeText(node.childForFieldName("name"));
  if (!name) return;
  const qn = `${ownerQn}::${name}`;
  // Include the line in the id so overloads / same-name methods on
  // different impl blocks don't collide. Rust forbids overloads but
  // a trait impl + an inherent impl can each contribute a `fn new`.
  const id = `${entityId(ctx.relPath, CodeEntityKind.Method, qn)}@${node.startPosition.row + 1}`;
  emitEntity(ctx, {
    id,
    kind: CodeEntityKind.Method,
    name,
    qualifiedName: qn,
    language: LANGUAGE,
    relPath: ctx.relPath,
    line: node.startPosition.row + 1,
    column: node.startPosition.column + 1,
    attrs: { is_definition: isDefinition, owner_qualified_name: ownerQn },
  });
  if (ownerId) {
    ctx.edges.push({
      from: ownerId,
      to: id,
      relationship: Relationship.DECLARES_METHOD,
      evidence: evidence(node),
    });
  }
}

function handleAssociatedConst(node: SyntaxNode, ctx: WalkCtx, ownerQn: string): void {
  const name = nodeText(node.childForFieldName("name"));
  if (!name) return;
  const qn = `${ownerQn}::${name}`;
  const id = entityId(ctx.relPath, CodeEntityKind.Constant, qn);
  emitEntity(ctx, {
    id,
    kind: CodeEntityKind.Constant,
    name,
    qualifiedName: qn,
    language: LANGUAGE,
    relPath: ctx.relPath,
    line: node.startPosition.row + 1,
    column: node.startPosition.column + 1,
    attrs: {
      is_static: node.type === "static_item",
      is_associated: true,
      owner_qualified_name: ownerQn,
      type_text: nodeText(node.childForFieldName("type")).trim(),
    },
  });
}

function handleAssociatedTypeAlias(node: SyntaxNode, ctx: WalkCtx, ownerQn: string): void {
  const name = nodeText(node.childForFieldName("name"));
  if (!name) return;
  const qn = `${ownerQn}::${name}`;
  const id = entityId(ctx.relPath, CodeEntityKind.TypeAlias, qn);
  emitEntity(ctx, {
    id,
    kind: CodeEntityKind.TypeAlias,
    name,
    qualifiedName: qn,
    language: LANGUAGE,
    relPath: ctx.relPath,
    line: node.startPosition.row + 1,
    column: node.startPosition.column + 1,
    attrs: { is_associated: true, owner_qualified_name: ownerQn, aliased_text: node.text.trim() },
  });
}

// ---------------------------------------------------------------------------
// Top-level dispatch
// ---------------------------------------------------------------------------

function dispatch(node: SyntaxNode, ctx: WalkCtx): void {
  switch (node.type) {
    case "mod_item":           handleMod(node, ctx); break;
    case "struct_item":        handleStruct(node, ctx); break;
    case "enum_item":          handleEnum(node, ctx); break;
    case "trait_item":         handleTrait(node, ctx); break;
    case "type_item":          handleTypeAlias(node, ctx); break;
    case "const_item":
    case "static_item":        handleConstOrStatic(node, ctx); break;
    case "function_item":      handleFreeFunction(node, ctx); break;
    case "use_declaration":    handleUse(node, ctx); break;
    case "impl_item":          handleImpl(node, ctx); break;
    case "foreign_mod_item": {
      // `extern "C" { ... }` — recurse to surface declared items
      // (function signatures, statics) as ordinary entities.
      const body = node.childForFieldName("body");
      if (body) {
        for (let i = 0; i < body.namedChildCount; i++) {
          const child = body.namedChild(i);
          if (child) dispatch(child, ctx);
        }
      }
      break;
    }
    default:
      // Other top-level node kinds (attribute_item, macro_invocation,
      // …) are not yet in scope.
      break;
  }
}

function walk(root: SyntaxNode, ctx: WalkCtx): void {
  for (let i = 0; i < root.namedChildCount; i++) {
    const child = root.namedChild(i);
    if (!child) continue;
    dispatch(child, ctx);
  }
}

// ---------------------------------------------------------------------------
// Extractor
// ---------------------------------------------------------------------------

export const rustExtractor: Extractor = {
  name: NAME,
  version: VERSION,
  extensions: EXTENSIONS,
  parserBacked: true,
  async extract(file: ExtractFileInput): Promise<ExtractorOutput> {
    const parser = await getParser("rust");
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
      modulePath: "",
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
