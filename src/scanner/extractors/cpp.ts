/**
 * DreamGraph — C++ language extractor (wave 1, phases CPP-1 + CPP-2).
 *
 * The C++ tree-sitter grammar is a superset of C, so this extractor
 * mirrors many of the same handlers (struct, union, enum, typedef,
 * macro, include, top-level function) — keeping the C and C++
 * extractors decoupled rather than sharing a base class, because each
 * grammar evolves on its own cadence and a shared base would invite
 * subtle node-shape regressions when one grammar updates.
 *
 * CPP-2 scope (this commit):
 *   - In-class method declarations (`field_declaration` whose declarator
 *     is a `function_declarator`) → Method entity, attrs.is_definition=false.
 *   - In-class constructors (`declaration` whose function_declarator
 *     name matches the enclosing class) → Constructor entity.
 *   - In-class destructors (`declaration` whose function_declarator
 *     declarator is a `destructor_name`) → Destructor entity.
 *   - Inline definitions inside the class body (`function_definition`)
 *     → Method/Constructor/Destructor with is_definition=true.
 *   - Out-of-line member definitions (`function_definition` whose
 *     function_declarator unwraps a `qualified_identifier`) → emitted
 *     with the fully-qualified owner chain so the orchestrator can
 *     bind declaration ↔ definition by qualifiedName.
 *   - Entity ids for Method/Constructor/Destructor include the source
 *     line so overloads don't collide on identity.
 *
 * Out of scope for CPP-2 (next commits):
 *   - CPP-3: smart-pointer / STL container ownership semantics.
 *   - CPP-4: templates and partial specialisations.
 *
 * CPP-1 scope (previous commit):
 *   - Namespace entities (with `ns1::ns2` qualified-name nesting).
 *   - Class and Struct entities (Class for `class`, Struct for `struct`).
 *   - Access modifiers tracked per field (`public` / `private` /
 *     `protected`); default is `private` for `class`, `public` for
 *     `struct`, matching C++ semantics.
 *   - Inheritance via `base_class_clause` → EXTENDS edges (one per
 *     base, with virtual/access captured in edge meta).
 *   - Pointer modeling on fields (depth + base type + POINTS_TO edges,
 *     same scheme as the C extractor's C-2).
 *   - Includes (resolved later by the orchestrator).
 *   - Macros (`#define`).
 *
 * Out of scope for CPP-1 (handled in later phases):
 *   - CPP-2..CPP-4 — see top of file.
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

const NAME = "cpp";
const VERSION = "0.1.0";
const LANGUAGE = "cpp";
const EXTENSIONS: readonly string[] = [
  ".cpp", ".cc", ".cxx", ".c++",
  ".hpp", ".hh", ".hxx", ".h++",
];

const HEADER_EXTS = new Set<string>([".hpp", ".hh", ".hxx", ".h++", ".h"]);

// ---------------------------------------------------------------------------
// Id helpers
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
// Evidence
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
// Node helpers (mirrored from the C extractor; tree-sitter-cpp uses the
// same node-type vocabulary for these constructs)
// ---------------------------------------------------------------------------

function nodeText(node: SyntaxNode | null | undefined): string {
  return node ? node.text : "";
}

function specifierName(node: SyntaxNode): string {
  const named = node.childForFieldName("name");
  if (!named) return "";
  // C++ class/struct names can be qualified_identifier (out-of-line def)
  // or template_type. For CPP-1 we only need the leaf identifier.
  return tailIdentifier(named);
}

/**
 * Reduce a C++ name reference (possibly `ns::X::Y` or `Foo<T>`) to its
 * trailing identifier. Used when we want the bare class name, not its
 * qualifier chain. The qualifier chain itself is preserved separately
 * in the entity's qualifiedName via the namespace stack.
 */
function tailIdentifier(node: SyntaxNode): string {
  if (node.type === "identifier" || node.type === "type_identifier" ||
      node.type === "field_identifier" || node.type === "namespace_identifier") {
    return node.text;
  }
  // qualified_identifier / template_type carry a `name` field on the tail.
  const tail = node.childForFieldName("name");
  if (tail) return tailIdentifier(tail);
  if (node.namedChildCount > 0) {
    return tailIdentifier(node.namedChild(node.namedChildCount - 1)!);
  }
  return node.text;
}

