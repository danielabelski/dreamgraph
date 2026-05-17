/**
 * DreamGraph — C language extractor (wave 1, phases C-1 + C-2).
 *
 * Walks a tree-sitter-c parse tree and emits:
 *   - Entities: struct, union, enum, enum members, typedef, function
 *     declarations, function definitions, fields, `#define` macros.
 *   - Edges: DECLARES (file → entity), DECLARES_FIELD (composite →
 *     field), DECLARES_ENUM_MEMBER, INCLUDES, and pointer edges
 *     (POINTS_TO / POINTS_TO_POINTER with depth + const/volatile meta).
 *
 * Header↔source binding (C-3), linked-list shape detection (C-4), and
 * intrusive/array-with-count/opaque-handle shapes (C-5) ship in
 * subsequent commits per
 * plans/polyglot-graph-scanning-implementation-plan.md §5.
 *
 * Design notes:
 *   - The extractor is a pure function over (file, source). No I/O, no
 *     mutation of shared state.
 *   - Tree-sitter is invoked via the shared `parser-bootstrap` so each
 *     extractor call reuses the cached `Language` instance and gets a
 *     fresh `Parser`.
 *   - Entity ids are stable and content-independent so re-running the
 *     extractor on the same file produces the same graph keys (required
 *     for snapshot tests and incremental re-emission).
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

const NAME = "c";
const VERSION = "0.1.0";
const LANGUAGE = "c";
const EXTENSIONS: readonly string[] = [".c", ".h"];

// ---------------------------------------------------------------------------
// Entity-id helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Evidence factory
// ---------------------------------------------------------------------------

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
// Node helpers
// ---------------------------------------------------------------------------

/** Read the source slice referenced by a tree-sitter node. */
function nodeText(node: SyntaxNode | null | undefined): string {
  return node ? node.text : "";
}

/**
 * Find the identifier inside a struct/union/enum specifier or a typedef
 * declarator. Returns the source text of the name, or `""` if anonymous.
 */
function specifierName(node: SyntaxNode): string {
  // `struct_specifier`, `union_specifier`, `enum_specifier` expose `name`
  // as a `type_identifier` child via the `name` field.
  const named = node.childForFieldName("name");
  return named ? named.text : "";
}

/**
 * Extract the base type name from a field/parameter `type` node.
 * Handles plain `type_identifier`, `primitive_type`, and struct/union/
 * enum specifiers that reference (rather than declare) a type.
 *
 * Returns the bare type name (e.g. `"Node"`, `"int"`, `"Bucket"` for
 * `struct Bucket`). Used as the symbolic POINTS_TO target. The
 * orchestrator (C-3) is responsible for resolving these names to real
 * entity ids once cross-file binding lands.
 */
function baseTypeName(typeNode: SyntaxNode | null | undefined): string {
  if (!typeNode) return "";
  if (typeNode.type === "type_identifier" ||
      typeNode.type === "primitive_type" ||
      typeNode.type === "sized_type_specifier") {
    return typeNode.text.trim();
  }
  if (typeNode.type === "struct_specifier" ||
      typeNode.type === "union_specifier" ||
      typeNode.type === "enum_specifier") {
    const named = typeNode.childForFieldName("name");
    if (named) return named.text;
    // Anonymous specifier (e.g. inline struct in a field) — no usable
    // target name. Leaving this empty makes the caller skip the edge.
    return "";
  }
  return typeNode.text.trim();
}

/**
 * Walk a declarator chain counting `pointer_declarator` wrappers and
 * extract the innermost identifier. Returns:
 *  - `depth`: number of `*` levels (0 for non-pointer fields/params).
 *  - `innerName`: leaf identifier name (empty if abstract / unnamed).
 *
 * Tree-sitter-c shape:
 *   pointer_declarator
 *     └─ declarator: pointer_declarator
 *         └─ declarator: field_identifier
 */
function analyzePointer(declarator: SyntaxNode | null): {
  depth: number;
  innerName: string;
} {
  let cur: SyntaxNode | null = declarator;
  let depth = 0;
  while (cur && cur.type === "pointer_declarator") {
    depth += 1;
    cur = cur.childForFieldName("declarator");
  }
  return { depth, innerName: declaratorName(cur) };
}

/**
 * Collect type qualifiers that apply to the pointee. In tree-sitter-c
 * these appear as `type_qualifier` named children of the enclosing
 * `field_declaration` / `parameter_declaration` alongside the `type`
 * and `declarator` fields. We only surface `const` and `volatile`
 * because those are the C qualifiers that affect graph semantics
 * (read-only borrow, observable side effects).
 */
