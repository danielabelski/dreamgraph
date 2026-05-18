/**
 * DreamGraph — Go language extractor (wave 5, phases GO-1..GO-3).
 *
 * GO-1: file structure + top-level declarations.
 *   - `package_clause` → Module entity. The package identifier is the
 *     module qn; every top-level declaration is qualified under it.
 *   - `import_declaration` → IMPORTS edges from the file entity. Three
 *     spec forms recognised:
 *       * `import "fmt"`                 → `go:use:fmt`
 *       * `import myio "io"`             → `go:use:io` + meta.alias
 *       * `import . "errors"`            → `go:use:errors` + meta.dot
 *       * `import _ "side/effects"`      → `go:use:...` + meta.blank
 *     Factored imports (`import ( ... )`) and single imports are both
 *     normalised through `import_spec`.
 *   - `type_declaration` carries one or more `type_spec` (regular
 *     defined type) or `type_alias` (the `= T` form). The type's RHS
 *     decides the entity kind:
 *       * `struct_type`      → Struct
 *       * `interface_type`   → Interface
 *       * `function_type`    → TypeAlias (`attrs.delegate = true`)
 *       * any other type RHS in a `type_alias` → TypeAlias
 *         (`attrs.is_alias = true`)
 *       * any other type RHS in a `type_spec`  → TypeAlias
 *         (`attrs.is_defined_type = true`) — Go's "defined type" is
 *         distinct from an alias: it creates a new named type. We
 *         surface it as TypeAlias for cross-language consistency and
 *         disambiguate via the attr.
 *   - `function_declaration` → Function (package-scoped).
 *   - `method_declaration` → Method. Owner qn is derived from the
 *     receiver type (stripping `*`). `attrs.pointer_receiver = true`
 *     when the receiver is a pointer type.
 *   - `const_declaration` / `var_declaration` → Constant / Field at
 *     module scope. Const-grouped specs (`const ( A = 1; B = 2 )`)
 *     expand to one entity per name.
 *
 * GO-2: struct fields, interface members, type shapes.
 *   - `field_declaration` inside a `struct_type` → Field, with the
 *     owner's qualified name carried on `attrs.owner_qualified_name`.
 *     Two shapes:
 *       * `name type`  → named field. Tag literal (when present) is
 *         parsed into `attrs.tags` (key→value map).
 *       * `type` only  → embedded (promoted) field. `attrs.is_embedded
 *         = true`, field name = the embedded type's short name. When
 *         the embedded type is a pointer (`*Foo`), `attrs.pointer
 *         = true`. We additionally emit an EMBEDS edge to the embedded
 *         type so promoted-method lookups become traceable in the graph.
 *   - `method_spec` inside an `interface_type` → Method. Each method
 *     records parameter types via `attrs.parameter_types` and
 *     `attrs.return_types`.
 *   - `constraint_elem` containing a `type_identifier` /
 *     `qualified_type` → EXTENDS edge from the interface to the
 *     embedded interface (Go's interface embedding).
 *
 *   Type-shape classification on a field's declared type (Go is
 *   statically typed; classifications carry High confidence and no
 *   helmet caveat — `meta.from_annotation` is still recorded for
 *   ontology parity with other languages):
 *     - `*T`                 → REFERENCES_TYPE, meta.pointer = true
 *     - `[]T`                → CONTAINS_MANY via "slice"
 *     - `[N]T`               → CONTAINS_MANY via "array"
 *     - `map[K]V`            → MAPS_K_TO_V via "map", meta.key_type = K
 *     - `chan T` / `<-chan T` / `chan<- T`
 *                            → EMBEDS via "channel" + meta.direction
 *     - `func(...) ...`      → EMBEDS via "function_value"
 *     - bare `T` / `pkg.T`   → EMBEDS via "value"
 *     - inline `struct {...}` / `interface {...}`
 *                            → EMBEDS via "struct_value" / "interface_value"
 *
 * GO-3: identifier resolution + edge ontology.
 *   - Every Field / Method / Function entity carries
 *     `attrs.owner_qualified_name` (the package qn for top-level
 *     declarations, the receiver/type qn for members). The bridge's
 *     `indexEntities` uses this to bucket members under their owning
 *     type without parsing the qualified name string.
 *   - Every type-targeting edge sets `meta.base_type` + `meta.resolved
 *     : false` so the orchestrator's `resolvePointerTarget` can rewrite
 *     placeholders (`go:type:User`) to concrete entity ids once the
 *     project link pass has run.
 *   - Go has no source-level annotations; HAS_ANNOTATION edges are not
 *     emitted by this extractor. Struct field tags are stored as data
 *     on the Field (`attrs.tags`) rather than as a separate edge: tags
 *     are metadata to other tools (json, db, validator) but not
 *     architectural relationships in their own right.
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

const NAME = "go";
const VERSION = "0.1.0";
const LANGUAGE = "go";
const EXTENSIONS: readonly string[] = [".go"];

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

function unquote(literalText: string): string {
  const t = literalText.trim();
  if (t.length >= 2) {
    const first = t.charAt(0);
    const last = t.charAt(t.length - 1);
    if ((first === "\"" || first === "`") && first === last) {
      return t.slice(1, -1);
    }
  }
  return t;
}

// ---------------------------------------------------------------------------
// Module identity
// ---------------------------------------------------------------------------

function derivePackageName(root: SyntaxNode): string {
  for (let i = 0; i < root.namedChildCount; i++) {
    const c = root.namedChild(i);
    if (c && c.type === "package_clause") {
      const id = namedChildOfKind(c, new Set(["package_identifier"]));
      if (id) return id.text.trim();
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// Type-shape vocabulary
// ---------------------------------------------------------------------------

interface TypeShape {
  /** Base type's short name (last `.`-segment for qualified types). */
  baseType: string;
  /** Raw textual form of the type expression. */
  rawText: string;
  /** True if expression begins with `*`. */
  pointer: boolean;
  /** "slice" | "array" | "map" | "channel" | "function" | "value"
   *  | "struct_value" | "interface_value" | "" (unknown). */
  shape: string;
  /** For maps: key base-type short name. */
  keyType?: string;
  /** For channels: "send" | "recv" | "both". */
  channelDirection?: string;
}