function declaratorName(node: SyntaxNode | null): string {
  let cur: SyntaxNode | null = node;
  while (cur) {
    if (cur.type === "identifier" || cur.type === "field_identifier" ||
        cur.type === "type_identifier" || cur.type === "namespace_identifier") {
      return cur.text;
    }
    if (cur.type === "qualified_identifier") {
      const tail = cur.childForFieldName("name");
      if (tail) {
        cur = tail;
        continue;
      }
    }
    const inner = cur.childForFieldName("declarator");
    if (inner) { cur = inner; continue; }
    if (cur.namedChildCount > 0) { cur = cur.namedChild(0); continue; }
    return "";
  }
  return "";
}

function baseTypeName(typeNode: SyntaxNode | null | undefined): string {
  if (!typeNode) return "";
  if (typeNode.type === "type_identifier" ||
      typeNode.type === "primitive_type" ||
      typeNode.type === "sized_type_specifier" ||
      typeNode.type === "auto" ||
      typeNode.type === "placeholder_type_specifier") {
    return typeNode.text.trim();
  }
  if (typeNode.type === "struct_specifier" ||
      typeNode.type === "union_specifier" ||
      typeNode.type === "enum_specifier" ||
      typeNode.type === "class_specifier") {
    const named = typeNode.childForFieldName("name");
    return named ? tailIdentifier(named) : "";
  }
  if (typeNode.type === "qualified_identifier" ||
      typeNode.type === "template_type") {
    return tailIdentifier(typeNode);
  }
  return typeNode.text.trim();
}

function analyzePointer(declarator: SyntaxNode | null): {
  depth: number;
  innerName: string;
  isReference: boolean;
} {
  let cur: SyntaxNode | null = declarator;
  let depth = 0;
  let isReference = false;
  while (cur) {
    if (cur.type === "pointer_declarator") {
      depth += 1;
      cur = cur.childForFieldName("declarator");
      continue;
    }
    if (cur.type === "reference_declarator") {
      // C++-only: `T &name`. Treat as a borrow-like single indirection.
      isReference = true;
      cur = cur.namedChildCount > 0 ? cur.namedChild(cur.namedChildCount - 1) : null;
      continue;
    }
    break;
  }
  return { depth, innerName: declaratorName(cur), isReference };
}

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

function descendantOfType(node: SyntaxNode, type: string): SyntaxNode | null {
  if (node.type === type) return node;
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    const hit = descendantOfType(child, type);
    if (hit) return hit;
  }
  return null;
}

/**
 * True when a `declaration` / `field_declaration` is shaped like a
 * function (member method, constructor, or destructor). Used to
 * separate data-member field_declarations from method-like ones.
 */
function isFieldFunctionLike(node: SyntaxNode): boolean {
  const declarator = node.childForFieldName("declarator");
  if (!declarator) return false;
  if (declarator.type === "function_declarator") return true;
  return descendantOfType(declarator, "function_declarator") !== null;
}

// ---------------------------------------------------------------------------
// CPP-2: qualified-name unfolding for out-of-line definitions
// ---------------------------------------------------------------------------

/**
 * Walk a `function_declarator` and return the inner declarator that
 * carries the function name. Strips pointer/reference declarators that
 * appear on the return-type chain (rare for member fns but harmless).
 */
function unwrapFunctionDeclarator(node: SyntaxNode | null): SyntaxNode | null {
  let cur = node;
  while (cur) {
    if (cur.type === "function_declarator") {
      return cur.childForFieldName("declarator") ?? null;
    }
    if (cur.type === "pointer_declarator" || cur.type === "reference_declarator") {
      cur = cur.childForFieldName("declarator");
      continue;
    }
    if (cur.type === "parenthesized_declarator") {
      cur = cur.namedChildCount > 0 ? cur.namedChild(0) : null;
      continue;
    }
    return null;
  }
  return null;
}

