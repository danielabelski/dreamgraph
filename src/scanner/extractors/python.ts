/**
 * DreamGraph — Python language extractor (wave 3, phases PY-1..PY-3).
 *
 * Helmet disclaimer (per coding-rules): Python is dynamically typed.
 * PEP 484 type annotations are advisory hints only — a variable can be
 * `int` on line 5 and `str` on line 7 at runtime. Every shape edge
 * derived from a type annotation therefore sets `meta.from_annotation`
 * = true; consumers must treat those edges as hints, not contracts.
 * Field entities are still emitted regardless of annotation presence,
 * with `attrs.is_annotated` recording whether a type hint was given.
 *
 * PY-1: top-level items.
 *   - File-level identity: each `.py` file emits a Module entity. A
 *     file named `__init__.py` additionally emits a Package entity for
 *     the directory it lives in (Python's package-marker convention).
 *   - `import_statement` and `import_from_statement` → IMPORTS edges
 *     from the file entity. Mapping mirrors Kotlin/Java:
 *       * `import foo.bar`            → `python:use:foo.bar`
 *       * `import foo.bar as b`       → `python:use:foo.bar` + meta.alias
 *       * `from foo import Bar`       → `python:type:Bar`
 *       * `from foo import Bar as B`  → `python:type:Bar` + meta.alias
 *       * `from foo import *`         → `python:use:foo.*` + meta.wildcard
 *       * `from . import x`           → `python:use:.x` (relative)
 *       * `from __future__ import x`  → IMPORTS with meta.from_future
 *   - `class_definition` → Class entity. If the class extends
 *     `Protocol` (typing.Protocol) it is emitted as Interface instead.
 *     `ABC` / `ABCMeta` bases set `attrs.is_abstract = true` but the
 *     kind stays Class. Each base produces an EXTENDS or IMPLEMENTS
 *     edge (EXTENDS for the first non-Protocol base, IMPLEMENTS for
 *     additional bases — Python multiple inheritance is linearised
 *     but we keep the graph distinction simple).
 *   - Module-level `function_definition` → Function entity.
 *
 * PY-2: members and shapes.
 *   - Class-body `function_definition` → Method entity. A method
 *     literally named `__init__` becomes a Constructor entity instead.
 *     `async def` sets `attrs.is_async = true`.
 *   - Class-body annotated assignments (`name: T [= value]`) → Field
 *     entity with `attrs.is_annotated = true` and a shape edge
 *     (CONTAINS_MANY / MAPS_K_TO_V / MAY_CONTAIN / EMBEDS) tagged
 *     `meta.from_annotation = true`. ALL_CAPS-named annotated
 *     assignments additionally emit a Constant entity.
 *   - Class-body bare assignments (`name = value`) → Field entity
 *     with `attrs.is_annotated = false`. No shape edge — the type is
 *     genuinely unknown without runtime trace data.
 *   - `self.<name> = ...` inside `__init__` → Field entity with
 *     `attrs.is_self_assigned = true`. Only emitted if no class-body
 *     declaration with the same name already exists (avoid duplicates).
 *
 *   Type-shape classification (annotation-derived only):
 *     - `List[T]` / `list[T]` / `Sequence[T]` / `Iterable[T]` /
 *       `Set[T]` / `set[T]` / `FrozenSet[T]` / `Tuple[T, ...]` /
 *       `tuple[T, ...]`           → CONTAINS_MANY (via "list"/...)
 *     - `Dict[K,V]` / `dict[K,V]` / `Mapping[K,V]` /
 *       `MutableMapping[K,V]`     → MAPS_K_TO_V, meta.key_type=K
 *     - `Optional[T]` /
 *       `Union[T, None]`          → MAY_CONTAIN via "optional"
 *     - bare user type `T`        → EMBEDS via "value"
 *     - `T | None` (PEP 604)      → MAY_CONTAIN via "optional"
 *
 *   Nullability: a type annotated as `Optional[T]`, `Union[T, None]`,
 *   or `T | None` sets `attrs.is_nullable = true` on the Field and
 *   `meta.is_nullable = true` on the shape edge. Untyped fields do
 *   NOT carry a nullability signal — unknown ≠ nullable.
 *
 * PY-3: decorators and protocols.
 *   - Any `decorator` on a `decorated_definition` → HAS_ANNOTATION
 *     edge from the inner entity to `python:type:DecoratorName`. The
 *     decorator's invocation arguments are dropped (we record presence,
 *     not call shape). Recognised decorators also set entity attrs:
 *       * `@dataclass` (or `@dataclasses.dataclass`) → is_dataclass
 *       * `@classmethod`                              → is_classmethod
 *       * `@staticmethod`                             → is_staticmethod
 *       * `@property`                                 → is_property
 *       * `@abstractmethod` /
 *         `@abc.abstractmethod`                       → is_abstract
 *   - A class inheriting from `Protocol` (or `typing.Protocol`) →
 *     emitted as Interface with `attrs.is_protocol = true`. Methods
 *     inside a Protocol class are implicitly abstract.
 *   - A class inheriting from `Enum`, `IntEnum`, `StrEnum`, `Flag` →
 *     emitted as Enum. Class-body assignments inside become EnumMember
 *     entities.
 *
 * Coherence note (see polyglot intermediate-layer audit): every Field
 * entity carries `attrs.owner_qualified_name` so the bridge's
 * `indexEntities` buckets fields onto their owning type without
 * relying on substring parsing of the field's qualifiedName.
 *
 * Identity & qualified names:
 *   - Effective module package = `dirParts.join(".")` (e.g. file
 *     `src/myapp/users.py` → package `src.myapp`; configurable
 *     trimming is out of scope for this wave).
 *   - Module qn = `${pkg}.${stem}` (or just `${stem}` if no dirs).
 *   - For `__init__.py`: Package qn = `${pkg}` (and the file is also
 *     a Module entity with qn = `${pkg}.__init__` so source-file
 *     line/column references stay attached to a real entity).
 *   - Top-level class `Foo` in module `pkg.users` → qn `pkg.users.Foo`.
 *   - Method `m` of class `Foo` → qn `pkg.users.Foo.m`.
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

const NAME = "python";
const VERSION = "0.1.0";
const LANGUAGE = "python";
const EXTENSIONS: readonly string[] = [".py", ".pyi"];

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

function isAllCaps(name: string): boolean {
  if (!name) return false;
  return /^[A-Z_][A-Z0-9_]*$/.test(name) && /[A-Z]/.test(name);
}

// ---------------------------------------------------------------------------
// Module-path resolution
// ---------------------------------------------------------------------------

interface ModuleIdentity {
  packageQn: string;       // dotted dir path (may be empty)
  moduleQn: string;        // dotted full module qn (always non-empty)
  isInit: boolean;         // file is __init__.py
  stem: string;            // filename without extension
}

function deriveModuleIdentity(file: ExtractFileInput): ModuleIdentity {
  const stem = file.name.replace(/\.(py|pyi)$/i, "");
  const pkg = file.dirParts.join(".");
  const isInit = stem === "__init__";
  // For __init__.py, the package qn IS the directory path. We still
  // emit a Module entity for the file itself so source-attached
  // entities have a stable owner; module qn = pkg.__init__.
  const moduleQn = pkg ? `${pkg}.${stem}` : stem;
  return { packageQn: pkg, moduleQn, isInit, stem };
}

// ---------------------------------------------------------------------------
// Type-shape vocabulary
// ---------------------------------------------------------------------------

/**
 * Map of bare type-name → (relationship, via) for collection-like
 * annotations. Both `typing.List` and the lowercase builtin alias
 * `list` (PEP 585) resolve to the same shape. Mapping types and
 * Optional/Union live in their own tables below.
 */
