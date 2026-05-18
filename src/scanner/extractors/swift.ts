/**
 * DreamGraph — Swift extractor.
 *
 * Tree-sitter–backed extractor for `.swift` source files. Covers:
 *
 *   SW-1 file structure + top-level declarations
 *     - SourceFile entity per file
 *     - IMPORTS edges per `import` declaration
 *     - Class / Struct / Enum / Interface (protocol) / TypeAlias entities
 *     - Top-level Function entities
 *     - Top-level Field entities for `let`/`var` properties
 *
 *   SW-2 type bodies + members
 *     - Properties (let/var) as Field entities with owner_qualified_name
 *     - Methods (instance + init) with parameter_types / return_types
 *     - Enum cases as Constant entities (associated values in attrs)
 *     - Extension members bound to the extended type with `from_extension`
 *
 *   SW-3 inheritance + type shapes
 *     - Class superclass → EXTENDS; protocol conformance → IMPLEMENTS
 *     - Protocol inheritance → EXTENDS
 *     - Property/parameter/return type shapes:
 *         user_type        → EMBEDS via "value"
 *         optional_type    → REFERENCES_TYPE with meta.optional:true
 *         array_type       → CONTAINS_MANY via "array"
 *         dictionary_type  → MAPS_K_TO_V with key_type meta
 *         function_type    → EMBEDS via "function_value"
 *         tuple_type       → EMBEDS via "tuple_value"
 *
 * Every cross-type edge target uses the placeholder id
 * `swift:type:<ShortName>` carrying `meta.base_type` and `meta.resolved:false`
 * so the orchestrator's link pass can rewrite it later.
 *
 * Swift has no `package`/`namespace` declarations in source — module
 * boundaries are determined by the build system. We therefore do NOT
 * emit a Module entity from a `.swift` file.
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

const NAME = "swift";
const VERSION = "0.1.0";
const LANGUAGE = "swift";
const EXTENSIONS: readonly string[] = [".swift"];

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
// AST helpers
// ---------------------------------------------------------------------------

function namedChildOfKind(node: SyntaxNode, kinds: ReadonlySet<string>): SyntaxNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c && kinds.has(c.type)) return c;
  }
  return null;
}

function namedChildrenOfKind(node: SyntaxNode, kinds: ReadonlySet<string>): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c && kinds.has(c.type)) out.push(c);
  }
  return out;
}

function firstAnonChildOfKinds(node: SyntaxNode, kinds: ReadonlySet<string>): string | null {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c && !c.isNamed() && kinds.has(c.type)) return c.type;
  }
  return null;
}

function userTypeName(userType: SyntaxNode | null): string | null {
  if (!userType) return null;
  if (userType.type !== "user_type") return null;
  const ident = namedChildOfKind(userType, new Set(["type_identifier"]));
  return ident ? ident.text : null;
}

// ---------------------------------------------------------------------------
// Type-shape classification
// ---------------------------------------------------------------------------

interface TypeShape {
  baseType: string | null;
  rawText: string;
  shape: "value" | "optional" | "array" | "dictionary" | "function" | "tuple";
  keyType?: string;
}

function classifyType(typeNode: SyntaxNode | null): TypeShape | null {
  if (!typeNode) return null;
  const rawText = typeNode.text;
  switch (typeNode.type) {
    case "user_type": {
      return { baseType: userTypeName(typeNode), rawText, shape: "value" };
    }
    case "optional_type": {
      const inner = namedChildOfKind(typeNode, new Set(["user_type", "array_type", "dictionary_type", "function_type", "tuple_type"]));
      const innerShape = classifyType(inner);
      return {
        baseType: innerShape?.baseType ?? null,
        rawText,
        shape: "optional",
      };
    }
    case "array_type": {
      const elem = namedChildOfKind(typeNode, new Set(["user_type", "array_type", "dictionary_type", "optional_type", "function_type", "tuple_type"]));
      const elemShape = classifyType(elem);
      return {
        baseType: elemShape?.baseType ?? null,
        rawText,
        shape: "array",
      };
    }
    case "dictionary_type": {
      // dictionary_type kids: '[' key_type ':' value_type ']' — both named.
      const named = namedChildrenOfKind(typeNode, new Set(["user_type", "array_type", "dictionary_type", "optional_type", "function_type", "tuple_type"]));
      const keyShape = classifyType(named[0] ?? null);
      const valueShape = classifyType(named[1] ?? null);
      return {
        baseType: valueShape?.baseType ?? null,
        rawText,
        shape: "dictionary",
        keyType: keyShape?.baseType ?? keyShape?.rawText ?? undefined,
      };
    }
    case "function_type":
      return { baseType: null, rawText, shape: "function" };
    case "tuple_type":
      return { baseType: null, rawText, shape: "tuple" };
    default:
      return { baseType: null, rawText, shape: "value" };
  }
}

function emitTypeShapeEdge(
  fromId: string,
  shape: TypeShape | null,
  evidenceNode: SyntaxNode,
  ctx: WalkCtx,
  via: string,
): void {
  if (!shape) return;
  // Skip when there's no resolvable target name (anonymous tuple, anon function, etc.)
  // — except for shapes that intrinsically have a name (value/optional/array/dictionary).
  if (!shape.baseType && shape.shape !== "function" && shape.shape !== "tuple") return;

  const meta: Record<string, unknown> = {
    via,
    base_type: shape.baseType,
    resolved: false,
  };
  if (shape.keyType !== undefined) meta.key_type = shape.keyType;

  let relationship: typeof Relationship[keyof typeof Relationship];
  if (shape.shape === "optional") {
    meta.optional = true;
    relationship = Relationship.REFERENCES_TYPE;
  } else if (shape.shape === "array") {
    meta.via = "array";
    relationship = Relationship.CONTAINS_MANY;
  } else if (shape.shape === "dictionary") {
    meta.via = "dictionary";
    relationship = Relationship.MAPS_K_TO_V;
  } else if (shape.shape === "function") {
    meta.via = "function_value";
    relationship = Relationship.EMBEDS;
  } else if (shape.shape === "tuple") {
    meta.via = "tuple_value";
    relationship = Relationship.EMBEDS;
  } else {
    relationship = Relationship.EMBEDS;
  }

  if (!shape.baseType && relationship !== Relationship.EMBEDS) return;

  ctx.edges.push({
    from: fromId,
    to: shape.baseType ? `${LANGUAGE}:type:${shape.baseType}` : `${LANGUAGE}:type:_anonymous`,
    relationship,
    evidence: evidence(evidenceNode),
    meta,
  });
}

// ---------------------------------------------------------------------------
// Modifiers
// ---------------------------------------------------------------------------

interface Modifiers {
  visibility?: "public" | "private" | "fileprivate" | "internal" | "open";
  isStatic: boolean;
  isFinal: boolean;
  isOverride: boolean;
  raw: string[];
}

function extractModifiers(node: SyntaxNode | null): Modifiers {
  const out: Modifiers = { isStatic: false, isFinal: false, isOverride: false, raw: [] };
  const mods = node ? namedChildOfKind(node, new Set(["modifiers"])) : null;
  if (!mods) return out;
  for (let i = 0; i < mods.namedChildCount; i++) {
    const c = mods.namedChild(i);
    if (!c) continue;
    const text = c.text;
    out.raw.push(text);
    if (c.type === "visibility_modifier") {
      const v = text.trim();
      if (v === "public" || v === "private" || v === "fileprivate" || v === "internal" || v === "open") {
        out.visibility = v;
      }
    } else if (c.type === "property_modifier" || c.type === "member_modifier" || c.type === "function_modifier") {
      if (text === "static" || text === "class") out.isStatic = true;
      if (text === "final") out.isFinal = true;
      if (text === "override") out.isOverride = true;
    }
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
  fileId: string;
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

function handleImport(node: SyntaxNode, ctx: WalkCtx): void {
  // `import Foundation` → identifier > simple_identifier (or dotted)
  const ident = namedChildOfKind(node, new Set(["identifier"]));
  if (!ident) return;
  // Collect text segments joined by `.` (Swift submodule imports).
  const segs: string[] = [];
  for (let i = 0; i < ident.namedChildCount; i++) {
    const c = ident.namedChild(i);
    if (c && c.type === "simple_identifier") segs.push(c.text);
  }
  if (segs.length === 0) segs.push(ident.text.trim());
  const target = segs.join(".");
  ctx.edges.push({
    from: ctx.fileId,
    to: `${LANGUAGE}:use:${target}`,
    relationship: Relationship.IMPORTS,
    evidence: evidence(node),
    meta: { target, resolved: false },
  });
}

// ---------------------------------------------------------------------------
// Inheritance
// ---------------------------------------------------------------------------

/**
 * Collect inheritance targets from a class/struct/enum/protocol's
 * `inheritance_specifier` siblings. Returns the list of short type
 * names in declaration order.
 */