/**
 * Unfold a (possibly nested) qualified_identifier into its segments.
 * `engine::Circle::Circle` \u2192 ["engine", "Circle", "Circle"].
 * `engine::Circle::~Circle` \u2192 ["engine", "Circle", "~Circle"].
 * A bare identifier \u2192 [identifier_text].
 */
function unfoldName(node: SyntaxNode): string[] {
  const out: string[] = [];
  let cur: SyntaxNode | null = node;
  while (cur) {
    if (cur.type === "qualified_identifier") {
      const scope = cur.childForFieldName("scope");
      if (scope) out.push(scope.text);
      const name = cur.childForFieldName("name");
      if (!name) break;
      cur = name;
      continue;
    }
    if (cur.type === "destructor_name") {
      // destructor_name has a `~` token + identifier as named child.
      const id = cur.namedChildCount > 0 ? cur.namedChild(cur.namedChildCount - 1) : null;
      out.push("~" + (id ? id.text : cur.text.replace(/^~/, "")));
      break;
    }
    if (cur.type === "identifier" ||
        cur.type === "type_identifier" ||
        cur.type === "field_identifier" ||
        cur.type === "namespace_identifier") {
      out.push(cur.text);
      break;
    }
    if (cur.type === "template_function") {
      const tname = cur.childForFieldName("name");
      if (tname) {
        cur = tname;
        continue;
      }
    }
    break;
  }
  return out;
}

type MemberKind =
  | typeof CodeEntityKind.Method
  | typeof CodeEntityKind.Constructor
  | typeof CodeEntityKind.Destructor;

/**
 * Classify a member callable based on its name chain and (optionally)
 * the enclosing class. `chain` is the unfolded qualified name with the
 * final segment being the callable's own name.
 */
function classifyMember(
  chain: string[],
  enclosingClass: string | undefined,
): { kind: MemberKind; methodName: string } {
  const tail = chain[chain.length - 1] ?? "";
  if (tail.startsWith("~")) {
    return { kind: CodeEntityKind.Destructor, methodName: tail };
  }
  // Out-of-line: tail === penultimate segment (e.g. ["engine","Circle","Circle"]).
  if (chain.length >= 2 && tail === chain[chain.length - 2]) {
    return { kind: CodeEntityKind.Constructor, methodName: tail };
  }
  // In-class: enclosing class matches tail.
  if (enclosingClass && tail === enclosingClass) {
    return { kind: CodeEntityKind.Constructor, methodName: tail };
  }
  return { kind: CodeEntityKind.Method, methodName: tail };
}

// ---------------------------------------------------------------------------
// Walk context — extends the C variant with a namespace stack so nested
// entities carry their fully-qualified C++ name.
// ---------------------------------------------------------------------------

type AccessModifier = "public" | "private" | "protected";

interface WalkCtx {
  relPath: string;
  entities: ExtractedEntity[];
  edges: ExtractedEdge[];
  diagnostics: ExtractorDiagnostic[];
  fileEntityId: string;
  /** Stack of namespace names currently in scope. */
  namespaceStack: string[];
}

function currentQualifier(ctx: WalkCtx): string {
  return ctx.namespaceStack.join("::");
}