function pointeeQualifiers(declNode: SyntaxNode): {
  isConst: boolean;
  isVolatile: boolean;
} {
  let isConst = false;
  let isVolatile = false;
  for (let i = 0; i < declNode.namedChildCount; i++) {
    const child = declNode.namedChild(i);
    if (!child || child.type !== "type_qualifier") continue;
    const t = child.text;
    if (t === "const") isConst = true;
    else if (t === "volatile") isVolatile = true;
  }
  return { isConst, isVolatile };
}

/**
 * Extract the leaf identifier from a declarator subtree. Handles
 * pointer_declarator, function_declarator, parenthesized_declarator,
 * array_declarator wrappers by walking to the innermost identifier.
 */
function declaratorName(node: SyntaxNode | null): string {
  let cur: SyntaxNode | null = node;
  while (cur) {
    if (cur.type === "identifier" || cur.type === "field_identifier" ||
        cur.type === "type_identifier") {
      return cur.text;
    }
    // `declarator` field is the conventional path inward.
    const inner = cur.childForFieldName("declarator");
    if (inner) {
      cur = inner;
      continue;
    }
    // Fall back to first named child for parenthesised forms.
    if (cur.namedChildCount > 0) {
      cur = cur.namedChild(0);
      continue;
    }
    return "";
  }
  return "";
}

// ---------------------------------------------------------------------------
// Per-node handlers
// ---------------------------------------------------------------------------