function collectInheritance(node: SyntaxNode): string[] {
  const out: string[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (!c) continue;
    if (c.type !== "inheritance_specifier") continue;
    const ut = namedChildOfKind(c, new Set(["user_type"]));
    const name = userTypeName(ut);
    if (name) out.push(name);
  }
  return out;
}

function emitInheritanceEdges(
  fromId: string,
  names: readonly string[],
  evidenceNode: SyntaxNode,
  ctx: WalkCtx,
  kind: "class" | "struct" | "enum" | "protocol",
): void {
  if (names.length === 0) return;
  // In Swift, a class's first inheritance entry is the superclass; all
  // remaining entries are protocol conformances. For struct/enum every
  // entry is a protocol. For protocol every entry is an inherited protocol.
  if (kind === "class") {
    const [first, ...rest] = names;
    if (first) {
      ctx.edges.push({
        from: fromId,
        to: `${LANGUAGE}:type:${first}`,
        relationship: Relationship.EXTENDS,
        evidence: evidence(evidenceNode),
        meta: { base_type: first, resolved: false, via: "superclass" },
      });
    }
    for (const p of rest) {
      ctx.edges.push({
        from: fromId,
        to: `${LANGUAGE}:type:${p}`,
        relationship: Relationship.IMPLEMENTS,
        evidence: evidence(evidenceNode),
        meta: { base_type: p, resolved: false, via: "protocol_conformance" },
      });
    }
  } else if (kind === "protocol") {
    for (const p of names) {
      ctx.edges.push({
        from: fromId,
        to: `${LANGUAGE}:type:${p}`,
        relationship: Relationship.EXTENDS,
        evidence: evidence(evidenceNode),
        meta: { base_type: p, resolved: false, via: "protocol_inheritance" },
      });
    }
  } else {
    for (const p of names) {
      ctx.edges.push({
        from: fromId,
        to: `${LANGUAGE}:type:${p}`,
        relationship: Relationship.IMPLEMENTS,
        evidence: evidence(evidenceNode),
        meta: { base_type: p, resolved: false, via: "protocol_conformance" },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

function propertyName(propNode: SyntaxNode): string | null {
  const pattern = namedChildOfKind(propNode, new Set(["pattern"]));
  if (!pattern) return null;
  const ident = namedChildOfKind(pattern, new Set(["simple_identifier"]));
  return ident ? ident.text : null;
}

function propertyIsLet(propNode: SyntaxNode): boolean {
  const vbp = namedChildOfKind(propNode, new Set(["value_binding_pattern"]));
  if (!vbp) return false;
  for (let i = 0; i < vbp.childCount; i++) {
    const c = vbp.child(i);
    if (c && c.type === "let") return true;
  }
  return false;
}

function handlePropertyDeclaration(
  propNode: SyntaxNode,
  ownerQn: string | null,
  ctx: WalkCtx,
  fromExtension = false,
): void {
  const name = propertyName(propNode);
  if (!name) return;
  const qn = ownerQn ? `${ownerQn}.${name}` : name;
  const typeAnnotation = namedChildOfKind(propNode, new Set(["type_annotation"]));
  const typeNode = typeAnnotation
    ? namedChildOfKind(typeAnnotation, new Set(["user_type", "array_type", "dictionary_type", "optional_type", "function_type", "tuple_type"]))
    : null;
  const shape = classifyType(typeNode);
  const mods = extractModifiers(propNode);
  const isLet = propertyIsLet(propNode);

  const attrs: Record<string, unknown> = {
    is_let: isLet,
  };
  if (ownerQn) {
    attrs.owner_qualified_name = ownerQn;
  } else {
    attrs.is_top_level = true;
  }
  if (mods.visibility) attrs.visibility = mods.visibility;
  if (mods.isStatic) attrs.is_static = true;
  if (fromExtension) attrs.from_extension = true;
  if (shape) {
    attrs.type_text = shape.rawText;
    if (shape.shape !== "value") attrs.type_shape = shape.shape;
    if (shape.shape === "optional") attrs.optional = true;
    if (shape.keyType !== undefined) attrs.key_type = shape.keyType;
  }

  const fieldEntity: ExtractedEntity = {
    id: entityId(ctx.relPath, CodeEntityKind.Field, qn),
    kind: CodeEntityKind.Field,
    name,
    qualifiedName: qn,
    language: LANGUAGE,
    relPath: ctx.relPath,
    line: propNode.startPosition.row + 1,
    column: propNode.startPosition.column + 1,
    attrs,
  };
  ctx.entities.push(fieldEntity);

  emitTypeShapeEdge(fieldEntity.id, shape, propNode, ctx, "type_annotation");
}

// ---------------------------------------------------------------------------
// Functions / methods / initializers
// ---------------------------------------------------------------------------

function collectParameterTypes(node: SyntaxNode): string[] {
  const types: string[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (!c || c.type !== "parameter") continue;
    const typeNode = namedChildOfKind(c, new Set(["user_type", "array_type", "dictionary_type", "optional_type", "function_type", "tuple_type"]));
    types.push(typeNode ? typeNode.text.trim() : "");
  }
  return types;
}

function returnTypeNode(funcNode: SyntaxNode): SyntaxNode | null {
  // Return type follows the `->` anonymous child. Find the named child
  // that is one of the type kinds AND appears after the `->`.
  let sawArrow = false;
  for (let i = 0; i < funcNode.childCount; i++) {
    const c = funcNode.child(i);
    if (!c) continue;
    if (!c.isNamed() && c.type === "->") {
      sawArrow = true;
      continue;
    }
    if (sawArrow && c.isNamed()) {
      switch (c.type) {
        case "user_type":
        case "array_type":
        case "dictionary_type":
        case "optional_type":
        case "function_type":
        case "tuple_type":
          return c;
      }
    }
  }
  return null;
}

function functionIsAsync(funcNode: SyntaxNode): boolean {
  for (let i = 0; i < funcNode.childCount; i++) {
    const c = funcNode.child(i);
    if (c && (c.type === "async" || (!c.isNamed() && c.text === "async"))) return true;
  }
  return false;
}

function functionIsThrows(funcNode: SyntaxNode): boolean {
  for (let i = 0; i < funcNode.childCount; i++) {
    const c = funcNode.child(i);
    if (c && c.type === "throws") return true;
  }
  return false;
}

function handleFunctionDeclaration(
  funcNode: SyntaxNode,
  ownerQn: string | null,
  ctx: WalkCtx,
  opts: { fromExtension?: boolean; isAbstract?: boolean } = {},
): void {
  const nameNode = namedChildOfKind(funcNode, new Set(["simple_identifier"]));
  if (!nameNode) return;
  const name = nameNode.text;
  const qn = ownerQn ? `${ownerQn}.${name}` : name;

  const mods = extractModifiers(funcNode);
  const paramTypes = collectParameterTypes(funcNode);
  const retNode = returnTypeNode(funcNode);
  const retShape = classifyType(retNode);
  const isAsync = functionIsAsync(funcNode);
  const isThrows = functionIsThrows(funcNode);

  const attrs: Record<string, unknown> = {
    parameter_types: paramTypes,
    return_types: retNode ? [retNode.text.trim()] : [],
    is_definition: !opts.isAbstract,
    is_abstract: !!opts.isAbstract,
  };
  if (ownerQn) {
    attrs.owner_qualified_name = ownerQn;
  } else {
    attrs.is_top_level = true;
  }
  if (mods.visibility) attrs.visibility = mods.visibility;
  if (mods.isStatic) attrs.is_static = true;
  if (mods.isOverride) attrs.is_override = true;
  if (isAsync) attrs.is_async = true;
  if (isThrows) attrs.throws = true;
  if (opts.fromExtension) attrs.from_extension = true;

  const kind = ownerQn ? CodeEntityKind.Method : CodeEntityKind.Function;
  const entity: ExtractedEntity = {
    id: entityId(ctx.relPath, kind, qn),
    kind,
    name,
    qualifiedName: qn,
    language: LANGUAGE,
    relPath: ctx.relPath,
    line: nameNode.startPosition.row + 1,
    column: nameNode.startPosition.column + 1,
    attrs,
  };
  ctx.entities.push(entity);

  emitTypeShapeEdge(entity.id, retShape, retNode ?? funcNode, ctx, "return");
}

function handleInitDeclaration(
  initNode: SyntaxNode,
  ownerQn: string,
  ctx: WalkCtx,
  fromExtension = false,
): void {
  const mods = extractModifiers(initNode);
  const paramTypes = collectParameterTypes(initNode);
  const qn = `${ownerQn}.init`;

  const attrs: Record<string, unknown> = {
    owner_qualified_name: ownerQn,
    parameter_types: paramTypes,
    return_types: [],
    is_definition: true,
    is_initializer: true,
  };
  if (mods.visibility) attrs.visibility = mods.visibility;
  if (fromExtension) attrs.from_extension = true;

  ctx.entities.push({
    id: entityId(ctx.relPath, CodeEntityKind.Constructor, qn),
    kind: CodeEntityKind.Constructor,
    name: "init",
    qualifiedName: qn,
    language: LANGUAGE,
    relPath: ctx.relPath,
    line: initNode.startPosition.row + 1,
    column: initNode.startPosition.column + 1,
    attrs,
  });
}

// ---------------------------------------------------------------------------
// Type bodies
// ---------------------------------------------------------------------------

function walkTypeBody(
  body: SyntaxNode,
  ownerQn: string,
  ctx: WalkCtx,
  fromExtension = false,
): void {
  for (let i = 0; i < body.namedChildCount; i++) {
    const c = body.namedChild(i);
    if (!c) continue;
    switch (c.type) {
      case "property_declaration":
        handlePropertyDeclaration(c, ownerQn, ctx, fromExtension);
        break;
      case "function_declaration":
        handleFunctionDeclaration(c, ownerQn, ctx, { fromExtension });
        break;
      case "init_declaration":
        handleInitDeclaration(c, ownerQn, ctx, fromExtension);
        break;
      case "class_declaration":
        handleClassDeclaration(c, ownerQn, ctx);
        break;
      case "protocol_declaration":
        handleProtocolDeclaration(c, ownerQn, ctx);
        break;
      case "typealias_declaration":
        handleTypeAlias(c, ownerQn, ctx);
        break;
      default:
        break;
    }
  }
}

function walkEnumBody(body: SyntaxNode, ownerQn: string, ctx: WalkCtx): void {
  for (let i = 0; i < body.namedChildCount; i++) {
    const c = body.namedChild(i);
    if (!c) continue;
    switch (c.type) {
      case "enum_entry":
        handleEnumEntry(c, ownerQn, ctx);
        break;
      case "property_declaration":
        handlePropertyDeclaration(c, ownerQn, ctx);
        break;
      case "function_declaration":
        handleFunctionDeclaration(c, ownerQn, ctx);
        break;
      case "init_declaration":
        handleInitDeclaration(c, ownerQn, ctx);
        break;
      case "typealias_declaration":
        handleTypeAlias(c, ownerQn, ctx);
        break;
      default:
        break;
    }
  }
}

function handleEnumEntry(node: SyntaxNode, ownerQn: string, ctx: WalkCtx): void {
  const ident = namedChildOfKind(node, new Set(["simple_identifier"]));
  if (!ident) return;
  const name = ident.text;
  const qn = `${ownerQn}.${name}`;

  const params = namedChildOfKind(node, new Set(["enum_type_parameters"]));
  const associatedValues: { label?: string; type: string }[] = [];
  if (params) {
    // enum_type_parameters kids: '(' simple_identifier ':' user_type ',' ... ')'
    let pendingLabel: string | undefined;
    for (let i = 0; i < params.namedChildCount; i++) {
      const c = params.namedChild(i);
      if (!c) continue;
      if (c.type === "simple_identifier") {
        pendingLabel = c.text;
      } else if (c.type === "user_type" || c.type === "array_type" || c.type === "optional_type" || c.type === "dictionary_type") {
        associatedValues.push({ label: pendingLabel, type: c.text });
        pendingLabel = undefined;
      }
    }
  }

  const attrs: Record<string, unknown> = {
    owner_qualified_name: ownerQn,
    is_enum_case: true,
  };
  if (associatedValues.length > 0) {
    attrs.associated_values = associatedValues;
  }

  ctx.entities.push({
    id: entityId(ctx.relPath, CodeEntityKind.EnumMember, qn),
    kind: CodeEntityKind.EnumMember,
    name,
    qualifiedName: qn,
    language: LANGUAGE,
    relPath: ctx.relPath,
    line: ident.startPosition.row + 1,
    column: ident.startPosition.column + 1,
    attrs,
  });
}

// ---------------------------------------------------------------------------
// Class / Struct / Enum / Extension dispatch
// ---------------------------------------------------------------------------

function handleClassDeclaration(
  node: SyntaxNode,
  parentQn: string | null,
  ctx: WalkCtx,
): void {
  // Distinguish class/struct/enum/extension by the leading anonymous keyword.
  const keyword = firstAnonChildOfKinds(node, new Set(["class", "struct", "enum", "extension"]));
  if (!keyword) return;

  if (keyword === "extension") {
    handleExtension(node, ctx);
    return;
  }

  const typeIdent = namedChildOfKind(node, new Set(["type_identifier"]));
  if (!typeIdent) return;
  const name = typeIdent.text;
  const qn = parentQn ? `${parentQn}.${name}` : name;
  const mods = extractModifiers(node);

  const attrs: Record<string, unknown> = {};
  if (mods.visibility) attrs.visibility = mods.visibility;
  if (mods.isFinal) attrs.is_final = true;

  let kind: typeof CodeEntityKind[keyof typeof CodeEntityKind];
  if (keyword === "class") kind = CodeEntityKind.Class;
  else if (keyword === "struct") kind = CodeEntityKind.Struct;
  else kind = CodeEntityKind.Enum;

  const entity: ExtractedEntity = {
    id: entityId(ctx.relPath, kind, qn),
    kind,
    name,
    qualifiedName: qn,
    language: LANGUAGE,
    relPath: ctx.relPath,
    line: typeIdent.startPosition.row + 1,
    column: typeIdent.startPosition.column + 1,
    attrs,
  };
  ctx.entities.push(entity);

  const inheritance = collectInheritance(node);
  const inheritKind = keyword === "class" ? "class" : keyword === "struct" ? "struct" : "enum";
  emitInheritanceEdges(entity.id, inheritance, typeIdent, ctx, inheritKind);

  if (keyword === "enum") {
    const body = namedChildOfKind(node, new Set(["enum_class_body"]));
    if (body) walkEnumBody(body, qn, ctx);
  } else {
    const body = namedChildOfKind(node, new Set(["class_body"]));
    if (body) walkTypeBody(body, qn, ctx);
  }
}

function handleExtension(node: SyntaxNode, ctx: WalkCtx): void {
  // Extension's target is the `user_type` direct child (not type_identifier).
  const ut = namedChildOfKind(node, new Set(["user_type"]));
  const targetName = userTypeName(ut);
  if (!targetName) return;
  const body = namedChildOfKind(node, new Set(["class_body"]));
  if (!body) return;
  // Record extension conformances as IMPLEMENTS edges from the extended
  // type → protocol. Use the placeholder id for the extended type.
  const fromPlaceholder = `${LANGUAGE}:type:${targetName}`;
  const inheritance = collectInheritance(node);
  for (const p of inheritance) {
    ctx.edges.push({
      from: fromPlaceholder,
      to: `${LANGUAGE}:type:${p}`,
      relationship: Relationship.IMPLEMENTS,
      evidence: evidence(ut!),
      meta: { base_type: p, resolved: false, via: "extension_conformance" },
    });
  }
  walkTypeBody(body, targetName, ctx, /*fromExtension*/ true);
}

// ---------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------

function handleProtocolDeclaration(
  node: SyntaxNode,
  parentQn: string | null,
  ctx: WalkCtx,
): void {
  const typeIdent = namedChildOfKind(node, new Set(["type_identifier"]));
  if (!typeIdent) return;
  const name = typeIdent.text;
  const qn = parentQn ? `${parentQn}.${name}` : name;
  const mods = extractModifiers(node);

  const attrs: Record<string, unknown> = {};
  if (mods.visibility) attrs.visibility = mods.visibility;

  const entity: ExtractedEntity = {
    id: entityId(ctx.relPath, CodeEntityKind.Interface, qn),
    kind: CodeEntityKind.Interface,
    name,
    qualifiedName: qn,
    language: LANGUAGE,
    relPath: ctx.relPath,
    line: typeIdent.startPosition.row + 1,
    column: typeIdent.startPosition.column + 1,
    attrs,
  };
  ctx.entities.push(entity);

  const inheritance = collectInheritance(node);
  emitInheritanceEdges(entity.id, inheritance, typeIdent, ctx, "protocol");

  const body = namedChildOfKind(node, new Set(["protocol_body"]));
  if (!body) return;
  for (let i = 0; i < body.namedChildCount; i++) {
    const c = body.namedChild(i);
    if (!c) continue;
    switch (c.type) {
      case "protocol_property_declaration":
        handleProtocolPropertyDecl(c, qn, ctx);
        break;
      case "protocol_function_declaration":
        handleFunctionDeclaration(c, qn, ctx, { isAbstract: true });
        break;
      default:
        break;
    }
  }
}

function handleProtocolPropertyDecl(node: SyntaxNode, ownerQn: string, ctx: WalkCtx): void {
  const pattern = namedChildOfKind(node, new Set(["pattern"]));
  const ident = pattern ? namedChildOfKind(pattern, new Set(["simple_identifier"])) : null;
  if (!ident) return;
  const name = ident.text;
  const qn = `${ownerQn}.${name}`;
  const typeAnnotation = namedChildOfKind(node, new Set(["type_annotation"]));
  const typeNode = typeAnnotation
    ? namedChildOfKind(typeAnnotation, new Set(["user_type", "array_type", "dictionary_type", "optional_type", "function_type", "tuple_type"]))
    : null;
  const shape = classifyType(typeNode);
  const reqs = namedChildOfKind(node, new Set(["protocol_property_requirements"]));
  const reqText = reqs ? reqs.text : "";
  const hasGet = /\bget\b/.test(reqText);
  const hasSet = /\bset\b/.test(reqText);

  const attrs: Record<string, unknown> = {
    owner_qualified_name: ownerQn,
    is_abstract: true,
    has_get: hasGet,
    has_set: hasSet,
  };
  if (shape) {
    attrs.type_text = shape.rawText;
    if (shape.shape !== "value") attrs.type_shape = shape.shape;
  }

  const ent: ExtractedEntity = {
    id: entityId(ctx.relPath, CodeEntityKind.Field, qn),
    kind: CodeEntityKind.Field,
    name,
    qualifiedName: qn,
    language: LANGUAGE,
    relPath: ctx.relPath,
    line: ident.startPosition.row + 1,
    column: ident.startPosition.column + 1,
    attrs,
  };
  ctx.entities.push(ent);
  emitTypeShapeEdge(ent.id, shape, node, ctx, "type_annotation");
}

// ---------------------------------------------------------------------------
// Typealias
// ---------------------------------------------------------------------------

function handleTypeAlias(node: SyntaxNode, parentQn: string | null, ctx: WalkCtx): void {
  const ident = namedChildOfKind(node, new Set(["type_identifier"]));
  if (!ident) return;
  const name = ident.text;
  const qn = parentQn ? `${parentQn}.${name}` : name;
  const mods = extractModifiers(node);

  // Underlying type: any of user_type/array_type/optional_type/dictionary_type/function_type/tuple_type
  // that appears after the `=` token.
  let sawEq = false;
  let under: SyntaxNode | null = null;
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (!c) continue;
    if (!c.isNamed() && c.type === "=") {
      sawEq = true;
      continue;
    }
    if (sawEq && c.isNamed()) {
      under = c;
      break;
    }
  }

  const attrs: Record<string, unknown> = {
    is_alias: true,
  };
  if (under) attrs.underlying_type = under.text.trim();
  if (mods.visibility) attrs.visibility = mods.visibility;

  ctx.entities.push({
    id: entityId(ctx.relPath, CodeEntityKind.TypeAlias, qn),
    kind: CodeEntityKind.TypeAlias,
    name,
    qualifiedName: qn,
    language: LANGUAGE,
    relPath: ctx.relPath,
    line: ident.startPosition.row + 1,
    column: ident.startPosition.column + 1,
    attrs,
  });
}

// ---------------------------------------------------------------------------
// Top-level dispatch
// ---------------------------------------------------------------------------

function dispatchTopLevel(node: SyntaxNode, ctx: WalkCtx): void {
  switch (node.type) {
    case "import_declaration":
      handleImport(node, ctx);
      break;
    case "class_declaration":
      handleClassDeclaration(node, null, ctx);
      break;
    case "protocol_declaration":
      handleProtocolDeclaration(node, null, ctx);
      break;
    case "typealias_declaration":
      handleTypeAlias(node, null, ctx);
      break;
    case "function_declaration":
      handleFunctionDeclaration(node, null, ctx);
      break;
    case "property_declaration":
      handlePropertyDeclaration(node, null, ctx);
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function extract(file: ExtractFileInput): Promise<ExtractorOutput> {
  const entities: ExtractedEntity[] = [];
  const edges: ExtractedEdge[] = [];
  const diagnostics: ExtractorDiagnostic[] = [];

  const parser = await getParser("swift");
  const tree = parser.parse(file.source);
  const root = tree.rootNode;

  // SourceFile entity.
  const baseName = file.name.replace(/\.swift$/i, "");
  const fileEntity: ExtractedEntity = {
    id: fileId(file.relPath),
    kind: CodeEntityKind.SourceFile,
    name: file.name,
    qualifiedName: file.relPath,
    language: LANGUAGE,
    relPath: file.relPath,
    line: 1,
    column: 1,
    attrs: { base_name: baseName },
  };
  entities.push(fileEntity);

  const ctx: WalkCtx = {
    relPath: file.relPath,
    entities,
    edges,
    diagnostics,
    fileId: fileEntity.id,
  };

  if (root.type !== "source_file") {
    diagnostics.push({
      severity: "warning",
      relPath: file.relPath,
      message: `Swift parser returned unexpected root type '${root.type}'`,
      line: 1,
      column: 1,
    });
    return { entities, edges, shapes: [], diagnostics };
  }

  for (let i = 0; i < root.namedChildCount; i++) {
    const c = root.namedChild(i);
    if (c) dispatchTopLevel(c, ctx);
  }

  return { entities, edges, shapes: [], diagnostics };
}

// ---------------------------------------------------------------------------
// Public extractor
// ---------------------------------------------------------------------------

export const swiftExtractor: Extractor = {
  name: NAME,
  version: VERSION,
  extensions: EXTENSIONS,
  parserBacked: true,
  extract,
};
