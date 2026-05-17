/**
 * DreamGraph — Java language extractor (wave 2, phases JV-1..JV-3).
 *
 * JV-1: top-level items.
 *   - `package` declaration → Package entity (`com.example.foo`).
 *     Subsequent type qualifiedNames are prefixed with the package.
 *   - `class` / `interface` / `record` / `enum` / `@interface`
 *     declarations → Class / Interface / Record / Enum / Annotation
 *     entities. Nested types push their owner's qualifiedName as a
 *     `.`-joined prefix.
 *   - `import` declarations → IMPORTS edges from the file entity to
 *     `java:type:Foo` (or `java:use:foo.bar.*` for wildcards).
 *
 * JV-2: members and shapes.
 *   - Field declarations → Field entities + DECLARES_FIELD. The field's
 *     type is classified into a language-agnostic shape:
 *       - `List<T>`, `Set<T>`, `Collection<T>`, `Iterable<T>`,
 *         `Queue<T>`, `Deque<T>` → CONTAINS_MANY via "list"/"set"/...
 *       - `Map<K,V>`               → MAPS_K_TO_V via "map" (+ key_type)
 *       - `Optional<T>`            → MAY_CONTAIN via "optional"
 *       - `T[]`                    → CONTAINS_MANY via "array"
 *       - plain user types         → EMBEDS via "value"
 *   - Method declarations → Method entities (attrs.is_definition=true
 *     when a body is present, false for interface abstract methods).
 *   - Constructor declarations → Constructor entities.
 *   - `static final` fields → Constant entities (in addition to Field).
 *
 * JV-3: inheritance and annotations.
 *   - `class Foo extends Bar` → EXTENDS edge to `java:type:Bar`.
 *   - `class Foo implements I1, I2` → IMPLEMENTS edges per interface.
 *   - `interface Foo extends I1, I2` → EXTENDS edges per super-interface.
 *   - `@Annotation` on a type/method/field → HAS_ANNOTATION edge to
 *     `java:type:Annotation` so framework surfaces (Spring controllers,
 *     JPA entities, JUnit tests, …) become first-class graph edges.
 *
 * The same canonical `CodeEntityKind` + `Relationship` vocabulary used
 * by the C / C++ / Rust extractors is reused here. Language-specific
 * construct labels (`"list"`, `"optional"`, …) only ever live in
 * `edge.meta.via`. See user rule on language-agnostic kinds.
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

const NAME = "java";
const VERSION = "0.1.0";
const LANGUAGE = "java";
const EXTENSIONS: readonly string[] = [".java"];

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

function joinTypeQn(prefix: string, name: string): string {
  return prefix ? `${prefix}.${name}` : name;
}

function namedFieldText(node: SyntaxNode, fieldName: string): string {
  const child = node.childForFieldName(fieldName);
  return child ? child.text : "";
}

// ---------------------------------------------------------------------------
// Type-shape classification (JV-2)
// ---------------------------------------------------------------------------

interface TypeShape {
  relationship: typeof Relationship[keyof typeof Relationship];
  via: string;
  baseType: string;
  secondaryType?: string;
  extraMeta?: Record<string, unknown>;
}

/** java.util collection types we recognise as CONTAINS_MANY. */
const GENERIC_COLLECTION: Record<string, string> = {
  List: "list",
  ArrayList: "arraylist",
  LinkedList: "linkedlist",
  Set: "set",
  HashSet: "hashset",
  LinkedHashSet: "linkedhashset",
  TreeSet: "treeset",
  Collection: "collection",
  Iterable: "iterable",
  Queue: "queue",
  Deque: "deque",
  ArrayDeque: "arraydeque",
  Stack: "stack",
  Vector: "vector",
};

/** Map types → MAPS_K_TO_V. */
const GENERIC_MAP: Record<string, string> = {
  Map: "map",
  HashMap: "hashmap",
  LinkedHashMap: "linkedhashmap",
  TreeMap: "treemap",
  ConcurrentHashMap: "concurrenthashmap",
  WeakHashMap: "weakhashmap",
};