const COLLECTION_VIAS: Record<string, string> = {
  List: "list",
  list: "list",
  Sequence: "sequence",
  Iterable: "iterable",
  Iterator: "iterator",
  Collection: "collection",
  MutableSequence: "mutable_sequence",
  Tuple: "tuple",
  tuple: "tuple",
  Set: "set",
  set: "set",
  FrozenSet: "frozen_set",
  frozenset: "frozen_set",
  MutableSet: "mutable_set",
};

const MAP_VIAS: Record<string, string> = {
  Dict: "map",
  dict: "map",
  Mapping: "mapping",
  MutableMapping: "mutable_mapping",
  DefaultDict: "default_dict",
  OrderedDict: "ordered_dict",
};

const OPTIONAL_VIAS: Record<string, string> = {
  Optional: "optional",
};

// ---------------------------------------------------------------------------
// Type classification (annotation → shape edge)
// ---------------------------------------------------------------------------

interface TypeShape {
  /** Bare head type name (e.g. "User" for `List[User]`, "List" for `List`). */
  baseType: string;
  /** Generic type arguments unwrapped one level (e.g. ["User"] for `List[User]`). */
  typeArgs: string[];
  /** Annotation marked nullable (Optional[T], T | None, Union[T, None]). */
  isNullable: boolean;
  /** Original head before nullability/union unwrap; used to pick relationship. */
  rawHead: string;
}