function qualify(ctx: WalkCtx, name: string): string {
  const q = currentQualifier(ctx);
  return q ? `${q}::${name}` : name;
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
// Handlers
// ---------------------------------------------------------------------------

function handleNamespace(node: SyntaxNode, ctx: WalkCtx): void {
  const nameNode = node.childForFieldName("name");
  // Anonymous namespaces (no `name` field) get a stable synthetic name
  // per file so unrelated anonymous namespaces in different files don't
  // collide on id but multiple ones in the same file do (which is the
  // correct C++ semantic — they're all the same anonymous namespace).
  const name = nameNode ? nameNode.text : "(anonymous)";
  const qn = qualify(ctx, name);
  const id = entityId(ctx.relPath, CodeEntityKind.Namespace, qn);
  emitEntity(ctx, {
    id,
    kind: CodeEntityKind.Namespace,
    name,
    qualifiedName: qn,
    language: LANGUAGE,
    relPath: ctx.relPath,
    line: node.startPosition.row + 1,
    column: node.startPosition.column + 1,
  });
  const body = node.childForFieldName("body");
  if (!body) return;
  ctx.namespaceStack.push(name);
  try {
    walkBody(body, ctx);
  } finally {
    ctx.namespaceStack.pop();
  }
}

function handleClassLike(
  node: SyntaxNode,
  ctx: WalkCtx,
  kind: typeof CodeEntityKind.Class | typeof CodeEntityKind.Struct |
        typeof CodeEntityKind.Union,
  defaultAccess: AccessModifier,
  nameOverride?: string,
): void {
  if (!node.childForFieldName("body")) return;
  const name = specifierName(node) || nameOverride || "";
  if (!name) return;
  const qn = qualify(ctx, name);
  const id = entityId(ctx.relPath, kind, qn);
  emitEntity(ctx, {
    id,
    kind,
    name,
    qualifiedName: qn,
    language: LANGUAGE,
    relPath: ctx.relPath,
    line: node.startPosition.row + 1,
    column: node.startPosition.column + 1,
    attrs: { default_access: defaultAccess },
  });

  // Inheritance — `base_class_clause` appears as a direct child of the
  // class_specifier in tree-sitter-cpp.
  const bases = node.childForFieldName("base_class_clause") ??
    findChildOfType(node, "base_class_clause");
  if (bases) emitInheritance(bases, ctx, id);

  // Walk the body, tracking access modifiers as we go.
  const body = node.childForFieldName("body")!;
  let access: AccessModifier = defaultAccess;
  // Push the class onto the namespace stack so nested types & methods
  // are named `Outer::Inner`.
  ctx.namespaceStack.push(name);
  try {
    for (let i = 0; i < body.namedChildCount; i++) {
      const child = body.namedChild(i);
      if (!child) continue;
      switch (child.type) {
        case "access_specifier": {
          // tree-sitter-cpp renders this as a node whose text is the
          // keyword. There's no `name` field.
          const t = child.text.replace(/[\s:]+$/, "");
          if (t === "public" || t === "private" || t === "protected") {
            access = t;
          }
          break;
        }
        case "field_declaration":
          // tree-sitter-cpp uses field_declaration for both data
          // members AND in-class method declarations. Route methods
          // through the member-callable path; handleField filters them
          // out so we don't double-emit.
          if (isFieldFunctionLike(child)) {
            handleClassBodyCallable(child, ctx, name);
          } else {
            handleField(child, ctx, qn, id, access);
          }
          break;
        case "declaration":
          // In a class body, declarations are ctors/dtors (or static
          // member variable declarations, which we defer). Route the
          // function-shaped ones through the member-callable path.
          if (isFieldFunctionLike(child)) {
            handleClassBodyCallable(child, ctx, name);
          }
          break;
        case "function_definition":
          // Inline definition inside the class body.
          handleClassBodyCallable(child, ctx, name);
          break;
        case "class_specifier":
          handleClassLike(child, ctx, CodeEntityKind.Class, "private");
          break;
        case "struct_specifier":
          handleClassLike(child, ctx, CodeEntityKind.Struct, "public");
          break;
        case "union_specifier":
          handleClassLike(child, ctx, CodeEntityKind.Union, "public");
          break;
        case "enum_specifier":
          handleEnum(child, ctx);
          break;
        case "type_definition":
          handleTypedef(child, ctx);
          break;
        // function_definition / declaration inside a class body are
        // member methods — deferred to CPP-2.
        default:
          break;
      }
    }
  } finally {
    ctx.namespaceStack.pop();
  }
}

function emitInheritance(
  bases: SyntaxNode,
  ctx: WalkCtx,
  classId: string,
): void {
  for (let i = 0; i < bases.namedChildCount; i++) {
    const b = bases.namedChild(i);
    if (!b) continue;
    // Each base is wrapped in `base_class_clause`'s named children;
    // common shapes: type_identifier, qualified_identifier, template_type,
    // optionally preceded by an access_specifier and `virtual` keyword.
    // We harvest both the base name and any preceding access keyword.
    if (b.type === "access_specifier") continue; // handled inline below
    const baseName = baseTypeName(b);
    if (!baseName) continue;
    // Look backwards for an access keyword that decorates THIS base.
    let access: AccessModifier | undefined;
    let isVirtual = false;
    for (let j = i - 1; j >= 0; j--) {
      const prev = bases.namedChild(j);
      if (!prev) continue;
      if (prev.type === "type_identifier" ||
          prev.type === "qualified_identifier" ||
          prev.type === "template_type") break;
      const t = prev.text;
      if (t === "public" || t === "private" || t === "protected") {
        if (!access) access = t;
      } else if (t === "virtual") {
        isVirtual = true;
      }
    }
    ctx.edges.push({
      from: classId,
      to: `${LANGUAGE}:type:${baseName}`,
      relationship: Relationship.EXTENDS,
      evidence: evidence(b),
      meta: {
        base_type: baseName,
        access: access ?? "private", // C++ class default; orchestrator can override
        is_virtual: isVirtual,
        resolved: false,
      },
    });
  }
}

function handleField(
  node: SyntaxNode,
  ctx: WalkCtx,
  ownerQn: string,
  ownerId: string,
  access: AccessModifier,
): void {
  const declarator = node.childForFieldName("declarator");
  // tree-sitter-cpp uses `field_declaration` for both data members and
  // inline method declarations (`float area() const override;`). For
  // CPP-1 we only emit Field entities; member methods are deferred to
  // CPP-2 so the Field set stays clean.
  if (declarator && descendantOfType(declarator, "function_declarator")) {
    return;
  }
  const typeNode = node.childForFieldName("type");
  const { depth, innerName, isReference } = analyzePointer(declarator);
  const fieldName = innerName || declaratorName(declarator);
  if (!fieldName) return;
  // `ownerQn` is the fully-qualified owner (e.g. `engine::Shape`) so
  // two classes can have a `count` field without colliding.
  const qn = `${ownerQn}::${fieldName}`;
  const id = entityId(ctx.relPath, CodeEntityKind.Field, qn);
  const baseType = baseTypeName(typeNode);
  emitEntity(ctx, {
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
      access,
      is_reference: isReference,
    },
  }, /* ownedByFile */ false);
  ctx.edges.push({
    from: ownerId,
    to: id,
    relationship: Relationship.DECLARES_FIELD,
    evidence: evidence(node),
  });

  if (depth >= 1 && baseType) {
    const { isConst, isVolatile } = pointeeQualifiers(node);
    ctx.edges.push({
      from: id,
      to: `${LANGUAGE}:type:${baseType}`,
      relationship:
        depth === 1 ? Relationship.POINTS_TO : Relationship.POINTS_TO_POINTER,
      evidence: evidence(node),
      meta: {
        depth,
        base_type: baseType,
        is_const: isConst,
        is_volatile: isVolatile,
        is_reference: isReference,
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
  // tree-sitter-cpp wraps `enum class X` in the same `enum_specifier`
  // node, distinguishable by a `class` / `struct` keyword child. We
  // record the scoped flag in attrs for downstream consumers.
  const body = node.childForFieldName("body");
  if (!body) return;
  const name = specifierName(node) || nameOverride || "";
  if (!name) return;
  const qn = qualify(ctx, name);
  const isScoped = node.text.startsWith("enum class") ||
    node.text.startsWith("enum struct");
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
    attrs: { is_scoped: isScoped },
  });

  for (let i = 0; i < body.namedChildCount; i++) {
    const child = body.namedChild(i);
    if (!child || child.type !== "enumerator") continue;
    const memberName = nodeText(child.childForFieldName("name"));
    if (!memberName) continue;
    const memQn = `${qn}::${memberName}`;
    const memId = entityId(ctx.relPath, CodeEntityKind.EnumMember, memQn);
    emitEntity(ctx, {
      id: memId,
      kind: CodeEntityKind.EnumMember,
      name: memberName,
      qualifiedName: memQn,
      language: LANGUAGE,
      relPath: ctx.relPath,
      line: child.startPosition.row + 1,
      column: child.startPosition.column + 1,
    }, /* ownedByFile */ false);
    ctx.edges.push({
      from: id,
      to: memId,
      relationship: Relationship.DECLARES_ENUM_MEMBER,
      evidence: evidence(child),
    });
  }
}

function handleTypedef(node: SyntaxNode, ctx: WalkCtx): void {
  let aliasName = "";
  for (let i = node.namedChildCount - 1; i >= 0; i--) {
    const child = node.namedChild(i);
    if (!child) continue;
    const candidate = declaratorName(child);
    if (candidate) { aliasName = candidate; break; }
  }
  if (!aliasName) return;
  const qn = qualify(ctx, aliasName);
  const id = entityId(ctx.relPath, CodeEntityKind.TypeAlias, qn);
  emitEntity(ctx, {
    id,
    kind: CodeEntityKind.TypeAlias,
    name: aliasName,
    qualifiedName: qn,
    language: LANGUAGE,
    relPath: ctx.relPath,
    line: node.startPosition.row + 1,
    column: node.startPosition.column + 1,
    attrs: { aliased_text: node.text },
  });
}

function handleFunctionDefinition(node: SyntaxNode, ctx: WalkCtx): void {
  // CPP-2: an out-of-line member definition has a function_declarator
  // whose inner declarator is a qualified_identifier. Detect that first
  // so we route it through the member-callable path instead of the
  // free-function path (which would lose the owner chain).
  if (tryEmitOutOfLineMember(node, ctx, /* is_definition */ true)) return;

  const declarator = node.childForFieldName("declarator");
  const fnName = declaratorName(declarator);
  if (!fnName) return;
  const qn = qualify(ctx, fnName);
  const id = entityId(ctx.relPath, CodeEntityKind.Function, qn);
  emitEntity(ctx, {
    id,
    kind: CodeEntityKind.Function,
    name: fnName,
    qualifiedName: qn,
    language: LANGUAGE,
    relPath: ctx.relPath,
    line: node.startPosition.row + 1,
    column: node.startPosition.column + 1,
    attrs: { is_definition: true },
  });
}

function handleDeclaration(node: SyntaxNode, ctx: WalkCtx): void {
  // CPP-2: an out-of-line member declaration (a forward declaration of
  // a member with qualifier) routes through the member-callable path.
  if (tryEmitOutOfLineMember(node, ctx, /* is_definition */ false)) return;

  const declarator = node.childForFieldName("declarator");
  if (!declarator) return;
  const isFunction =
    declarator.type === "function_declarator" ||
    descendantOfType(declarator, "function_declarator") !== null;
  if (!isFunction) return;
  const fnName = declaratorName(declarator);
  if (!fnName) return;
  const qn = qualify(ctx, fnName);
  const id = entityId(ctx.relPath, CodeEntityKind.Function, qn);
  emitEntity(ctx, {
    id,
    kind: CodeEntityKind.Function,
    name: fnName,
    qualifiedName: qn,
    language: LANGUAGE,
    relPath: ctx.relPath,
    line: node.startPosition.row + 1,
    column: node.startPosition.column + 1,
    attrs: { is_definition: false },
  });
}

/**
 * Emit a Method/Constructor/Destructor entity for a class member
 * callable. Used by three call sites: in-class field_declaration
 * (declaration form for ctors/dtors), inline definitions in the class
 * body, and out-of-line definitions whose declarator is a
 * `qualified_identifier`.
 *
 * `enclosingClass` is the unqualified class name when we're inside a
 * class body; undefined when we're emitting an out-of-line definition
 * and the owner is read from the declarator chain.
 *
 * Entity ids include the source line so overloaded ctors / methods
 * don't collide on identity.
 */
function emitMemberCallable(
  node: SyntaxNode,
  ctx: WalkCtx,
  funcDecl: SyntaxNode,
  isDefinition: boolean,
  enclosingClass: string | undefined,
): void {
  const inner = funcDecl.childForFieldName("declarator");
  if (!inner) return;
  const chain = unfoldName(inner);
  if (chain.length === 0) return;
  const { kind, methodName } = classifyMember(chain, enclosingClass);

  // Build the fully-qualified method name. If the declarator chain
  // already carries the owner path (out-of-line case), use it verbatim
  // \u2014 it may be either "Class::method" (when the def lives inside the
  // namespace block) or "ns::Class::method" (when fully qualified
  // outside any namespace). Otherwise (in-class case) we qualify with
  // the current namespace stack which includes the class.
  let qn: string;
  if (chain.length > 1) {
    qn = chain.join("::");
    // If the chain is relative (e.g. ["Shape", "Shape"]) and we're
    // inside a namespace block, prepend the namespace stack minus the
    // segments that already appear at the head of the chain.
    const nsPrefix = ctx.namespaceStack.join("::");
    if (nsPrefix && !qn.startsWith(nsPrefix + "::") && qn !== nsPrefix) {
      // Only prepend the namespace prefix if the chain isn't already
      // anchored at a namespace we know about. Cheap heuristic: if the
      // first chain segment is the same as the deepest namespace, we
      // assume the chain is already absolute.
      const top = ctx.namespaceStack[ctx.namespaceStack.length - 1];
      if (top !== chain[0]) {
        qn = `${nsPrefix}::${qn}`;
      } else {
        // chain head equals deepest namespace \u2014 prepend the rest.
        const rest = ctx.namespaceStack.slice(0, -1).join("::");
        qn = rest ? `${rest}::${qn}` : qn;
      }
    }
  } else {
    qn = qualify(ctx, chain[0]!);
  }

  const line = node.startPosition.row + 1;
  const column = node.startPosition.column + 1;
  const id = `${LANGUAGE}:${ctx.relPath}#${kind}:${qn}@${line}`;
  emitEntity(ctx, {
    id,
    kind,
    name: methodName,
    qualifiedName: qn,
    language: LANGUAGE,
    relPath: ctx.relPath,
    line,
    column,
    attrs: { is_definition: isDefinition },
  });
}

/**
 * Detect an out-of-line member definition or declaration. Returns true
 * if the node was handled as a member, in which case the free-function
 * path must NOT also emit it. Returns false otherwise.
 */
function tryEmitOutOfLineMember(
  node: SyntaxNode,
  ctx: WalkCtx,
  isDefinition: boolean,
): boolean {
  const declarator = node.childForFieldName("declarator");
  if (!declarator) return false;
  const funcDecl = declarator.type === "function_declarator"
    ? declarator
    : descendantOfType(declarator, "function_declarator");
  if (!funcDecl) return false;
  const inner = funcDecl.childForFieldName("declarator");
  if (!inner) return false;
  if (inner.type !== "qualified_identifier") return false;
  emitMemberCallable(node, ctx, funcDecl, isDefinition, undefined);
  return true;
}

/**
 * Class-body member callable. Handles three node shapes:
 *   - `field_declaration` with function_declarator \u2192 in-class method
 *     declaration (no body) or pure-virtual.
 *   - `declaration` with function_declarator named after the enclosing
 *     class \u2192 constructor; or with destructor_name \u2192 destructor.
 *   - `function_definition` \u2192 inline body, is_definition=true.
 */
function handleClassBodyCallable(
  node: SyntaxNode,
  ctx: WalkCtx,
  enclosingClass: string,
): void {
  const declarator = node.childForFieldName("declarator");
  if (!declarator) return;
  const funcDecl = declarator.type === "function_declarator"
    ? declarator
    : descendantOfType(declarator, "function_declarator");
  if (!funcDecl) return;
  const isDef = node.type === "function_definition";
  emitMemberCallable(node, ctx, funcDecl, isDef, enclosingClass);
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
  const pathNode = node.childForFieldName("path");
  if (!pathNode) return;
  const raw = pathNode.text;
  const stripped = raw.replace(/^[<"]/, "").replace(/[>"]$/, "");
  const isSystem = raw.startsWith("<");
  ctx.edges.push({
    from: ctx.fileEntityId,
    to: `${LANGUAGE}:include:${stripped}`,
    relationship: Relationship.INCLUDES,
    evidence: evidence(node),
    meta: { path: stripped, system: isSystem },
  });
}

// ---------------------------------------------------------------------------
// Generic helpers + walker
// ---------------------------------------------------------------------------

function findChildOfType(node: SyntaxNode, type: string): SyntaxNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c && c.type === type) return c;
  }
  return null;
}