/** Optional-like types → MAY_CONTAIN. */
const GENERIC_OPTIONAL: Record<string, string> = {
  Optional: "optional",
  OptionalInt: "optional",
  OptionalLong: "optional",
  OptionalDouble: "optional",
};

/**
 * Inspect a Java type node and decide which relationship + via label it
 * represents. Returns `null` for primitives and unrecognised constructs;
 * the caller still records the raw `type_text` on the Field entity.
 */
function classifyType(typeNode: SyntaxNode | null): TypeShape | null {
  if (!typeNode) return null;
  switch (typeNode.type) {
    case "array_type": {
      const element = typeNode.childForFieldName("element");
      const base = innerTypeName(element);
      if (!base) return null;
      return {
        relationship: Relationship.CONTAINS_MANY,
        via: "array",
        baseType: base,
      };
    }
    case "generic_type": {
      // tree-sitter-java models `Foo<Bar,Baz>` as a `generic_type`
      // whose first named child is the head type (`type_identifier`
      // / `scoped_type_identifier`) and whose last named child is a
      // `type_arguments` node.
      const head = innerTypeName(firstNamedChildOfKind(
        typeNode,
        new Set(["type_identifier", "scoped_type_identifier"]),
      ));
      const args = lastNamedChildOfKind(typeNode, new Set(["type_arguments"]));
      const argTypes = args ? collectTypeArgs(args) : [];
      const first = argTypes[0] ?? "";

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
      if (GENERIC_OPTIONAL[head]) {
        return {
          relationship: Relationship.MAY_CONTAIN,
          via: GENERIC_OPTIONAL[head]!,
          baseType: first || head,
        };
      }
      return {
        relationship: Relationship.EMBEDS,
        via: "generic_value",
        baseType: head,
        extraMeta: argTypes.length > 0 ? { type_arguments: argTypes } : undefined,
      };
    }
    case "type_identifier":
    case "scoped_type_identifier": {
      const base = innerTypeName(typeNode);
      if (!base) return null;
      return {
        relationship: Relationship.EMBEDS,
        via: "value",
        baseType: base,
      };
    }
    case "integral_type":
    case "floating_point_type":
    case "boolean_type":
    case "void_type":
      return null;
    default:
      return null;
  }
}

function innerTypeName(typeNode: SyntaxNode | null | undefined): string {
  if (!typeNode) return "";
  if (typeNode.type === "type_identifier") return typeNode.text;
  if (typeNode.type === "scoped_type_identifier") {
    return lastDotSegment(typeNode.text);
  }
  if (typeNode.type === "generic_type") {
    const head = firstNamedChildOfKind(
      typeNode,
      new Set(["type_identifier", "scoped_type_identifier"]),
    );
    return innerTypeName(head);
  }
  if (typeNode.type === "array_type") {
    return innerTypeName(typeNode.childForFieldName("element"));
  }
  return "";
}

function lastDotSegment(text: string): string {
  const cleaned = text.trim();
  const idx = cleaned.lastIndexOf(".");
  return (idx >= 0 ? cleaned.slice(idx + 1) : cleaned).trim();
}

function firstNamedChildOfKind(
  node: SyntaxNode,
  kinds: ReadonlySet<string>,
): SyntaxNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child && kinds.has(child.type)) return child;
  }
  return null;
}

function lastNamedChildOfKind(
  node: SyntaxNode,
  kinds: ReadonlySet<string>,
): SyntaxNode | null {
  for (let i = node.namedChildCount - 1; i >= 0; i--) {
    const child = node.namedChild(i);
    if (child && kinds.has(child.type)) return child;
  }
  return null;
}