function classifyType(typeNode: SyntaxNode | null): TypeShape | null {
  if (!typeNode) return null;
  const raw = typeNode.text.trim();
  switch (typeNode.type) {
    case "type_identifier":
      return { baseType: typeNode.text.trim(), rawText: raw, pointer: false, shape: "value" };
    case "qualified_type": {
      const nameNode = typeNode.childForFieldName("name");
      const base = nameNode ? nameNode.text.trim() : lastDotSegment(typeNode.text);
      return { baseType: base, rawText: raw, pointer: false, shape: "value" };
    }
    case "pointer_type": {
      const inner = typeNode.namedChild(0);
      const sub = classifyType(inner);
      if (!sub) return { baseType: "", rawText: raw, pointer: true, shape: "" };
      return { ...sub, pointer: true, rawText: raw };
    }
    case "slice_type": {
      const el = typeNode.childForFieldName("element") ?? typeNode.namedChild(0);
      const sub = classifyType(el);
      return {
        baseType: sub?.baseType ?? "",
        rawText: raw,
        pointer: false,
        shape: "slice",
      };
    }
    case "array_type": {
      const el = typeNode.childForFieldName("element") ?? typeNode.namedChild(typeNode.namedChildCount - 1);
      const sub = classifyType(el);
      return {
        baseType: sub?.baseType ?? "",
        rawText: raw,
        pointer: false,
        shape: "array",
      };
    }
    case "map_type": {
      const k = typeNode.childForFieldName("key");
      const v = typeNode.childForFieldName("value");
      const keyShape = classifyType(k);
      const valShape = classifyType(v);
      return {
        baseType: valShape?.baseType ?? "",
        rawText: raw,
        pointer: false,
        shape: "map",
        keyType: keyShape?.baseType ?? "",
      };
    }
    case "channel_type": {
      const v = typeNode.childForFieldName("value") ?? typeNode.namedChild(0);
      const sub = classifyType(v);
      // Channel direction is encoded by anonymous `<-` tokens around `chan`.
      let dir = "both";
      const txt = raw;
      if (txt.startsWith("<-chan")) dir = "recv";
      else if (/^chan\s*<-/.test(txt)) dir = "send";
      return {
        baseType: sub?.baseType ?? "",
        rawText: raw,
        pointer: false,
        shape: "channel",
        channelDirection: dir,
      };
    }
    case "function_type":
      return { baseType: "", rawText: raw, pointer: false, shape: "function" };
    case "struct_type":
      return { baseType: "", rawText: raw, pointer: false, shape: "struct_value" };
    case "interface_type":
      return { baseType: "", rawText: raw, pointer: false, shape: "interface_value" };
    case "generic_type": {
      // Go 1.18+ generics: `Foo[T]`. We use the head's short name and
      // drop the type arguments — instantiation is recorded as raw text.
      const head = typeNode.namedChild(0);
      const sub = classifyType(head);
      return sub ? { ...sub, rawText: raw } : null;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Struct tag parsing
// ---------------------------------------------------------------------------

const TAG_PAIR_RE = /(\w+):"([^"]*)"/g;

function parseTags(tagText: string): Record<string, string> {
  const inner = unquote(tagText);
  const out: Record<string, string> = {};
  let m: RegExpExecArray | null;
  while ((m = TAG_PAIR_RE.exec(inner)) !== null) {
    out[m[1]!] = m[2]!;
  }
  return out;
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
  /** Package qn ("foo"). */
  packageQn: string;
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

function handleImportSpec(spec: SyntaxNode, ctx: WalkCtx): void {
  const pathNode = spec.childForFieldName("path");
  if (!pathNode) return;
  const importPath = unquote(pathNode.text);
  if (!importPath) return;
  const nameNode = spec.childForFieldName("name");
  const meta: Record<string, unknown> = { kind: "import", base_type: importPath, resolved: false };
  if (nameNode) {
    const n = nameNode.text.trim();
    if (n === "." || nameNode.type === "dot") meta.dot = true;
    else if (n === "_" || nameNode.type === "blank_identifier") meta.blank = true;
    else if (n) meta.alias = n;
  }
  ctx.edges.push({
    from: ctx.fileEntityId,
    to: `${LANGUAGE}:use:${importPath}`,
    relationship: Relationship.IMPORTS,
    evidence: evidence(spec),
    meta,
  });
}

function handleImportDeclaration(node: SyntaxNode, ctx: WalkCtx): void {
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (!c) continue;
    if (c.type === "import_spec") handleImportSpec(c, ctx);
    else if (c.type === "import_spec_list") {
      for (let j = 0; j < c.namedChildCount; j++) {
        const s = c.namedChild(j);
        if (s && s.type === "import_spec") handleImportSpec(s, ctx);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Type declarations
// ---------------------------------------------------------------------------

function handleTypeDeclaration(node: SyntaxNode, ctx: WalkCtx): void {
  for (let i = 0; i < node.namedChildCount; i++) {
    const spec = node.namedChild(i);
    if (!spec) continue;
    if (spec.type === "type_spec") handleTypeSpec(spec, ctx, /*isAlias*/ false);
    else if (spec.type === "type_alias") handleTypeSpec(spec, ctx, /*isAlias*/ true);
  }
}

function handleTypeSpec(spec: SyntaxNode, ctx: WalkCtx, isAlias: boolean): void {
  const nameNode = spec.childForFieldName("name");
  const typeNode = spec.childForFieldName("type");
  if (!nameNode || !typeNode) return;
  const name = nameNode.text.trim();
  const qn = joinQn(ctx.packageQn, name);

  const baseAttrs: Record<string, unknown> = {};
  let kind: CodeEntityKind;

  switch (typeNode.type) {
    case "struct_type":
      kind = CodeEntityKind.Struct;
      break;
    case "interface_type":
      kind = CodeEntityKind.Interface;
      break;
    case "function_type":
      kind = CodeEntityKind.TypeAlias;
      baseAttrs.delegate = true;
      break;
    default:
      kind = CodeEntityKind.TypeAlias;
      if (isAlias) baseAttrs.is_alias = true;
      else baseAttrs.is_defined_type = true;
      baseAttrs.underlying_type = typeNode.text.trim();
      break;
  }

  const entity: ExtractedEntity = {
    id: entityId(ctx.relPath, kind, qn),
    kind,
    name,
    qualifiedName: qn,
    language: LANGUAGE,
    relPath: ctx.relPath,
    line: nameNode.startPosition.row + 1,
    column: nameNode.startPosition.column + 1,
    attrs: baseAttrs,
  };
  ctx.entities.push(entity);

  if (kind === CodeEntityKind.Struct) {
    emitStructFields(typeNode, qn, ctx);
  } else if (kind === CodeEntityKind.Interface) {
    emitInterfaceMembers(typeNode, qn, entity.id, ctx);
  }
}

// ---------------------------------------------------------------------------
// Struct fields
// ---------------------------------------------------------------------------

function emitStructFields(structTypeNode: SyntaxNode, ownerQn: string, ctx: WalkCtx): void {
  const list = namedChildOfKind(structTypeNode, new Set(["field_declaration_list"]));
  if (!list) return;
  for (let i = 0; i < list.namedChildCount; i++) {
    const decl = list.namedChild(i);
    if (!decl || decl.type !== "field_declaration") continue;
    emitFieldDeclaration(decl, ownerQn, ctx);
  }
}

function emitFieldDeclaration(decl: SyntaxNode, ownerQn: string, ctx: WalkCtx): void {
  const typeNode = decl.childForFieldName("type");
  // Field names: collect every `field_identifier` named child.
  const names = namedChildrenOfKind(decl, new Set(["field_identifier"]));
  const tagNode = decl.childForFieldName("tag");
  const tags = tagNode ? parseTags(tagNode.text) : undefined;

  if (names.length === 0) {
    // Embedded field — the entire `type` is the embedded type.
    emitEmbeddedField(decl, typeNode, ownerQn, tags, ctx);
    return;
  }

  for (const nameNode of names) {
    const name = nameNode.text;
    const qn = `${ownerQn}.${name}`;
    const attrs: Record<string, unknown> = {
      owner_qualified_name: ownerQn,
    };
    const shape = classifyType(typeNode);
    if (shape) {
      attrs.type_text = shape.rawText;
      if (shape.pointer) attrs.pointer = true;
      if (shape.shape) attrs.type_shape = shape.shape;
      if (shape.keyType !== undefined) attrs.key_type = shape.keyType;
      if (shape.channelDirection) attrs.channel_direction = shape.channelDirection;
    }
    if (tags) attrs.tags = tags;

    const fieldEntity: ExtractedEntity = {
      id: entityId(ctx.relPath, CodeEntityKind.Field, qn),
      kind: CodeEntityKind.Field,
      name,
      qualifiedName: qn,
      language: LANGUAGE,
      relPath: ctx.relPath,
      line: nameNode.startPosition.row + 1,
      column: nameNode.startPosition.column + 1,
      attrs,
    };
    ctx.entities.push(fieldEntity);

    emitFieldShapeEdge(fieldEntity.id, shape, decl, ctx);
  }
}

function emitEmbeddedField(
  decl: SyntaxNode,
  typeNode: SyntaxNode | null,
  ownerQn: string,
  tags: Record<string, string> | undefined,
  ctx: WalkCtx,
): void {
  const shape = classifyType(typeNode);
  if (!shape || !shape.baseType) return;
  const name = shape.baseType;
  // Pointer-embedded form `*T` is parsed as `field_declaration ['*', type_identifier]`
  // (the `*` is an anonymous sibling, not a wrapping `pointer_type`). Detect from
  // the declaration text so we still record the pointer flag.
  const pointer = shape.pointer || decl.text.trimStart().startsWith("*");
  const qn = `${ownerQn}.${name}`;
  const attrs: Record<string, unknown> = {
    owner_qualified_name: ownerQn,
    is_embedded: true,
    type_text: shape.rawText,
  };
  if (pointer) attrs.pointer = true;
  if (tags) attrs.tags = tags;

  const fieldEntity: ExtractedEntity = {
    id: entityId(ctx.relPath, CodeEntityKind.Field, qn),
    kind: CodeEntityKind.Field,
    name,
    qualifiedName: qn,
    language: LANGUAGE,
    relPath: ctx.relPath,
    line: decl.startPosition.row + 1,
    column: decl.startPosition.column + 1,
    attrs,
  };
  ctx.entities.push(fieldEntity);

  // Embedded promotion → EMBEDS edge to the embedded type.
  ctx.edges.push({
    from: entityId(ctx.relPath, CodeEntityKind.Struct, ownerQn),
    to: `${LANGUAGE}:type:${name}`,
    relationship: Relationship.EMBEDS,
    evidence: evidence(decl),
    meta: {
      via: "embedded",
      base_type: name,
      pointer,
      resolved: false,
    },
  });
}

function emitFieldShapeEdge(
  fieldId: string,
  shape: TypeShape | null,
  evidenceNode: SyntaxNode,
  ctx: WalkCtx,
): void {
  if (!shape) return;
  // Pointer field → REFERENCES_TYPE (the pointed-to type).
  if (shape.pointer && shape.baseType && shape.shape === "value") {
    ctx.edges.push({
      from: fieldId,
      to: `${LANGUAGE}:type:${shape.baseType}`,
      relationship: Relationship.REFERENCES_TYPE,
      evidence: evidence(evidenceNode),
      meta: {
        via: "pointer",
        base_type: shape.baseType,
        pointer: true,
        resolved: false,
      },
    });
    return;
  }
  switch (shape.shape) {
    case "slice":
    case "array":
      if (!shape.baseType) return;
      ctx.edges.push({
        from: fieldId,
        to: `${LANGUAGE}:type:${shape.baseType}`,
        relationship: Relationship.CONTAINS_MANY,
        evidence: evidence(evidenceNode),
        meta: {
          via: shape.shape,
          base_type: shape.baseType,
          from_annotation: true,
          resolved: false,
        },
      });
      return;
    case "map":
      if (!shape.baseType) return;
      ctx.edges.push({
        from: fieldId,
        to: `${LANGUAGE}:type:${shape.baseType}`,
        relationship: Relationship.MAPS_K_TO_V,
        evidence: evidence(evidenceNode),
        meta: {
          via: "map",
          base_type: shape.baseType,
          key_type: shape.keyType ?? "",
          from_annotation: true,
          resolved: false,
        },
      });
      return;
    case "channel":
      if (!shape.baseType) return;
      ctx.edges.push({
        from: fieldId,
        to: `${LANGUAGE}:type:${shape.baseType}`,
        relationship: Relationship.EMBEDS,
        evidence: evidence(evidenceNode),
        meta: {
          via: "channel",
          base_type: shape.baseType,
          direction: shape.channelDirection ?? "both",
          from_annotation: true,
          resolved: false,
        },
      });
      return;
    case "function":
      ctx.edges.push({
        from: fieldId,
        to: `${LANGUAGE}:type:func`,
        relationship: Relationship.EMBEDS,
        evidence: evidence(evidenceNode),
        meta: {
          via: "function_value",
          base_type: "func",
          from_annotation: true,
          resolved: false,
        },
      });
      return;
    case "struct_value":
    case "interface_value":
      // Anonymous inline composite — no resolvable target.
      return;
    case "value":
      if (!shape.baseType) return;
      ctx.edges.push({
        from: fieldId,
        to: `${LANGUAGE}:type:${shape.baseType}`,
        relationship: Relationship.EMBEDS,
        evidence: evidence(evidenceNode),
        meta: {
          via: "value",
          base_type: shape.baseType,
          from_annotation: true,
          resolved: false,
        },
      });
      return;
    default:
      return;
  }
}

// ---------------------------------------------------------------------------
// Interface members
// ---------------------------------------------------------------------------

function emitInterfaceMembers(
  ifaceTypeNode: SyntaxNode,
  ifaceQn: string,
  ifaceEntityId: string,
  ctx: WalkCtx,
): void {
  for (let i = 0; i < ifaceTypeNode.namedChildCount; i++) {
    const m = ifaceTypeNode.namedChild(i);
    if (!m) continue;
    if (m.type === "method_spec") emitInterfaceMethodSpec(m, ifaceQn, ctx);
    else if (m.type === "constraint_elem") emitConstraintElem(m, ifaceEntityId, ctx);
  }
}

function emitInterfaceMethodSpec(spec: SyntaxNode, ownerQn: string, ctx: WalkCtx): void {
  const nameNode = spec.childForFieldName("name");
  if (!nameNode) return;
  const name = nameNode.text;
  const qn = `${ownerQn}.${name}`;
  const params = spec.childForFieldName("parameters");
  const result = spec.childForFieldName("result");
  const attrs: Record<string, unknown> = {
    owner_qualified_name: ownerQn,
    is_definition: false,
    is_abstract: true,
  };
  const parameterTypes = params ? collectParameterTypes(params) : [];
  if (parameterTypes.length > 0) attrs.parameter_types = parameterTypes;
  if (result) {
    const returnTypes = collectResultTypes(result);
    if (returnTypes.length > 0) attrs.return_types = returnTypes;
  }
  ctx.entities.push({
    id: entityId(ctx.relPath, CodeEntityKind.Method, qn),
    kind: CodeEntityKind.Method,
    name,
    qualifiedName: qn,
    language: LANGUAGE,
    relPath: ctx.relPath,
    line: nameNode.startPosition.row + 1,
    column: nameNode.startPosition.column + 1,
    attrs,
  });
}

function emitConstraintElem(elem: SyntaxNode, ifaceEntityId: string, ctx: WalkCtx): void {
  // The embedded reference is the first descendant type_identifier /
  // qualified_type. (Constraint elements can also contain unions of
  // type terms for generic constraints — we record only the first
  // type's short name as a best-effort EXTENDS target.)
  const ref = namedChildOfKind(elem, new Set(["type_identifier", "qualified_type"]));
  if (!ref) return;
  const shape = classifyType(ref);
  if (!shape || !shape.baseType) return;
  ctx.edges.push({
    from: ifaceEntityId,
    to: `${LANGUAGE}:type:${shape.baseType}`,
    relationship: Relationship.EXTENDS,
    evidence: evidence(elem),
    meta: {
      via: "interface_embedding",
      base_type: shape.baseType,
      resolved: false,
    },
  });
}

// ---------------------------------------------------------------------------
// Functions and methods
// ---------------------------------------------------------------------------

function handleFunctionDeclaration(node: SyntaxNode, ctx: WalkCtx): void {
  const nameNode = node.childForFieldName("name");
  if (!nameNode) return;
  const name = nameNode.text;
  const qn = joinQn(ctx.packageQn, name);
  const params = node.childForFieldName("parameters");
  const result = node.childForFieldName("result");
  const attrs: Record<string, unknown> = {
    owner_qualified_name: ctx.packageQn,
    is_definition: true,
  };
  const parameterTypes = params ? collectParameterTypes(params) : [];
  if (parameterTypes.length > 0) attrs.parameter_types = parameterTypes;
  if (result) {
    const returnTypes = collectResultTypes(result);
    if (returnTypes.length > 0) attrs.return_types = returnTypes;
  }
  ctx.entities.push({
    id: entityId(ctx.relPath, CodeEntityKind.Function, qn),
    kind: CodeEntityKind.Function,
    name,
    qualifiedName: qn,
    language: LANGUAGE,
    relPath: ctx.relPath,
    line: nameNode.startPosition.row + 1,
    column: nameNode.startPosition.column + 1,
    attrs,
  });
}

function handleMethodDeclaration(node: SyntaxNode, ctx: WalkCtx): void {
  const nameNode = node.childForFieldName("name");
  const receiver = node.childForFieldName("receiver");
  if (!nameNode || !receiver) return;
  const recv = parseReceiver(receiver);
  if (!recv) return;
  const name = nameNode.text;
  const ownerQn = joinQn(ctx.packageQn, recv.typeName);
  const qn = `${ownerQn}.${name}`;
  const params = node.childForFieldName("parameters");
  const result = node.childForFieldName("result");
  const attrs: Record<string, unknown> = {
    owner_qualified_name: ownerQn,
    is_definition: true,
    pointer_receiver: recv.pointer,
  };
  if (recv.varName) attrs.receiver_name = recv.varName;
  const parameterTypes = params ? collectParameterTypes(params) : [];
  if (parameterTypes.length > 0) attrs.parameter_types = parameterTypes;
  if (result) {
    const returnTypes = collectResultTypes(result);
    if (returnTypes.length > 0) attrs.return_types = returnTypes;
  }
  ctx.entities.push({
    id: entityId(ctx.relPath, CodeEntityKind.Method, qn),
    kind: CodeEntityKind.Method,
    name,
    qualifiedName: qn,
    language: LANGUAGE,
    relPath: ctx.relPath,
    line: nameNode.startPosition.row + 1,
    column: nameNode.startPosition.column + 1,
    attrs,
  });
}

interface Receiver {
  varName: string;
  typeName: string;
  pointer: boolean;
}

function parseReceiver(recvParamList: SyntaxNode): Receiver | null {
  // receiver is a parameter_list with a single parameter_declaration.
  const decl = namedChildOfKind(recvParamList, new Set(["parameter_declaration"]));
  if (!decl) return null;
  const typeNode = decl.childForFieldName("type");
  const nameNode = decl.childForFieldName("name");
  const shape = classifyType(typeNode);
  if (!shape || !shape.baseType) return null;
  return {
    varName: nameNode ? nameNode.text.trim() : "",
    typeName: shape.baseType,
    pointer: shape.pointer,
  };
}

function collectParameterTypes(paramList: SyntaxNode): string[] {
  const out: string[] = [];
  for (let i = 0; i < paramList.namedChildCount; i++) {
    const decl = paramList.namedChild(i);
    if (!decl) continue;
    if (decl.type !== "parameter_declaration" && decl.type !== "variadic_parameter_declaration") {
      continue;
    }
    const typeNode = decl.childForFieldName("type");
    const shape = classifyType(typeNode);
    out.push(shape ? shape.rawText : (typeNode ? typeNode.text.trim() : ""));
  }
  return out;
}

function collectResultTypes(result: SyntaxNode): string[] {
  if (result.type === "parameter_list") return collectParameterTypes(result);
  // Single bare type as result.
  const shape = classifyType(result);
  return shape ? [shape.rawText] : [result.text.trim()];
}

// ---------------------------------------------------------------------------
// Constants and package-level vars
// ---------------------------------------------------------------------------

function handleConstDeclaration(node: SyntaxNode, ctx: WalkCtx): void {
  for (let i = 0; i < node.namedChildCount; i++) {
    const spec = node.namedChild(i);
    if (!spec || spec.type !== "const_spec") continue;
    emitConstOrVarSpec(spec, ctx, /*isConst*/ true);
  }
}

function handleVarDeclaration(node: SyntaxNode, ctx: WalkCtx): void {
  for (let i = 0; i < node.namedChildCount; i++) {
    const spec = node.namedChild(i);
    if (!spec || spec.type !== "var_spec") continue;
    emitConstOrVarSpec(spec, ctx, /*isConst*/ false);
  }
}

function emitConstOrVarSpec(spec: SyntaxNode, ctx: WalkCtx, isConst: boolean): void {
  // name(s) are direct `identifier` named children; `type` is a field
  // when present; `value` is the assignment RHS.
  const names: SyntaxNode[] = [];
  for (let i = 0; i < spec.namedChildCount; i++) {
    const c = spec.namedChild(i);
    if (c && c.type === "identifier") names.push(c);
  }
  const typeNode = spec.childForFieldName("type");
  for (const nameNode of names) {
    const name = nameNode.text;
    const qn = joinQn(ctx.packageQn, name);
    const attrs: Record<string, unknown> = {
      owner_qualified_name: ctx.packageQn,
    };
    if (isConst) attrs.is_const = true;
    else attrs.is_package_var = true;
    const shape = classifyType(typeNode);
    if (shape) {
      attrs.type_text = shape.rawText;
      if (shape.shape) attrs.type_shape = shape.shape;
    }
    if (isConst) {
      ctx.entities.push({
        id: entityId(ctx.relPath, CodeEntityKind.Constant, qn),
        kind: CodeEntityKind.Constant,
        name,
        qualifiedName: qn,
        language: LANGUAGE,
        relPath: ctx.relPath,
        line: nameNode.startPosition.row + 1,
        column: nameNode.startPosition.column + 1,
        attrs,
      });
    }
    ctx.entities.push({
      id: entityId(ctx.relPath, CodeEntityKind.Field, qn),
      kind: CodeEntityKind.Field,
      name,
      qualifiedName: qn,
      language: LANGUAGE,
      relPath: ctx.relPath,
      line: nameNode.startPosition.row + 1,
      column: nameNode.startPosition.column + 1,
      attrs,
    });
  }
}

// ---------------------------------------------------------------------------
// Top-level dispatch
// ---------------------------------------------------------------------------

function dispatchTopLevel(node: SyntaxNode, ctx: WalkCtx): void {
  switch (node.type) {
    case "package_clause":
      return;
    case "import_declaration":
      handleImportDeclaration(node, ctx);
      return;
    case "type_declaration":
      handleTypeDeclaration(node, ctx);
      return;
    case "function_declaration":
      handleFunctionDeclaration(node, ctx);
      return;
    case "method_declaration":
      handleMethodDeclaration(node, ctx);
      return;
    case "const_declaration":
      handleConstDeclaration(node, ctx);
      return;
    case "var_declaration":
      handleVarDeclaration(node, ctx);
      return;
    default:
      return;
  }
}

// ---------------------------------------------------------------------------
// Extractor entry point
// ---------------------------------------------------------------------------

async function extract(file: ExtractFileInput): Promise<ExtractorOutput> {
  const entities: ExtractedEntity[] = [];
  const edges: ExtractedEdge[] = [];
  const diagnostics: ExtractorDiagnostic[] = [];

  let parser;
  try {
    parser = await getParser("go");
  } catch (err) {
    diagnostics.push({
      severity: "error",
      relPath: file.relPath,
      message: `failed to load go grammar: ${(err as Error).message}`,
    });
    return { entities, edges, shapes: [], diagnostics };
  }

  const tree = parser.parse(file.source);
  const root = tree.rootNode;

  // File entity.
  const fileEntityId = fileId(file.relPath);
  entities.push({
    id: fileEntityId,
    kind: CodeEntityKind.SourceFile,
    name: file.name,
    qualifiedName: file.relPath,
    language: LANGUAGE,
    relPath: file.relPath,
    line: 1,
    column: 1,
    attrs: {},
  });

  const packageName = derivePackageName(root);
  if (!packageName) {
    diagnostics.push({
      severity: "warning",
      relPath: file.relPath,
      message: "go file has no package clause",
    });
    return { entities, edges, shapes: [], diagnostics };
  }

  // Module entity for the package.
  entities.push({
    id: entityId(file.relPath, CodeEntityKind.Module, packageName),
    kind: CodeEntityKind.Module,
    name: packageName,
    qualifiedName: packageName,
    language: LANGUAGE,
    relPath: file.relPath,
    line: 1,
    column: 1,
    attrs: { is_package: true, package_name: packageName },
  });

  const ctx: WalkCtx = {
    relPath: file.relPath,
    entities,
    edges,
    diagnostics,
    fileEntityId,
    packageQn: packageName,
  };

  for (let i = 0; i < root.namedChildCount; i++) {
    const c = root.namedChild(i);
    if (c) dispatchTopLevel(c, ctx);
  }

  return { entities, edges, shapes: [], diagnostics };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const goExtractor: Extractor = {
  name: NAME,
  version: VERSION,
  extensions: EXTENSIONS,
  parserBacked: true,
  extract,
};