function classifyType(typeNode: SyntaxNode | null): TypeShape | null {
  if (!typeNode) return null;
  // `type` wraps an inner expression — descend into it.
  let inner: SyntaxNode | null = typeNode;
  if (typeNode.type === "type") {
    inner = typeNode.namedChild(0);
  }
  if (!inner) return null;

  // PEP 604 union: `T | None` shows up as `binary_operator(|)` inside `type`.
  if (inner.type === "binary_operator") {
    return classifyUnion(unwrapBinaryUnion(inner));
  }

  // Bare identifier — e.g. `int`, `User`.
  if (inner.type === "identifier") {
    return { baseType: inner.text, typeArgs: [], isNullable: false, rawHead: inner.text };
  }

  // Attribute access — e.g. `typing.List` or `decimal.Decimal`.
  if (inner.type === "attribute") {
    const head = lastDotSegment(inner.text);
    return { baseType: head, typeArgs: [], isNullable: false, rawHead: head };
  }

  // String forward reference — `"User"` or `'User'`.
  if (inner.type === "string") {
    const stripped = inner.text.replace(/^['"]|['"]$/g, "").trim();
    if (stripped) {
      return { baseType: lastDotSegment(stripped), typeArgs: [], isNullable: false, rawHead: stripped };
    }
    return null;
  }

  // Subscript-based generic: `List[User]`, `Dict[str, int]`, `Optional[User]`.
  if (inner.type === "generic_type" || inner.type === "subscript") {
    return classifyGeneric(inner);
  }

  // `None` literal annotation.
  if (inner.type === "none") {
    return { baseType: "None", typeArgs: [], isNullable: true, rawHead: "None" };
  }

  return null;
}

function classifyGeneric(node: SyntaxNode): TypeShape | null {
  // Head identifier.
  let head = "";
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (!c) continue;
    if (c.type === "identifier") { head = c.text; break; }
    if (c.type === "attribute") { head = lastDotSegment(c.text); break; }
  }
  if (!head) return null;

  const args = collectGenericArgs(node);

  // Optional[T] → nullable wrapper of T.
  if (head in OPTIONAL_VIAS && args.length >= 1) {
    return {
      baseType: args[0]!,
      typeArgs: args.slice(1),
      isNullable: true,
      rawHead: head,
    };
  }

  // Union[A, B, None] → nullable if None present; surface first non-None.
  if (head === "Union") {
    const filtered = args.filter((a) => a !== "None" && a !== "NoneType");
    const hasNone = filtered.length !== args.length;
    if (filtered.length >= 1) {
      return {
        baseType: filtered[0]!,
        typeArgs: filtered.slice(1),
        isNullable: hasNone,
        rawHead: head,
      };
    }
    return { baseType: "None", typeArgs: [], isNullable: true, rawHead: head };
  }

  return { baseType: head, typeArgs: args, isNullable: false, rawHead: head };
}

function collectGenericArgs(genericNode: SyntaxNode): string[] {
  const out: string[] = [];
  // Locate the type_parameter container (or look for `type` children directly).
  const tp = namedChildOfKind(genericNode, new Set(["type_parameter"]));
  const container = tp ?? genericNode;
  for (let i = 0; i < container.namedChildCount; i++) {
    const c = container.namedChild(i);
    if (!c) continue;
    if (c.type === "type" || c.type === "identifier" || c.type === "generic_type" ||
        c.type === "subscript" || c.type === "attribute" || c.type === "string" ||
        c.type === "binary_operator" || c.type === "none") {
      const sub = classifyType(c.type === "type" ? c : wrapAsType(c));
      if (sub) out.push(sub.baseType);
    }
  }
  return out;
}

function wrapAsType(node: SyntaxNode): SyntaxNode {
  // classifyType handles a `type` wrapper or any direct expression; we
  // pass the node through unchanged when it's already an expression.
  return node;
}

function unwrapBinaryUnion(node: SyntaxNode): SyntaxNode[] {
  // Flatten left-associative `a | b | c` chains.
  const out: SyntaxNode[] = [];
  function visit(n: SyntaxNode): void {
    if (n.type === "binary_operator") {
      // Children include left expr, operator, right expr (anonymous '|').
      const left = n.namedChild(0);
      const right = n.namedChild(1);
      if (left) visit(left);
      if (right) visit(right);
      return;
    }
    out.push(n);
  }
  visit(node);
  return out;
}

function classifyUnion(parts: SyntaxNode[]): TypeShape | null {
  const classified: TypeShape[] = [];
  let hasNone = false;
  for (const p of parts) {
    const c = classifyType(p);
    if (!c) continue;
    if (c.baseType === "None" || c.rawHead === "None") {
      hasNone = true;
      continue;
    }
    classified.push(c);
  }
  if (classified.length === 0) {
    return { baseType: "None", typeArgs: [], isNullable: true, rawHead: "|" };
  }
  const first = classified[0]!;
  return {
    baseType: first.baseType,
    typeArgs: first.typeArgs,
    isNullable: hasNone || first.isNullable,
    rawHead: first.rawHead,
  };
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
  /** Dotted qn prefix; "" at module-level, "Foo" inside class Foo. */
  typePrefix: string;
  /** Module's full qualified name (e.g. "pkg.users"). */
  moduleQn: string;
  /** Names already emitted as Field/Constant on the current owner qn — keyed `${ownerQn}#${name}`. */
  emittedMembers: Set<string>;
}

// ---------------------------------------------------------------------------
// Decorator handling
// ---------------------------------------------------------------------------

interface DecoratorRef {
  /** Display name as written, e.g. "dataclass" or "abc.abstractmethod". */
  fullName: string;
  /** Last dot-segment, used for matching well-known decorators and as the placeholder target. */
  shortName: string;
  /** The decorator node (for evidence). */
  node: SyntaxNode;
}

function readDecorators(decorated: SyntaxNode): DecoratorRef[] {
  const out: DecoratorRef[] = [];
  for (let i = 0; i < decorated.namedChildCount; i++) {
    const c = decorated.namedChild(i);
    if (!c || c.type !== "decorator") continue;
    // A decorator's named children are typically: identifier | attribute | call.
    let full = "";
    for (let j = 0; j < c.namedChildCount; j++) {
      const k = c.namedChild(j);
      if (!k) continue;
      if (k.type === "identifier" || k.type === "attribute") {
        full = k.text;
        break;
      }
      if (k.type === "call") {
        const fn = k.namedChild(0);
        if (fn) full = fn.text;
        break;
      }
    }
    if (!full) continue;
    out.push({ fullName: full, shortName: lastDotSegment(full), node: c });
  }
  return out;
}

function applyDecoratorAttrs(
  decorators: readonly DecoratorRef[],
  attrs: Record<string, unknown>,
): void {
  for (const d of decorators) {
    switch (d.shortName) {
      case "dataclass": attrs.is_dataclass = true; break;
      case "classmethod": attrs.is_classmethod = true; break;
      case "staticmethod": attrs.is_staticmethod = true; break;
      case "property": attrs.is_property = true; break;
      case "abstractmethod": attrs.is_abstract = true; break;
    }
  }
}

function emitDecoratorEdges(
  ctx: WalkCtx,
  decorators: readonly DecoratorRef[],
  fromEntityId: string,
): void {
  for (const d of decorators) {
    ctx.edges.push({
      from: fromEntityId,
      to: `${LANGUAGE}:type:${d.shortName}`,
      relationship: Relationship.HAS_ANNOTATION,
      evidence: evidence(d.node),
      meta: {
        via: "decorator",
        base_type: d.shortName,
        decorator_name: d.fullName,
        resolved: false,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

function handleImportStatement(node: SyntaxNode, ctx: WalkCtx): void {
  // `import_statement` → children are `dotted_name` or `aliased_import`.
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (!c) continue;
    if (c.type === "dotted_name") {
      ctx.edges.push({
        from: ctx.fileEntityId,
        to: `${LANGUAGE}:use:${c.text}`,
        relationship: Relationship.IMPORTS,
        evidence: evidence(c),
        meta: { kind: "module" },
      });
    } else if (c.type === "aliased_import") {
      const dotted = namedChildOfKind(c, new Set(["dotted_name"]));
      const aliasIds = namedChildrenOfKind(c, new Set(["identifier"]));
      const alias = aliasIds.length > 0 ? aliasIds[aliasIds.length - 1]!.text : "";
      const path = dotted ? dotted.text : "";
      if (path) {
        ctx.edges.push({
          from: ctx.fileEntityId,
          to: `${LANGUAGE}:use:${path}`,
          relationship: Relationship.IMPORTS,
          evidence: evidence(c),
          meta: { kind: "module", alias },
        });
      }
    }
  }
}

function handleImportFromStatement(node: SyntaxNode, ctx: WalkCtx): void {
  // First named child is the source: `dotted_name` or `relative_import`.
  // Following named children are imported items: `dotted_name`, `aliased_import`, or `wildcard_import`.
  let sourcePath = "";
  let isRelative = false;
  const items: SyntaxNode[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (!c) continue;
    if (i === 0) {
      if (c.type === "dotted_name") sourcePath = c.text;
      else if (c.type === "relative_import") { sourcePath = c.text; isRelative = true; }
      else items.push(c);
      continue;
    }
    items.push(c);
  }

  const isFuture = sourcePath === "__future__";

  for (const it of items) {
    if (it.type === "wildcard_import") {
      ctx.edges.push({
        from: ctx.fileEntityId,
        to: `${LANGUAGE}:use:${sourcePath}.*`,
        relationship: Relationship.IMPORTS,
        evidence: evidence(it),
        meta: {
          kind: "module",
          wildcard: true,
          source: sourcePath,
          relative: isRelative,
          ...(isFuture ? { from_future: true } : {}),
        },
      });
      continue;
    }
    if (it.type === "dotted_name") {
      ctx.edges.push({
        from: ctx.fileEntityId,
        to: `${LANGUAGE}:type:${lastDotSegment(it.text)}`,
        relationship: Relationship.IMPORTS,
        evidence: evidence(it),
        meta: {
          kind: "symbol",
          source: sourcePath,
          imported: it.text,
          relative: isRelative,
          ...(isFuture ? { from_future: true } : {}),
        },
      });
      continue;
    }
    if (it.type === "aliased_import") {
      const dotted = namedChildOfKind(it, new Set(["dotted_name"]));
      const idents = namedChildrenOfKind(it, new Set(["identifier"]));
      const alias = idents.length > 0 ? idents[idents.length - 1]!.text : "";
      const imported = dotted ? dotted.text : "";
      if (imported) {
        ctx.edges.push({
          from: ctx.fileEntityId,
          to: `${LANGUAGE}:type:${lastDotSegment(imported)}`,
          relationship: Relationship.IMPORTS,
          evidence: evidence(it),
          meta: {
            kind: "symbol",
            source: sourcePath,
            imported,
            alias,
            relative: isRelative,
            ...(isFuture ? { from_future: true } : {}),
          },
        });
      }
    }
  }
}

function handleFutureImport(node: SyntaxNode, ctx: WalkCtx): void {
  // `future_import_statement` → from __future__ import <dotted_name>(s).
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (!c || c.type !== "dotted_name") continue;
    ctx.edges.push({
      from: ctx.fileEntityId,
      to: `${LANGUAGE}:type:${c.text}`,
      relationship: Relationship.IMPORTS,
      evidence: evidence(c),
      meta: {
        kind: "symbol",
        source: "__future__",
        imported: c.text,
        from_future: true,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Class handling
// ---------------------------------------------------------------------------

interface ClassBaseInfo {
  /** Bare last-segment name, e.g. "Protocol" for "typing.Protocol". */
  shortName: string;
  /** Full text as written. */
  fullName: string;
  node: SyntaxNode;
}

function readClassBases(classDef: SyntaxNode): ClassBaseInfo[] {
  const argList = namedChildOfKind(classDef, new Set(["argument_list"]));
  if (!argList) return [];
  const out: ClassBaseInfo[] = [];
  for (let i = 0; i < argList.namedChildCount; i++) {
    const c = argList.namedChild(i);
    if (!c) continue;
    // Skip keyword arguments (e.g. `metaclass=...`).
    if (c.type === "keyword_argument") continue;
    if (c.type === "identifier" || c.type === "attribute") {
      out.push({ shortName: lastDotSegment(c.text), fullName: c.text, node: c });
    } else if (c.type === "generic_type" || c.type === "subscript") {
      // `Repository[User]` base — use head.
      const headNode = c.namedChild(0);
      if (headNode) {
        out.push({
          shortName: lastDotSegment(headNode.text),
          fullName: headNode.text,
          node: c,
        });
      }
    }
  }
  return out;
}

const PROTOCOL_BASE_NAMES = new Set(["Protocol"]);
const ABSTRACT_BASE_NAMES = new Set(["ABC", "ABCMeta"]);
const ENUM_BASE_NAMES = new Set(["Enum", "IntEnum", "StrEnum", "Flag", "IntFlag"]);

interface ClassClassification {
  kind: "Class" | "Interface" | "Enum";
  isProtocol: boolean;
  isAbstract: boolean;
  isEnum: boolean;
}

function classifyClass(bases: readonly ClassBaseInfo[]): ClassClassification {
  let isProtocol = false;
  let isAbstract = false;
  let isEnum = false;
  for (const b of bases) {
    if (PROTOCOL_BASE_NAMES.has(b.shortName)) isProtocol = true;
    if (ABSTRACT_BASE_NAMES.has(b.shortName)) isAbstract = true;
    if (ENUM_BASE_NAMES.has(b.shortName)) isEnum = true;
  }
  if (isEnum) return { kind: "Enum", isProtocol, isAbstract, isEnum };
  if (isProtocol) return { kind: "Interface", isProtocol, isAbstract, isEnum };
  return { kind: "Class", isProtocol, isAbstract, isEnum };
}

function handleClassDefinition(
  classDef: SyntaxNode,
  ctx: WalkCtx,
  decorators: readonly DecoratorRef[],
): void {
  const nameNode = namedChildOfKind(classDef, new Set(["identifier"]));
  if (!nameNode) return;
  const name = nameNode.text;
  const ownerQn = joinQn(ctx.typePrefix || ctx.moduleQn, name);
  const bases = readClassBases(classDef);
  const cls = classifyClass(bases);

  const attrs: Record<string, unknown> = {};
  if (cls.isProtocol) attrs.is_protocol = true;
  if (cls.isAbstract) attrs.is_abstract = true;
  applyDecoratorAttrs(decorators, attrs);

  const entity: ExtractedEntity = {
    id: entityId(ctx.relPath, cls.kind, ownerQn),
    kind: cls.kind,
    name,
    qualifiedName: ownerQn,
    language: LANGUAGE,
    relPath: ctx.relPath,
    line: nameNode.startPosition.row + 1,
    column: nameNode.startPosition.column + 1,
    attrs,
  };
  ctx.entities.push(entity);

  emitDecoratorEdges(ctx, decorators, entity.id);

  // Base-class edges.
  for (let i = 0; i < bases.length; i++) {
    const b = bases[i]!;
    // Skip Protocol/ABC base relationships — they're metadata, not inheritance edges.
    if (PROTOCOL_BASE_NAMES.has(b.shortName)) continue;
    if (ABSTRACT_BASE_NAMES.has(b.shortName)) continue;
    if (ENUM_BASE_NAMES.has(b.shortName)) continue;
    // First non-meta base = EXTENDS; further bases = IMPLEMENTS (mixin-like).
    const isFirst = i === 0 ||
      bases.slice(0, i).every((x) =>
        PROTOCOL_BASE_NAMES.has(x.shortName) ||
        ABSTRACT_BASE_NAMES.has(x.shortName) ||
        ENUM_BASE_NAMES.has(x.shortName));
    ctx.edges.push({
      from: entity.id,
      to: `${LANGUAGE}:type:${b.shortName}`,
      relationship: isFirst ? Relationship.EXTENDS : Relationship.IMPLEMENTS,
      evidence: evidence(b.node),
      meta: { via: isFirst ? "inheritance" : "mixin", base_type: b.shortName, base_name: b.fullName, resolved: false },
    });
  }

  // Walk class body.
  const body = namedChildOfKind(classDef, new Set(["block"]));
  if (!body) return;

  const childCtx: WalkCtx = {
    ...ctx,
    typePrefix: ownerQn,
    emittedMembers: new Set<string>(),
  };

  for (let i = 0; i < body.namedChildCount; i++) {
    const stmt = body.namedChild(i);
    if (!stmt) continue;
    handleClassBodyStatement(stmt, childCtx, ownerQn, cls);
  }
}

function handleClassBodyStatement(
  stmt: SyntaxNode,
  ctx: WalkCtx,
  ownerQn: string,
  cls: ClassClassification,
): void {
  if (stmt.type === "decorated_definition") {
    const decorators = readDecorators(stmt);
    const inner = namedChildOfKind(stmt, new Set(["class_definition", "function_definition"]));
    if (!inner) return;
    if (inner.type === "class_definition") {
      handleClassDefinition(inner, ctx, decorators);
    } else {
      handleFunctionDefinition(inner, ctx, ownerQn, cls, decorators);
    }
    return;
  }
  if (stmt.type === "class_definition") {
    handleClassDefinition(stmt, ctx, []);
    return;
  }
  if (stmt.type === "function_definition") {
    handleFunctionDefinition(stmt, ctx, ownerQn, cls, []);
    return;
  }
  if (stmt.type === "expression_statement") {
    const inner = stmt.namedChild(0);
    if (!inner) return;
    if (inner.type === "assignment") {
      handleClassBodyAssignment(inner, ctx, ownerQn, cls);
    }
    // bare string expression (docstring) → ignored.
    return;
  }
}

// ---------------------------------------------------------------------------
// Assignment handling (fields, constants, enum members)
// ---------------------------------------------------------------------------

function handleClassBodyAssignment(
  assign: SyntaxNode,
  ctx: WalkCtx,
  ownerQn: string,
  cls: ClassClassification,
): void {
  // Forms:
  //   identifier : type             (annotated, no value)
  //   identifier : type = value     (annotated with default)
  //   identifier = value            (bare; field with unknown type)
  const idNode = assign.namedChild(0);
  if (!idNode || idNode.type !== "identifier") return;
  const name = idNode.text;

  // Skip the `_` throwaway and dunder slots; those are not fields.
  if (name === "_") return;

  // Locate optional type annotation and value.
  let typeNode: SyntaxNode | null = null;
  let hasValue = false;
  for (let i = 1; i < assign.namedChildCount; i++) {
    const c = assign.namedChild(i);
    if (!c) continue;
    if (c.type === "type") { typeNode = c; continue; }
    hasValue = true;
  }

  // Enum classes treat every assignment as an EnumMember.
  if (cls.isEnum) {
    const memberQn = joinQn(ownerQn, name);
    ctx.entities.push({
      id: entityId(ctx.relPath, CodeEntityKind.EnumMember, memberQn),
      kind: CodeEntityKind.EnumMember,
      name,
      qualifiedName: memberQn,
      language: LANGUAGE,
      relPath: ctx.relPath,
      line: idNode.startPosition.row + 1,
      column: idNode.startPosition.column + 1,
      attrs: { owner_qualified_name: ownerQn },
    });
    ctx.emittedMembers.add(`${ownerQn}#${name}`);
    return;
  }

  emitFieldFromAssignment({
    ctx, ownerQn,
    name,
    typeNode,
    hasValue,
    anchor: idNode,
  });

  // ALL_CAPS module-style constants also surface as Constant entities.
  if (isAllCaps(name) && hasValue) {
    const constQn = joinQn(ownerQn, name);
    ctx.entities.push({
      id: entityId(ctx.relPath, CodeEntityKind.Constant, constQn),
      kind: CodeEntityKind.Constant,
      name,
      qualifiedName: constQn,
      language: LANGUAGE,
      relPath: ctx.relPath,
      line: idNode.startPosition.row + 1,
      column: idNode.startPosition.column + 1,
      attrs: {
        owner_qualified_name: ownerQn,
        is_annotated: typeNode !== null,
      },
    });
  }
}

function handleModuleBodyAssignment(assign: SyntaxNode, ctx: WalkCtx): void {
  // Module-level annotated or bare assignment.
  const idNode = assign.namedChild(0);
  if (!idNode || idNode.type !== "identifier") return;
  const name = idNode.text;
  if (name === "_") return;

  let typeNode: SyntaxNode | null = null;
  let hasValue = false;
  for (let i = 1; i < assign.namedChildCount; i++) {
    const c = assign.namedChild(i);
    if (!c) continue;
    if (c.type === "type") { typeNode = c; continue; }
    hasValue = true;
  }

  emitFieldFromAssignment({
    ctx,
    ownerQn: ctx.moduleQn,
    name,
    typeNode,
    hasValue,
    anchor: idNode,
  });

  if (isAllCaps(name) && hasValue) {
    const constQn = joinQn(ctx.moduleQn, name);
    ctx.entities.push({
      id: entityId(ctx.relPath, CodeEntityKind.Constant, constQn),
      kind: CodeEntityKind.Constant,
      name,
      qualifiedName: constQn,
      language: LANGUAGE,
      relPath: ctx.relPath,
      line: idNode.startPosition.row + 1,
      column: idNode.startPosition.column + 1,
      attrs: {
        owner_qualified_name: ctx.moduleQn,
        is_annotated: typeNode !== null,
      },
    });
  }
}

interface EmitFieldArgs {
  ctx: WalkCtx;
  ownerQn: string;
  name: string;
  typeNode: SyntaxNode | null;
  hasValue: boolean;
  anchor: SyntaxNode;
  isSelfAssigned?: boolean;
}

function emitFieldFromAssignment(args: EmitFieldArgs): void {
  const { ctx, ownerQn, name, typeNode, hasValue, anchor, isSelfAssigned } = args;
  const key = `${ownerQn}#${name}`;
  if (ctx.emittedMembers.has(key)) return;
  ctx.emittedMembers.add(key);

  const fieldQn = joinQn(ownerQn, name);
  const shape = classifyType(typeNode);

  const attrs: Record<string, unknown> = {
    owner_qualified_name: ownerQn,
    is_annotated: typeNode !== null,
    has_default: hasValue,
  };
  if (isSelfAssigned) attrs.is_self_assigned = true;
  if (shape) {
    attrs.type_text = nodeText(typeNode);
    if (shape.isNullable) attrs.is_nullable = true;
  }

  const fieldId = entityId(ctx.relPath, CodeEntityKind.Field, fieldQn);
  ctx.entities.push({
    id: fieldId,
    kind: CodeEntityKind.Field,
    name,
    qualifiedName: fieldQn,
    language: LANGUAGE,
    relPath: ctx.relPath,
    line: anchor.startPosition.row + 1,
    column: anchor.startPosition.column + 1,
    attrs,
  });

  if (shape) {
    emitShapeEdges(ctx, fieldId, shape, anchor);
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
  // Pick relationship + via based on the raw head (before nullability unwrap)
  // OR the unwrapped baseType if the head is just Optional/Union.
  // For Optional[List[User]] we want CONTAINS_MANY via=list (baseType=List).
  // For Optional[User] we want MAY_CONTAIN (baseType=User after unwrap).
  let rel: Relationship;
  let via: string;
  const head = shape.baseType;

  if (head in COLLECTION_VIAS) {
    rel = Relationship.CONTAINS_MANY;
    via = COLLECTION_VIAS[head]!;
    const elem = shape.typeArgs[0] ?? "";
    if (elem) {
      ctx.edges.push({
        from: fromId,
        to: `${LANGUAGE}:type:${elem}`,
        relationship: rel,
        evidence: evidence(anchor),
        meta: { via, base_type: elem, from_annotation: true, resolved: false, ...(shape.isNullable ? { is_nullable: true } : {}) },
      });
      return;
    }
    return;
  }

  if (head in MAP_VIAS) {
    rel = Relationship.MAPS_K_TO_V;
    via = MAP_VIAS[head]!;
    const k = shape.typeArgs[0] ?? "";
    const v = shape.typeArgs[1] ?? "";
    if (v) {
      ctx.edges.push({
        from: fromId,
        to: `${LANGUAGE}:type:${v}`,
        relationship: rel,
        evidence: evidence(anchor),
        meta: {
          via, base_type: v, from_annotation: true, resolved: false,
          ...(k ? { key_type: k } : {}),
          ...(shape.isNullable ? { is_nullable: true } : {}),
        },
      });
      // Secondary edge for the key type so it is also discoverable.
      if (k) {
        ctx.edges.push({
          from: fromId,
          to: `${LANGUAGE}:type:${k}`,
          relationship: Relationship.REFERENCES_TYPE,
          evidence: evidence(anchor),
          meta: { via: "map_key", base_type: k, from_annotation: true, resolved: false },
        });
      }
    }
    return;
  }

  // Nullable bare type → MAY_CONTAIN.
  if (shape.isNullable && head !== "None") {
    ctx.edges.push({
      from: fromId,
      to: `${LANGUAGE}:type:${head}`,
      relationship: Relationship.MAY_CONTAIN,
      evidence: evidence(anchor),
      meta: { via: "optional", base_type: head, from_annotation: true, is_nullable: true, resolved: false },
    });
    return;
  }

  // Skip primitive-like heads — they are not graph-meaningful.
  if (BUILTIN_TYPE_NAMES.has(head)) return;
  if (head === "None") return;

  ctx.edges.push({
    from: fromId,
    to: `${LANGUAGE}:type:${head}`,
    relationship: Relationship.EMBEDS,
    evidence: evidence(anchor),
    meta: { via: "value", base_type: head, from_annotation: true, resolved: false },
  });
}

const BUILTIN_TYPE_NAMES = new Set([
  "int", "float", "complex", "bool", "str", "bytes", "bytearray",
  "memoryview", "object", "type", "None", "NoneType", "Any", "Self",
]);

// ---------------------------------------------------------------------------
// Functions / methods / constructors
// ---------------------------------------------------------------------------

function handleFunctionDefinition(
  fnDef: SyntaxNode,
  ctx: WalkCtx,
  ownerQn: string | null,
  cls: ClassClassification | null,
  decorators: readonly DecoratorRef[],
): void {
  const nameNode = namedChildOfKind(fnDef, new Set(["identifier"]));
  if (!nameNode) return;
  const name = nameNode.text;
  const effectiveOwner = ownerQn ?? ctx.moduleQn;
  const qn = joinQn(effectiveOwner, name);
  const isAsync = isAsyncFunction(fnDef);

  let kind: CodeEntityKind;
  if (ownerQn === null) {
    kind = CodeEntityKind.Function;
  } else if (name === "__init__") {
    kind = CodeEntityKind.Constructor;
  } else {
    kind = CodeEntityKind.Method;
  }

  const attrs: Record<string, unknown> = {
    owner_qualified_name: ownerQn ?? ctx.moduleQn,
    is_top_level: ownerQn === null,
    is_async: isAsync,
  };
  applyDecoratorAttrs(decorators, attrs);
  if (cls?.isProtocol) attrs.is_abstract = true;

  const fnId = entityId(ctx.relPath, kind, qn);
  ctx.entities.push({
    id: fnId,
    kind,
    name,
    qualifiedName: qn,
    language: LANGUAGE,
    relPath: ctx.relPath,
    line: nameNode.startPosition.row + 1,
    column: nameNode.startPosition.column + 1,
    attrs,
  });
  emitDecoratorEdges(ctx, decorators, fnId);

  // For __init__ methods, scan the body for `self.x = ...` assignments so
  // we synthesise Field entities for attributes declared only in the ctor.
  if (name === "__init__" && ownerQn) {
    scanInitForSelfFields(fnDef, ctx, ownerQn);
  }
}

function isAsyncFunction(fnDef: SyntaxNode): boolean {
  for (let i = 0; i < fnDef.childCount; i++) {
    const c = fnDef.child(i);
    if (!c) continue;
    if (c.type === "async") return true;
  }
  return false;
}

function scanInitForSelfFields(fnDef: SyntaxNode, ctx: WalkCtx, ownerQn: string): void {
  const body = namedChildOfKind(fnDef, new Set(["block"]));
  if (!body) return;
  for (let i = 0; i < body.namedChildCount; i++) {
    const stmt = body.namedChild(i);
    if (!stmt || stmt.type !== "expression_statement") continue;
    const expr = stmt.namedChild(0);
    if (!expr || expr.type !== "assignment") continue;
    const lhs = expr.namedChild(0);
    if (!lhs || lhs.type !== "attribute") continue;
    // attribute: object . attribute
    const obj = lhs.namedChild(0);
    const attr = lhs.namedChild(1);
    if (!obj || !attr) continue;
    if (obj.type !== "identifier" || obj.text !== "self") continue;
    if (attr.type !== "identifier") continue;
    const name = attr.text;
    emitFieldFromAssignment({
      ctx, ownerQn, name,
      typeNode: null,
      hasValue: true,
      anchor: attr,
      isSelfAssigned: true,
    });
  }
}

// ---------------------------------------------------------------------------
// Top-level walk
// ---------------------------------------------------------------------------

function walkModule(root: SyntaxNode, ctx: WalkCtx): void {
  for (let i = 0; i < root.namedChildCount; i++) {
    const stmt = root.namedChild(i);
    if (!stmt) continue;
    switch (stmt.type) {
      case "future_import_statement":
        handleFutureImport(stmt, ctx);
        break;
      case "import_statement":
        handleImportStatement(stmt, ctx);
        break;
      case "import_from_statement":
        handleImportFromStatement(stmt, ctx);
        break;
      case "expression_statement": {
        const inner = stmt.namedChild(0);
        if (inner && inner.type === "assignment") {
          handleModuleBodyAssignment(inner, ctx);
        }
        // bare docstring / other expressions → ignored.
        break;
      }
      case "decorated_definition": {
        const decorators = readDecorators(stmt);
        const inner = namedChildOfKind(stmt, new Set(["class_definition", "function_definition"]));
        if (!inner) break;
        if (inner.type === "class_definition") {
          handleClassDefinition(inner, ctx, decorators);
        } else {
          handleFunctionDefinition(inner, ctx, null, null, decorators);
        }
        break;
      }
      case "class_definition":
        handleClassDefinition(stmt, ctx, []);
        break;
      case "function_definition":
        handleFunctionDefinition(stmt, ctx, null, null, []);
        break;
      default:
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// Extractor
// ---------------------------------------------------------------------------

export const pythonExtractor: Extractor = {
  name: NAME,
  version: VERSION,
  extensions: EXTENSIONS,
  parserBacked: true,
  async extract(file: ExtractFileInput): Promise<ExtractorOutput> {
    const parser = await getParser("python");
    const tree = parser.parse(file.source);
    const root = tree.rootNode;

    const ident = deriveModuleIdentity(file);
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

    // Module entity (always emitted, even for __init__.py — keeps an
    // owner for source-attached entities).
    entities.push({
      id: entityId(file.relPath, CodeEntityKind.Module, ident.moduleQn),
      kind: CodeEntityKind.Module,
      name: ident.stem,
      qualifiedName: ident.moduleQn,
      language: LANGUAGE,
      relPath: file.relPath,
      line: 1,
      column: 1,
      attrs: {
        package_qualified_name: ident.packageQn,
        is_init: ident.isInit,
      },
    });

    // Package entity, only for __init__.py files.
    if (ident.isInit) {
      const pkgQn = ident.packageQn || ident.stem;
      entities.push({
        id: entityId(file.relPath, CodeEntityKind.Package, pkgQn),
        kind: CodeEntityKind.Package,
        name: ident.packageQn.split(".").pop() || pkgQn,
        qualifiedName: pkgQn,
        language: LANGUAGE,
        relPath: file.relPath,
        line: 1,
        column: 1,
      });
    }

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
      typePrefix: "",
      moduleQn: ident.moduleQn,
      emittedMembers: new Set<string>(),
    };

    walkModule(root, ctx);

    return {
      entities: ctx.entities,
      edges: ctx.edges,
      shapes: [],
      diagnostics: ctx.diagnostics,
    };
  },
};