interface WalkCtx {
  relPath: string;
  entities: ExtractedEntity[];
  edges: ExtractedEdge[];
  diagnostics: ExtractorDiagnostic[];
  /** id of the synthesised `SourceFile`/`HeaderFile` node for this file. */
  fileEntityId: string;
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

function handleStructOrUnion(
  node: SyntaxNode,
  ctx: WalkCtx,
  nameOverride?: string,
): void {
  const isUnion = node.type === "union_specifier";
  // Only emit when the specifier has a body — bare references like
  // `struct Foo *p;` produce a specifier node without a `body` field.
  if (!node.childForFieldName("body")) return;
  const name = specifierName(node) || nameOverride || "";
  if (!name) return; // anonymous, no stable identity
  const kind = isUnion ? CodeEntityKind.Union : CodeEntityKind.Struct;
  const id = entityId(ctx.relPath, kind, name);
  emitEntity(ctx, {
    id,
    kind,
    name,
    qualifiedName: name,
    language: LANGUAGE,
    relPath: ctx.relPath,
    line: node.startPosition.row + 1,
    column: node.startPosition.column + 1,
  });

  // Emit fields inside the body.
  const body = node.childForFieldName("body");
  if (!body) return;
  for (let i = 0; i < body.namedChildCount; i++) {
    const child = body.namedChild(i);
    if (!child) continue;
    if (child.type !== "field_declaration") continue;
    handleField(child, ctx, name, id);
  }
}

function handleField(
  node: SyntaxNode,
  ctx: WalkCtx,
  ownerName: string,
  ownerId: string,
): void {
  const declarator = node.childForFieldName("declarator");
  const typeNode = node.childForFieldName("type");
  const { depth, innerName } = analyzePointer(declarator);
  const fieldName = innerName || declaratorName(declarator);
  if (!fieldName) return;
  const qn = `${ownerName}.${fieldName}`;
  const id = entityId(ctx.relPath, CodeEntityKind.Field, qn);
  const baseType = baseTypeName(typeNode);
  emitEntity(
    ctx,
    {
      id,
      kind: CodeEntityKind.Field,
      name: fieldName,
      qualifiedName: qn,
      language: LANGUAGE,
      relPath: ctx.relPath,
      line: node.startPosition.row + 1,
      column: node.startPosition.column + 1,
      attrs: {
        type_text: nodeText(typeNode),
        pointer_depth: depth,
        base_type: baseType,
        owner_qualified_name: ownerName,
      },
    },
    /* ownedByFile */ false,
  );
  ctx.edges.push({
    from: ownerId,
    to: id,
    relationship: Relationship.DECLARES_FIELD,
    evidence: evidence(node),
  });

  // C-2: emit POINTS_TO / POINTS_TO_POINTER for pointer fields.
  // Target id is a symbolic `c:type:<name>` placeholder; the
  // orchestrator (C-3) will rewrite these to real entity ids when it
  // joins headers and sources. Self-typed pointers (e.g. `Node *next`
  // inside `Node`) are still emitted — they're the structural signal
  // C-4 uses to detect linked lists.
  if (depth >= 1 && baseType) {
    const { isConst, isVolatile } = pointeeQualifiers(node);
    const target = `${LANGUAGE}:type:${baseType}`;
    const rel =
      depth === 1
        ? Relationship.POINTS_TO
        : Relationship.POINTS_TO_POINTER;
    ctx.edges.push({
      from: id,
      to: target,
      relationship: rel,
      evidence: evidence(node),
      meta: {
        depth,
        base_type: baseType,
        is_const: isConst,
        is_volatile: isVolatile,
        resolved: false,
      },
    });
  }
}

function handleEnum(
  node: SyntaxNode,
  ctx: WalkCtx,
  nameOverride?: string,
): void {
  if (!node.childForFieldName("body")) return;
  const name = specifierName(node) || nameOverride || "";
  if (!name) return;
  const id = entityId(ctx.relPath, CodeEntityKind.Enum, name);
  emitEntity(ctx, {
    id,
    kind: CodeEntityKind.Enum,
    name,
    qualifiedName: name,
    language: LANGUAGE,
    relPath: ctx.relPath,
    line: node.startPosition.row + 1,
    column: node.startPosition.column + 1,
  });

  const body = node.childForFieldName("body");
  if (!body) return;
  for (let i = 0; i < body.namedChildCount; i++) {
    const child = body.namedChild(i);
    if (!child || child.type !== "enumerator") continue;
    const memberName = nodeText(child.childForFieldName("name"));
    if (!memberName) continue;
    const qn = `${name}.${memberName}`;
    const memberId = entityId(ctx.relPath, CodeEntityKind.EnumMember, qn);
    emitEntity(
      ctx,
      {
        id: memberId,
        kind: CodeEntityKind.EnumMember,
        name: memberName,
        qualifiedName: qn,
        language: LANGUAGE,
        relPath: ctx.relPath,
        line: child.startPosition.row + 1,
        column: child.startPosition.column + 1,
      },
      /* ownedByFile */ false,
    );
    ctx.edges.push({
      from: id,
      to: memberId,
      relationship: Relationship.DECLARES_ENUM_MEMBER,
      evidence: evidence(child),
    });
  }
}

function handleTypedef(node: SyntaxNode, ctx: WalkCtx): void {
  // `type_definition` -> last named child is the declarator carrying
  // the new alias name. The aliased type sits in the preceding children.
  let aliasName = "";
  for (let i = node.namedChildCount - 1; i >= 0; i--) {
    const child = node.namedChild(i);
    if (!child) continue;
    const candidate = declaratorName(child);
    if (candidate) {
      aliasName = candidate;
      break;
    }
  }
  if (!aliasName) return;
  const id = entityId(ctx.relPath, CodeEntityKind.TypeAlias, aliasName);
  emitEntity(ctx, {
    id,
    kind: CodeEntityKind.TypeAlias,
    name: aliasName,
    qualifiedName: aliasName,
    language: LANGUAGE,
    relPath: ctx.relPath,
    line: node.startPosition.row + 1,
    column: node.startPosition.column + 1,
    attrs: {
      aliased_text: node.text,
    },
  });
}

function handleFunctionDefinition(node: SyntaxNode, ctx: WalkCtx): void {
  const declarator = node.childForFieldName("declarator");
  const fnName = declaratorName(declarator);
  if (!fnName) return;
  const id = entityId(ctx.relPath, CodeEntityKind.Function, fnName);
  emitEntity(ctx, {
    id,
    kind: CodeEntityKind.Function,
    name: fnName,
    qualifiedName: fnName,
    language: LANGUAGE,
    relPath: ctx.relPath,
    line: node.startPosition.row + 1,
    column: node.startPosition.column + 1,
    attrs: { is_definition: true },
  });
}

function handleDeclaration(node: SyntaxNode, ctx: WalkCtx): void {
  // A top-level `declaration` may declare a function (prototype) or one
  // or more variables. We only emit function prototypes here; variable
  // declarations are not yet part of C-1 scope.
  const declarator = node.childForFieldName("declarator");
  if (!declarator) return;
  // A function declarator at the top level signals a prototype.
  const isFunction =
    declarator.type === "function_declarator" ||
    descendantOfType(declarator, "function_declarator") !== null;
  if (!isFunction) return;
  const fnName = declaratorName(declarator);
  if (!fnName) return;
  const id = entityId(ctx.relPath, CodeEntityKind.Function, fnName);
  emitEntity(ctx, {
    id,
    kind: CodeEntityKind.Function,
    name: fnName,
    qualifiedName: fnName,
    language: LANGUAGE,
    relPath: ctx.relPath,
    line: node.startPosition.row + 1,
    column: node.startPosition.column + 1,
    attrs: { is_definition: false },
  });
}

function handleMacro(node: SyntaxNode, ctx: WalkCtx): void {
  const macroName = nodeText(node.childForFieldName("name"));
  if (!macroName) return;
  const id = entityId(ctx.relPath, CodeEntityKind.Macro, macroName);
  emitEntity(ctx, {
    id,
    kind: CodeEntityKind.Macro,
    name: macroName,
    qualifiedName: macroName,
    language: LANGUAGE,
    relPath: ctx.relPath,
    line: node.startPosition.row + 1,
    column: node.startPosition.column + 1,
  });
}

function handleInclude(node: SyntaxNode, ctx: WalkCtx): void {
  // tree-sitter-c exposes the path via the `path` field (system_lib_string
  // for `<…>` and string_literal for `"…"`).
  const pathNode = node.childForFieldName("path");
  if (!pathNode) return;
  const raw = pathNode.text;
  // Strip surrounding quotes / angle brackets.
  const stripped = raw.replace(/^[<"]/, "").replace(/[>"]$/, "");
  const isSystem = raw.startsWith("<");
  // The include target is unresolved at extraction time; the orchestrator
  // resolves it against the project's header search paths in a later
  // step. We mint a placeholder id so cross-file joining can wire it up.
  const targetId = `${LANGUAGE}:include:${stripped}`;
  ctx.edges.push({
    from: ctx.fileEntityId,
    to: targetId,
    relationship: Relationship.INCLUDES,
    evidence: evidence(node),
    meta: { path: stripped, system: isSystem },
  });
}

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

function descendantOfType(
  node: SyntaxNode,
  type: string,
): SyntaxNode | null {
  if (node.type === type) return node;
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    const hit = descendantOfType(child, type);
    if (hit) return hit;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Top-level walk
// ---------------------------------------------------------------------------

function walk(root: SyntaxNode, ctx: WalkCtx): void {
  for (let i = 0; i < root.namedChildCount; i++) {
    const child = root.namedChild(i);
    if (!child) continue;
    switch (child.type) {
      case "struct_specifier":
      case "union_specifier":
        handleStructOrUnion(child, ctx);
        break;
      case "enum_specifier":
        handleEnum(child, ctx);
        break;
      case "type_definition": {
        // Capture the alias name first so anonymous inner specifiers
        // (e.g. `typedef enum { ... } NodeKind;`) can adopt it.
        let aliasName = "";
        for (let j = child.namedChildCount - 1; j >= 0; j--) {
          const tail = child.namedChild(j);
          if (!tail) continue;
          const candidate = declaratorName(tail);
          if (candidate) {
            aliasName = candidate;
            break;
          }
        }
        handleTypedef(child, ctx);
        // A typedef may carry a struct/union/enum specifier with a body;
        // recurse so the inner specifier is also emitted. The alias name
        // is threaded through so anonymous inner specifiers gain stable
        // identity from the typedef.
        for (let j = 0; j < child.namedChildCount; j++) {
          const inner = child.namedChild(j);
          if (!inner) continue;
          if (inner.type === "struct_specifier" ||
              inner.type === "union_specifier") {
            handleStructOrUnion(inner, ctx, aliasName);
          } else if (inner.type === "enum_specifier") {
            handleEnum(inner, ctx, aliasName);
          }
        }
        break;
      }
      case "function_definition":
        handleFunctionDefinition(child, ctx);
        break;
      case "declaration":
        // Top-level declaration: function prototype OR a declaration that
        // contains an embedded struct/union/enum specifier with a body.
        handleDeclaration(child, ctx);
        for (let j = 0; j < child.namedChildCount; j++) {
          const inner = child.namedChild(j);
          if (!inner) continue;
          if (inner.type === "struct_specifier" ||
              inner.type === "union_specifier") {
            handleStructOrUnion(inner, ctx);
          } else if (inner.type === "enum_specifier") {
            handleEnum(inner, ctx);
          }
        }
        break;
      case "preproc_def":
      case "preproc_function_def":
        handleMacro(child, ctx);
        break;
      case "preproc_include":
        handleInclude(child, ctx);
        break;
      // preproc_if / preproc_ifdef wrap nested top-level items — recurse.
      case "preproc_if":
      case "preproc_ifdef":
      case "preproc_else":
      case "preproc_elif":
        walk(child, ctx);
        break;
      default:
        // Other top-level node kinds (linkage_specification, attribute…)
        // are not yet in scope for C-1.
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// Extractor
// ---------------------------------------------------------------------------

export const cExtractor: Extractor = {
  name: NAME,
  version: VERSION,
  extensions: EXTENSIONS,
  parserBacked: true,
  async extract(file: ExtractFileInput): Promise<ExtractorOutput> {
    const parser = await getParser("c");
    const tree = parser.parse(file.source);
    const root = tree.rootNode;

    const isHeader = file.ext.toLowerCase() === ".h";
    const fileKind = isHeader
      ? CodeEntityKind.HeaderFile
      : CodeEntityKind.SourceFile;
    const fId = fileId(file.relPath);

    const entities: ExtractedEntity[] = [
      {
        id: fId,
        kind: fileKind,
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