function walkBody(root: SyntaxNode, ctx: WalkCtx): void {
  for (let i = 0; i < root.namedChildCount; i++) {
    const child = root.namedChild(i);
    if (!child) continue;
    dispatch(child, ctx);
  }
}

function dispatch(child: SyntaxNode, ctx: WalkCtx): void {
  switch (child.type) {
    case "namespace_definition":
      handleNamespace(child, ctx);
      break;
    case "class_specifier":
      handleClassLike(child, ctx, CodeEntityKind.Class, "private");
      break;
    case "struct_specifier":
      handleClassLike(child, ctx, CodeEntityKind.Struct, "public");
      break;
    case "union_specifier":
      handleClassLike(child, ctx, CodeEntityKind.Union, "public");
      break;
    case "enum_specifier":
      handleEnum(child, ctx);
      break;
    case "type_definition":
      handleTypedef(child, ctx);
      // Inner specifier may carry a body; recurse.
      for (let j = 0; j < child.namedChildCount; j++) {
        const inner = child.namedChild(j);
        if (!inner) continue;
        if (inner.type === "class_specifier") {
          handleClassLike(inner, ctx, CodeEntityKind.Class, "private");
        } else if (inner.type === "struct_specifier") {
          handleClassLike(inner, ctx, CodeEntityKind.Struct, "public");
        } else if (inner.type === "union_specifier") {
          handleClassLike(inner, ctx, CodeEntityKind.Union, "public");
        } else if (inner.type === "enum_specifier") {
          handleEnum(inner, ctx);
        }
      }
      break;
    case "function_definition":
      handleFunctionDefinition(child, ctx);
      break;
    case "declaration":
      handleDeclaration(child, ctx);
      for (let j = 0; j < child.namedChildCount; j++) {
        const inner = child.namedChild(j);
        if (!inner) continue;
        if (inner.type === "class_specifier") {
          handleClassLike(inner, ctx, CodeEntityKind.Class, "private");
        } else if (inner.type === "struct_specifier") {
          handleClassLike(inner, ctx, CodeEntityKind.Struct, "public");
        } else if (inner.type === "union_specifier") {
          handleClassLike(inner, ctx, CodeEntityKind.Union, "public");
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
    case "preproc_if":
    case "preproc_ifdef":
    case "preproc_else":
    case "preproc_elif":
    case "linkage_specification":
      // extern "C" { ... } and conditional blocks contain nested
      // top-level entities; recurse without changing namespace context.
      walkBody(child, ctx);
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Extractor
// ---------------------------------------------------------------------------

export const cppExtractor: Extractor = {
  name: NAME,
  version: VERSION,
  extensions: EXTENSIONS,
  parserBacked: true,
  async extract(file: ExtractFileInput): Promise<ExtractorOutput> {
    const parser = await getParser("cpp");
    const tree = parser.parse(file.source);
    const root = tree.rootNode;

    const isHeader = HEADER_EXTS.has(file.ext.toLowerCase());
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
      namespaceStack: [],
    };

    if (root.hasError()) {
      ctx.diagnostics.push({
        severity: "warning",
        relPath: file.relPath,
        message: "tree-sitter reported parse errors; extraction proceeded best-effort",
      });
    }

    walkBody(root, ctx);

    return {
      entities: ctx.entities,
      edges: ctx.edges,
      shapes: [],
      diagnostics: ctx.diagnostics,
    };
  },
};