function collectTypeArgs(args: SyntaxNode): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.namedChildCount; i++) {
    const child = args.namedChild(i);
    if (!child) continue;
    if (child.type === "wildcard") {
      // Surface as the upper bound if present, otherwise "?".
      const bound = child.namedChild(0);
      out.push(bound ? (innerTypeName(bound) || bound.text) : "?");
      continue;
    }
    if (child.type === "line_comment" || child.type === "block_comment") continue;
    out.push(innerTypeName(child) || child.text);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Modifiers + annotations
// ---------------------------------------------------------------------------

interface ModifierInfo {
  isStatic: boolean;
  isFinal: boolean;
  isAbstract: boolean;
  annotations: Array<{ name: string; node: SyntaxNode }>;
}

function readModifiers(node: SyntaxNode): ModifierInfo {
  const info: ModifierInfo = {
    isStatic: false,
    isFinal: false,
    isAbstract: false,
    annotations: [],
  };
  // tree-sitter-java places modifiers (annotations + keyword tokens)
  // either inside a `modifiers` wrapper node OR as direct children of
  // the declaration depending on grammar version. Walk both surfaces.
  const visit = (n: SyntaxNode): void => {
    for (let i = 0; i < n.namedChildCount; i++) {
      const m = n.namedChild(i);
      if (!m) continue;
      if (m.type === "annotation" || m.type === "marker_annotation") {
        const nameNode = m.childForFieldName("name");
        const name = nameNode ? lastDotSegment(nameNode.text) : "";
        if (name) info.annotations.push({ name, node: m });
      }
    }
    // Keyword modifiers (`static`, `final`, `abstract`, …) may be
    // anonymous tokens; scan all children, not just named.
    for (let i = 0; i < n.childCount; i++) {
      const m = n.child(i);
      if (!m) continue;
      switch (m.type) {
        case "static":   info.isStatic = true; break;
        case "final":    info.isFinal = true; break;
        case "abstract": info.isAbstract = true; break;
      }
    }
  };
  // First, look for a `modifiers` wrapper.
  let foundWrapper = false;
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child && child.type === "modifiers") {
      foundWrapper = true;
      visit(child);
    }
  }
  // Some grammars hang annotations + keywords directly off the decl.
  if (!foundWrapper) {
    visit(node);
  }
  return info;
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
// Package + imports (JV-1)
// ---------------------------------------------------------------------------

function handlePackage(node: SyntaxNode, ctx: WalkCtx): void {
  // tree-sitter-java: `package_declaration` has the dotted name as a
  // single `scoped_identifier` / `identifier` child.
  const inner = node.namedChild(0);
  const name = nodeText(inner).trim();
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
  // `import_declaration` wraps a `scoped_identifier` and optional
  // `*` for on-demand imports.
  const text = node.text.replace(/^import\s+/, "").replace(/;\s*$/, "").trim();
  if (!text) return;
  const isWildcard = text.endsWith(".*");
  const targetName = isWildcard ? text : lastDotSegment(text);
  const targetSlot = isWildcard ? "use" : "type";
  ctx.edges.push({
    from: ctx.fileEntityId,
    to: `${LANGUAGE}:${targetSlot}:${targetName}`,
    relationship: Relationship.IMPORTS,
    evidence: evidence(node),
    meta: {
      path: text,
      wildcard: isWildcard,
      is_static: /^import\s+static\b/.test(node.text),
    },
  });
}

// ---------------------------------------------------------------------------
// Type declarations (JV-1 + JV-3)
// ---------------------------------------------------------------------------

interface TypeDeclShape {
  kind: typeof CodeEntityKind[keyof typeof CodeEntityKind];
  /** For `interface` declarations the `extends` clause is *interface* inheritance, modelled as EXTENDS. */
  extendsIsInterface: boolean;
}

const TYPE_DECL_KINDS: Record<string, TypeDeclShape> = {
  class_declaration: { kind: CodeEntityKind.Class, extendsIsInterface: false },
  record_declaration: { kind: CodeEntityKind.Record, extendsIsInterface: false },
  interface_declaration: { kind: CodeEntityKind.Interface, extendsIsInterface: true },
  enum_declaration: { kind: CodeEntityKind.Enum, extendsIsInterface: false },
  annotation_type_declaration: { kind: CodeEntityKind.Annotation, extendsIsInterface: false },
};

/** Wrapper node types that hold the superclass type. */
const SUPERCLASS_WRAPPERS = new Set(["superclass"]);
/** Wrapper node types that hold an implements-list / super-interfaces list. */
const INTERFACES_WRAPPERS = new Set([
  "super_interfaces",
  "interfaces",
  "extends_interfaces",
]);

function handleTypeDecl(node: SyntaxNode, ctx: WalkCtx): void {
  const shape = TYPE_DECL_KINDS[node.type];
  if (!shape) return;
  const name = namedFieldText(node, "name");
  if (!name) return;
  const qn = joinTypeQn(ctx.typePrefix, name);
  const id = entityId(ctx.relPath, shape.kind, qn);
  const mods = readModifiers(node);
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
      is_abstract: mods.isAbstract,
      is_static: mods.isStatic,
      is_final: mods.isFinal,
    },
  });
  emitAnnotationEdges(ctx, id, mods.annotations);

  // Scan namedChildren for inheritance-related wrapper nodes by type,
  // so grammar drift around field names doesn't silently drop edges.
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (SUPERCLASS_WRAPPERS.has(child.type)) {
      emitExtendsFromContainer(ctx, id, child, "class_extends");
    } else if (INTERFACES_WRAPPERS.has(child.type)) {
      const rel = shape.extendsIsInterface
        ? Relationship.EXTENDS
        : Relationship.IMPLEMENTS;
      const via = shape.extendsIsInterface ? "interface_extends" : "interface_impl";
      emitInheritanceFromContainer(ctx, id, child, rel, via);
    }
  }

  // Recurse into the body.
  const body = node.childForFieldName("body");
  if (!body) return;
  const childCtx: WalkCtx = { ...ctx, typePrefix: qn };
  for (let i = 0; i < body.namedChildCount; i++) {
    const child = body.namedChild(i);
    if (!child) continue;
    dispatch(child, childCtx, /* ownerId */ id, /* ownerQn */ qn);
  }
}

function emitExtendsFromContainer(
  ctx: WalkCtx,
  fromId: string,
  containerNode: SyntaxNode,
  via: string,
): void {
  // `superclass` may be the `superclass` node itself (which wraps the
  // `extends` keyword + type) or directly a type node. Find the first
  // type-like named child.
  const target = firstTypeLikeChild(containerNode);
  if (!target) return;
  const baseType = innerTypeName(target);
  if (!baseType) return;
  ctx.edges.push({
    from: fromId,
    to: `${LANGUAGE}:type:${baseType}`,
    relationship: Relationship.EXTENDS,
    evidence: evidence(containerNode),
    meta: { via, base_type: baseType, resolved: false },
  });
}

function emitInheritanceFromContainer(
  ctx: WalkCtx,
  fromId: string,
  containerNode: SyntaxNode,
  relationship: typeof Relationship[keyof typeof Relationship],
  via: string,
): void {
  // `interfaces` is `super_interfaces` → `type_list` → [type, type, ...].
  // `extends` on an interface_declaration is `extends_interfaces` →
  // `type_list` → [type, type, ...]. Walk down past wrapper nodes
  // until we find type-like children.
  const types = collectTypeList(containerNode);
  for (const t of types) {
    const baseType = innerTypeName(t);
    if (!baseType) continue;
    ctx.edges.push({
      from: fromId,
      to: `${LANGUAGE}:type:${baseType}`,
      relationship,
      evidence: evidence(t),
      meta: { via, base_type: baseType, resolved: false },
    });
  }
}

function firstTypeLikeChild(node: SyntaxNode): SyntaxNode | null {
  const typeKinds = new Set([
    "type_identifier",
    "scoped_type_identifier",
    "generic_type",
  ]);
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (typeKinds.has(child.type)) return child;
    // Descend into wrapper nodes (`superclass`, `type_list`, …).
    const inner = firstTypeLikeChild(child);
    if (inner) return inner;
  }
  return null;
}

function collectTypeList(node: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  const typeKinds = new Set([
    "type_identifier",
    "scoped_type_identifier",
    "generic_type",
  ]);
  const visit = (n: SyntaxNode): void => {
    for (let i = 0; i < n.namedChildCount; i++) {
      const child = n.namedChild(i);
      if (!child) continue;
      if (typeKinds.has(child.type)) {
        out.push(child);
      } else {
        visit(child);
      }
    }
  };
  visit(node);
  return out;
}

// ---------------------------------------------------------------------------
// Body members (JV-2)
// ---------------------------------------------------------------------------

function handleFieldDecl(
  node: SyntaxNode,
  ctx: WalkCtx,
  ownerId: string,
  ownerQn: string,
): void {
  const typeNode = node.childForFieldName("type");
  const mods = readModifiers(node);
  // A single `field_declaration` may declare multiple variables:
  //   `private final List<String> a, b = ...;`
  // Each `variable_declarator` becomes its own Field entity, but the
  // type + modifiers are shared.
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child || child.type !== "variable_declarator") continue;
    const name = namedFieldText(child, "name");
    if (!name) continue;
    const qn = `${ownerQn}.${name}`;
    const id = entityId(ctx.relPath, CodeEntityKind.Field, qn);
    const shape = classifyType(typeNode);
    emitEntity(
      ctx,
      {
        id,
        kind: CodeEntityKind.Field,
        name,
        qualifiedName: qn,
        language: LANGUAGE,
        relPath: ctx.relPath,
        line: child.startPosition.row + 1,
        column: child.startPosition.column + 1,
        attrs: {
          type_text: nodeText(typeNode).trim(),
          base_type: shape?.baseType ?? "",
          via: shape?.via,
          is_static: mods.isStatic,
          is_final: mods.isFinal,
          owner_qualified_name: ownerQn,
        },
      },
      /* ownedByFile */ false,
    );
    ctx.edges.push({
      from: ownerId,
      to: id,
      relationship: Relationship.DECLARES_FIELD,
      evidence: evidence(child),
    });
    emitAnnotationEdges(ctx, id, mods.annotations);

    if (shape) {
      ctx.edges.push({
        from: id,
        to: `${LANGUAGE}:type:${shape.baseType}`,
        relationship: shape.relationship,
        evidence: evidence(child),
        meta: {
          via: shape.via,
          base_type: shape.baseType,
          resolved: false,
          ...(shape.extraMeta ?? {}),
        },
      });
      if (shape.secondaryType) {
        ctx.edges.push({
          from: id,
          to: `${LANGUAGE}:type:${shape.secondaryType}`,
          relationship: Relationship.REFERENCES_TYPE,
          evidence: evidence(child),
          meta: {
            via: `${shape.via}_key`,
            base_type: shape.secondaryType,
            resolved: false,
          },
        });
      }
    }

    // `static final` constants also surface as Constant entities so
    // they show up in language-agnostic constant searches.
    if (mods.isStatic && mods.isFinal) {
      const cid = entityId(ctx.relPath, CodeEntityKind.Constant, qn);
      emitEntity(
        ctx,
        {
          id: cid,
          kind: CodeEntityKind.Constant,
          name,
          qualifiedName: qn,
          language: LANGUAGE,
          relPath: ctx.relPath,
          line: child.startPosition.row + 1,
          column: child.startPosition.column + 1,
          attrs: {
            is_static: true,
            is_final: true,
            owner_qualified_name: ownerQn,
            type_text: nodeText(typeNode).trim(),
          },
        },
        /* ownedByFile */ false,
      );
    }
  }
}

function handleMethodDecl(
  node: SyntaxNode,
  ctx: WalkCtx,
  ownerId: string,
  ownerQn: string,
): void {
  const name = namedFieldText(node, "name");
  if (!name) return;
  const qn = `${ownerQn}.${name}`;
  // Append line to disambiguate overloads.
  const id = `${entityId(ctx.relPath, CodeEntityKind.Method, qn)}@${node.startPosition.row + 1}`;
  const mods = readModifiers(node);
  const body = node.childForFieldName("body");
  emitEntity(ctx, {
    id,
    kind: CodeEntityKind.Method,
    name,
    qualifiedName: qn,
    language: LANGUAGE,
    relPath: ctx.relPath,
    line: node.startPosition.row + 1,
    column: node.startPosition.column + 1,
    attrs: {
      is_definition: !!body,
      is_abstract: mods.isAbstract,
      is_static: mods.isStatic,
      is_final: mods.isFinal,
      owner_qualified_name: ownerQn,
      return_type_text: nodeText(node.childForFieldName("type")).trim(),
    },
  });
  ctx.edges.push({
    from: ownerId,
    to: id,
    relationship: Relationship.DECLARES_METHOD,
    evidence: evidence(node),
  });
  emitAnnotationEdges(ctx, id, mods.annotations);
}

function handleConstructorDecl(
  node: SyntaxNode,
  ctx: WalkCtx,
  ownerId: string,
  ownerQn: string,
): void {
  const name = namedFieldText(node, "name");
  if (!name) return;
  const qn = `${ownerQn}.${name}`;
  const id = `${entityId(ctx.relPath, CodeEntityKind.Constructor, qn)}@${node.startPosition.row + 1}`;
  const mods = readModifiers(node);
  emitEntity(ctx, {
    id,
    kind: CodeEntityKind.Constructor,
    name,
    qualifiedName: qn,
    language: LANGUAGE,
    relPath: ctx.relPath,
    line: node.startPosition.row + 1,
    column: node.startPosition.column + 1,
    attrs: {
      owner_qualified_name: ownerQn,
      is_definition: true,
    },
  });
  ctx.edges.push({
    from: ownerId,
    to: id,
    relationship: Relationship.DECLARES_METHOD,
    evidence: evidence(node),
  });
  emitAnnotationEdges(ctx, id, mods.annotations);
}

function handleEnumConstant(
  node: SyntaxNode,
  ctx: WalkCtx,
  ownerId: string,
  ownerQn: string,
): void {
  const name = namedFieldText(node, "name");
  if (!name) return;
  const qn = `${ownerQn}.${name}`;
  const id = entityId(ctx.relPath, CodeEntityKind.EnumMember, qn);
  emitEntity(
    ctx,
    {
      id,
      kind: CodeEntityKind.EnumMember,
      name,
      qualifiedName: qn,
      language: LANGUAGE,
      relPath: ctx.relPath,
      line: node.startPosition.row + 1,
      column: node.startPosition.column + 1,
      attrs: { owner_qualified_name: ownerQn },
    },
    /* ownedByFile */ false,
  );
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
    case "package_declaration":
      handlePackage(node, ctx);
      return;
    case "import_declaration":
      handleImport(node, ctx);
      return;
    case "class_declaration":
    case "record_declaration":
    case "interface_declaration":
    case "enum_declaration":
    case "annotation_type_declaration":
      handleTypeDecl(node, ctx);
      return;
    case "field_declaration":
      if (ownerId) handleFieldDecl(node, ctx, ownerId, ownerQn);
      return;
    case "method_declaration":
      if (ownerId) handleMethodDecl(node, ctx, ownerId, ownerQn);
      return;
    case "constructor_declaration":
      if (ownerId) handleConstructorDecl(node, ctx, ownerId, ownerQn);
      return;
    case "enum_constant":
      if (ownerId) handleEnumConstant(node, ctx, ownerId, ownerQn);
      return;
    case "enum_body_declarations": {
      // The block of class-body declarations inside an `enum { A, B; ... }`.
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child) dispatch(child, ctx, ownerId, ownerQn);
      }
      return;
    }
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

export const javaExtractor: Extractor = {
  name: NAME,
  version: VERSION,
  extensions: EXTENSIONS,
  parserBacked: true,
  async extract(file: ExtractFileInput): Promise<ExtractorOutput> {
    const parser = await getParser("java");
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
