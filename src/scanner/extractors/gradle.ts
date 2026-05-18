/**
 * DreamGraph — Gradle build-file extractor (wave G-1).
 *
 * Gives the Kotlin (and Java) extractors a structural backbone by
 * surfacing the build graph itself: which BuildTarget modules exist,
 * which Gradle plugins they apply, which external artifacts they pull
 * in, and which sibling modules they depend on. Without this,
 * `build.gradle{,.kts}` files were either ignored entirely or routed
 * to the Kotlin extractor, which would happily parse them but emit
 * meaningless package/function entities for what are actually DSL
 * configuration blocks.
 *
 * Scope (G-1, the backbone):
 *   - Per-file recognition (matches() takes precedence over extension
 *     dispatch so build.gradle.kts never lands in the Kotlin extractor).
 *   - One `BuildTarget` entity per recognised build file, qn = the
 *     standard Gradle module path (`:` for the root project,
 *     `:app`, `:lib:core`, …).
 *   - One `Workspace` entity per `settings.gradle{,.kts}`, with
 *     `CONTAINS` edges to each included subproject path.
 *   - Plugin applications →
 *       IMPORTS edge to `gradle:plugin:${id}` with
 *       `meta.via = "plugin"`, `meta.version = "..."?`
 *     Recognises:
 *       * `plugins { id("x.y") version "1.2.3" }`         (Kotlin DSL)
 *       * `plugins { kotlin("jvm") version "1.9.0" }`     (Kotlin DSL helper)
 *       * `plugins { id 'x.y' version '1.2.3' }`          (Groovy DSL)
 *       * `apply plugin: 'x.y'`                            (legacy Groovy)
 *   - Dependency declarations →
 *       IMPORTS edge with
 *       `meta.via = "dependency" | "project_dependency" | "version_catalog_ref"`
 *       and `meta.scope = "implementation" | "api" | "testImplementation" | ...`.
 *     Recognises:
 *       * `implementation("group:artifact:version")`       (Kotlin DSL)
 *       * `implementation 'group:artifact:version'`        (Groovy DSL)
 *       * `implementation(project(":path"))`               (project dep)
 *       * `implementation libs.kotlinx.coroutines.core`    (version catalog ref)
 *
 * Out of scope for this wave (planned follow-ups):
 *   - `gradle/libs.versions.toml` parsing
 *   - `gradle.properties` constants
 *   - Resolving `project(":path")` → BuildTarget entity ids via the
 *     orchestrator (requires a new placeholder slot beyond
 *     "type" / "include").
 *   - Conditional plugin application via `pluginManagement {}` blocks
 *   - Kotlin-DSL `subprojects { dependencies { ... } }` cascades
 *
 * DSL detection:
 *   - File name ending in `.kts` (e.g. `build.gradle.kts`) →
 *     parsed with tree-sitter-kotlin and walked structurally.
 *   - File name ending in `.gradle` (Groovy DSL) → no tree-sitter
 *     grammar is bundled, so we use a tightly-scoped regex pass that
 *     only recognises the two DSL surfaces above. The regex pass is
 *     line-oriented and deliberately conservative; anything it can't
 *     confidently classify is dropped rather than mis-attributed.
 *
 * Coherence (intermediate-layer audit):
 *   - Every edge carries `meta.base_*` + `meta.resolved: false` so the
 *     orchestrator can extend resolution to BuildTarget targets later
 *     without a schema change.
 *   - `model_kind` for BuildTarget surfaces as `gradle:buildtarget`
 *     downstream (computed from `entity.language` + `kind.toLowerCase()`).
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

const NAME = "gradle";
const VERSION = "0.1.0";
const LANGUAGE = "gradle";
const EXTENSIONS: readonly string[] = [".gradle"];

const RECOGNISED_BASENAMES = new Set([
  "build.gradle", "build.gradle.kts",
  "settings.gradle", "settings.gradle.kts",
]);

/** Dependency configurations we recognise. Anything else is dropped. */
const DEPENDENCY_SCOPES = new Set([
  // Java / Kotlin standard
  "implementation", "api", "compileOnly", "compileOnlyApi",
  "runtimeOnly", "runtimeClasspath",
  // Test
  "testImplementation", "testApi", "testRuntimeOnly", "testCompileOnly",
  // Android variants commonly seen
  "debugImplementation", "releaseImplementation",
  "androidTestImplementation",
  // Annotation processors
  "annotationProcessor", "kapt", "ksp",
]);

/** Kotlin-DSL plugin helper functions (besides plain `id(...)`). */
const KOTLIN_PLUGIN_HELPERS = new Map<string, (arg: string) => string>([
  ["kotlin", (arg) => `org.jetbrains.kotlin.${arg}`],
  ["id", (arg) => arg],
]);

function entityId(relPath: string, kind: string, qualifiedName: string): string {
  return `${LANGUAGE}:${relPath}#${kind}:${qualifiedName}`;
}

function fileEntityId(relPath: string): string {
  return `${LANGUAGE}:${relPath}`;
}

function evidenceAt(
  line: number,
  column: number,
  confidence: Confidence = Confidence.High,
): EdgeEvidence {
  return {
    extractor: NAME,
    extractor_version: VERSION,
    parser_backed: true,
    confidence,
    language: LANGUAGE,
    line,
    column,
  };
}

function evidenceOfNode(node: SyntaxNode, confidence: Confidence = Confidence.High): EdgeEvidence {
  return evidenceAt(node.startPosition.row + 1, node.startPosition.column + 1, confidence);
}

// ---------------------------------------------------------------------------
// Module-path derivation
// ---------------------------------------------------------------------------

/**
 * Convert the file's `dirParts` (the dotted path from repo root to the
 * directory holding the build file) into the canonical Gradle module
 * path: `:`, `:app`, `:lib:core`. Root-level files map to `:`.
 */
function deriveModulePath(dirParts: readonly string[]): string {
  if (dirParts.length === 0) return ":";
  return ":" + dirParts.join(":");
}

function isSettingsFile(name: string): boolean {
  return name === "settings.gradle" || name === "settings.gradle.kts";
}

function isKotlinDsl(name: string): boolean {
  return name.endsWith(".kts");
}

// ---------------------------------------------------------------------------
// Walk context
// ---------------------------------------------------------------------------

interface WalkCtx {
  relPath: string;
  fileEntity: string;
  ownerId: string;          // BuildTarget id or Workspace id
  ownerQn: string;
  isSettings: boolean;
  entities: ExtractedEntity[];
  edges: ExtractedEdge[];
  diagnostics: ExtractorDiagnostic[];
}

// ---------------------------------------------------------------------------
// Edge emission helpers
// ---------------------------------------------------------------------------

interface PluginRef {
  id: string;
  version?: string;
  evidence: EdgeEvidence;
}

interface DependencyRef {
  scope: string;
  group?: string;
  artifact?: string;
  version?: string;
  /** Set when the dep is `project(":path")`. */
  projectPath?: string;
  /** Set when the dep is a version-catalog accessor like `libs.x.y`. */
  catalogRef?: string;
  evidence: EdgeEvidence;
}

interface IncludeRef {
  projectPath: string;
  evidence: EdgeEvidence;
}

function emitPluginEdge(ctx: WalkCtx, ref: PluginRef): void {
  const meta: Record<string, unknown> = {
    via: "plugin",
    base_plugin: ref.id,
    resolved: false,
  };
  if (ref.version) meta.version = ref.version;
  ctx.edges.push({
    from: ctx.ownerId,
    to: `${LANGUAGE}:plugin:${ref.id}`,
    relationship: Relationship.IMPORTS,
    evidence: ref.evidence,
    meta,
  });
}

function emitDependencyEdge(ctx: WalkCtx, ref: DependencyRef): void {
  // project(":path") dependency.
  if (ref.projectPath) {
    ctx.edges.push({
      from: ctx.ownerId,
      to: `${LANGUAGE}:project:${ref.projectPath}`,
      relationship: Relationship.IMPORTS,
      evidence: ref.evidence,
      meta: {
        via: "project_dependency",
        scope: ref.scope,
        base_module: ref.projectPath,
        resolved: false,
      },
    });
    return;
  }
  // libs.x.y version-catalog accessor.
  if (ref.catalogRef) {
    ctx.edges.push({
      from: ctx.ownerId,
      to: `${LANGUAGE}:libref:${ref.catalogRef}`,
      relationship: Relationship.IMPORTS,
      evidence: ref.evidence,
      meta: {
        via: "version_catalog_ref",
        scope: ref.scope,
        base_alias: ref.catalogRef,
        resolved: false,
      },
    });
    return;
  }
  // External Maven coordinate.
  if (ref.group && ref.artifact) {
    const meta: Record<string, unknown> = {
      via: "dependency",
      scope: ref.scope,
      base_group: ref.group,
      base_artifact: ref.artifact,
      resolved: false,
    };
    if (ref.version) meta.version = ref.version;
    ctx.edges.push({
      from: ctx.ownerId,
      to: `${LANGUAGE}:dep:${ref.group}:${ref.artifact}`,
      relationship: Relationship.IMPORTS,
      evidence: ref.evidence,
      meta,
    });
  }
}

function emitIncludeEdge(ctx: WalkCtx, ref: IncludeRef): void {
  ctx.edges.push({
    from: ctx.ownerId,
    to: `${LANGUAGE}:project:${ref.projectPath}`,
    relationship: Relationship.CONTAINS,
    evidence: ref.evidence,
    meta: {
      via: "settings_include",
      base_module: ref.projectPath,
      resolved: false,
    },
  });
}

// ---------------------------------------------------------------------------
// Maven coord parsing
// ---------------------------------------------------------------------------

/**
 * Parse a `group:artifact[:version]` coordinate string. Returns null
 * when the string has fewer than 2 colon-separated parts or the first
 * two parts are empty.
 */
function parseMavenCoord(text: string): { group: string; artifact: string; version?: string } | null {
  const parts = text.split(":");
  if (parts.length < 2) return null;
  const group = parts[0]!.trim();
  const artifact = parts[1]!.trim();
  if (!group || !artifact) return null;
  const version = parts[2]?.trim();
  return version ? { group, artifact, version } : { group, artifact };
}

// ---------------------------------------------------------------------------
// Kotlin DSL parsing (tree-sitter-kotlin)
// ---------------------------------------------------------------------------

function readStringLiteral(node: SyntaxNode): string | null {
  if (node.type !== "string_literal") return null;
  // string_literal wraps a string_content (and possibly escape sequences).
  let out = "";
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (!c) continue;
    if (c.type === "string_content") out += c.text;
    // Escaped sequences appear as character_escape_seq → keep their text.
    else out += c.text;
  }
  return out;
}

/** Return the text of a navigation_expression like `libs.x.y.z`. */
function readNavigationDottedName(node: SyntaxNode): string | null {
  if (node.type === "simple_identifier") return node.text;
  if (node.type !== "navigation_expression") return null;
  return node.text.trim();
}

/** A top-level Kotlin-DSL block like `plugins { ... }` or `dependencies { ... }`. */
interface BlockCall {
  name: string;
  body: SyntaxNode; // statements node inside the lambda
  callNode: SyntaxNode;
}

function findTopLevelBlocks(root: SyntaxNode): BlockCall[] {
  const out: BlockCall[] = [];
  for (let i = 0; i < root.namedChildCount; i++) {
    const child = root.namedChild(i);
    if (!child) continue;
    const block = asBlockCall(child);
    if (block) out.push(block);
  }
  return out;
}

function asBlockCall(node: SyntaxNode): BlockCall | null {
  if (node.type !== "call_expression") return null;
  const id = node.namedChild(0);
  if (!id || id.type !== "simple_identifier") return null;
  const callSuffix = node.namedChild(1);
  if (!callSuffix || callSuffix.type !== "call_suffix") return null;
  // Look for annotated_lambda → lambda_literal → statements.
  for (let i = 0; i < callSuffix.namedChildCount; i++) {
    const c = callSuffix.namedChild(i);
    if (!c || c.type !== "annotated_lambda") continue;
    for (let j = 0; j < c.namedChildCount; j++) {
      const lit = c.namedChild(j);
      if (!lit || lit.type !== "lambda_literal") continue;
      for (let k = 0; k < lit.namedChildCount; k++) {
        const stmts = lit.namedChild(k);
        if (stmts && stmts.type === "statements") {
          return { name: id.text, body: stmts, callNode: node };
        }
      }
    }
  }
  return null;
}

function parseKotlinPluginsBlock(stmts: SyntaxNode, ctx: WalkCtx): void {
  for (let i = 0; i < stmts.namedChildCount; i++) {
    const stmt = stmts.namedChild(i);
    if (!stmt) continue;
    const ref = parseKotlinPluginStatement(stmt);
    if (ref) emitPluginEdge(ctx, ref);
  }
}

/**
 * Recognise one of:
 *   - id("x.y") version "1.2.3"     → infix_expression(call, "version", string)
 *   - id("x.y")                      → call_expression
 *   - kotlin("jvm") version "1.9.0"  → infix_expression with helper-call
 *   - `java-library`                 → simple_identifier with backticks
 */
function parseKotlinPluginStatement(node: SyntaxNode): PluginRef | null {
  // Strip outer infix `... version "..."` if present.
  let versionText: string | undefined;
  let callNode: SyntaxNode | null = node;
  if (node.type === "infix_expression") {
    const children: SyntaxNode[] = [];
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c) children.push(c);
    }
    // Find the "version" identifier; the call is to its left, the
    // version string is to its right.
    const versionIdx = children.findIndex(
      (c) => c.type === "simple_identifier" && c.text === "version",
    );
    if (versionIdx > 0 && versionIdx < children.length - 1) {
      callNode = children[versionIdx - 1]!;
      const versionLit = children[versionIdx + 1]!;
      const v = readStringLiteral(versionLit);
      if (v) versionText = v;
    } else {
      callNode = children[0] ?? null;
    }
  }
  if (!callNode) return null;

  // Bare backticked identifier like `java-library`.
  if (callNode.type === "simple_identifier") {
    const raw = callNode.text;
    const id = raw.replace(/^`|`$/g, "");
    if (!id) return null;
    return { id, evidence: evidenceOfNode(callNode) };
  }

  if (callNode.type !== "call_expression") return null;
  const head = callNode.namedChild(0);
  if (!head || head.type !== "simple_identifier") return null;
  const helper = KOTLIN_PLUGIN_HELPERS.get(head.text);
  if (!helper) return null;

  const callSuffix = callNode.namedChild(1);
  if (!callSuffix || callSuffix.type !== "call_suffix") return null;
  const arg = firstStringArgument(callSuffix);
  if (!arg) return null;
  return { id: helper(arg), version: versionText, evidence: evidenceOfNode(callNode) };
}

function firstStringArgument(callSuffix: SyntaxNode): string | null {
  const va = firstNamedChildOfType(callSuffix, "value_arguments");
  if (!va) return null;
  for (let i = 0; i < va.namedChildCount; i++) {
    const arg = va.namedChild(i);
    if (!arg || arg.type !== "value_argument") continue;
    for (let j = 0; j < arg.namedChildCount; j++) {
      const inner = arg.namedChild(j);
      if (inner && inner.type === "string_literal") {
        return readStringLiteral(inner);
      }
    }
  }
  return null;
}

function firstNamedChildOfType(node: SyntaxNode, type: string): SyntaxNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c && c.type === type) return c;
  }
  return null;
}

function parseKotlinDependenciesBlock(stmts: SyntaxNode, ctx: WalkCtx): void {
  for (let i = 0; i < stmts.namedChildCount; i++) {
    const stmt = stmts.namedChild(i);
    if (!stmt || stmt.type !== "call_expression") continue;
    const head = stmt.namedChild(0);
    if (!head || head.type !== "simple_identifier") continue;
    const scope = head.text;
    if (!DEPENDENCY_SCOPES.has(scope)) continue;
    const callSuffix = stmt.namedChild(1);
    if (!callSuffix || callSuffix.type !== "call_suffix") continue;
    const ref = parseKotlinDependencyArg(callSuffix, scope);
    if (ref) emitDependencyEdge(ctx, ref);
  }
}

function parseKotlinDependencyArg(callSuffix: SyntaxNode, scope: string): DependencyRef | null {
  const va = firstNamedChildOfType(callSuffix, "value_arguments");
  if (!va) return null;
  // We expect a single value_argument.
  const arg = firstNamedChildOfType(va, "value_argument");
  if (!arg) return null;
  // Possible shapes:
  //   string_literal           → "group:artifact:version"
  //   call_expression project(":path")
  //   navigation_expression libs.x.y
  for (let i = 0; i < arg.namedChildCount; i++) {
    const inner = arg.namedChild(i);
    if (!inner) continue;
    if (inner.type === "string_literal") {
      const text = readStringLiteral(inner);
      if (!text) return null;
      const coord = parseMavenCoord(text);
      if (!coord) return null;
      return { scope, ...coord, evidence: evidenceOfNode(inner) };
    }
    if (inner.type === "call_expression") {
      const head = inner.namedChild(0);
      if (!head || head.type !== "simple_identifier" || head.text !== "project") continue;
      const innerSuffix = inner.namedChild(1);
      if (!innerSuffix || innerSuffix.type !== "call_suffix") continue;
      const pathStr = firstStringArgument(innerSuffix);
      if (!pathStr) continue;
      return { scope, projectPath: pathStr, evidence: evidenceOfNode(inner) };
    }
    if (inner.type === "navigation_expression" || inner.type === "simple_identifier") {
      const name = readNavigationDottedName(inner);
      if (!name) continue;
      // Only treat dotted names rooted at "libs" / "deps" / "catalog" /
      // "versions" as version-catalog refs to avoid false positives.
      const head = name.split(".")[0]!;
      if (head !== "libs" && head !== "deps" && head !== "catalog" && head !== "versions") continue;
      return { scope, catalogRef: name, evidence: evidenceOfNode(inner) };
    }
  }
  return null;
}

function parseKotlinSettingsBlock(root: SyntaxNode, ctx: WalkCtx): void {
  // include(":app", ":lib:core") at top level.
  for (let i = 0; i < root.namedChildCount; i++) {
    const stmt = root.namedChild(i);
    if (!stmt || stmt.type !== "call_expression") continue;
    const head = stmt.namedChild(0);
    if (!head || head.type !== "simple_identifier" || head.text !== "include") continue;
    const callSuffix = stmt.namedChild(1);
    if (!callSuffix || callSuffix.type !== "call_suffix") continue;
    const va = firstNamedChildOfType(callSuffix, "value_arguments");
    if (!va) continue;
    for (let j = 0; j < va.namedChildCount; j++) {
      const arg = va.namedChild(j);
      if (!arg || arg.type !== "value_argument") continue;
      for (let k = 0; k < arg.namedChildCount; k++) {
        const inner = arg.namedChild(k);
        if (inner && inner.type === "string_literal") {
          const path = readStringLiteral(inner);
          if (path) emitIncludeEdge(ctx, { projectPath: path, evidence: evidenceOfNode(inner) });
        }
      }
    }
  }
}

async function parseKotlinDsl(source: string, ctx: WalkCtx): Promise<void> {
  const parser = await getParser("kotlin");
  const tree = parser.parse(source);
  const root = tree.rootNode;
  if (root.hasError()) {
    ctx.diagnostics.push({
      severity: "warning",
      relPath: ctx.relPath,
      message: "gradle: tree-sitter-kotlin reported parse errors; extraction proceeded best-effort",
    });
  }
  if (ctx.isSettings) {
    parseKotlinSettingsBlock(root, ctx);
    return;
  }
  const blocks = findTopLevelBlocks(root);
  for (const block of blocks) {
    if (block.name === "plugins") parseKotlinPluginsBlock(block.body, ctx);
    else if (block.name === "dependencies") parseKotlinDependenciesBlock(block.body, ctx);
  }
}

// ---------------------------------------------------------------------------
// Groovy DSL parsing (regex-based, intentionally conservative)
// ---------------------------------------------------------------------------

/**
 * Match `id 'x.y'` / `id "x.y"` optionally followed by `version 'v'`.
 * Also `id('x.y') version 'v'`. Captures id and optional version.
 */
const GROOVY_PLUGIN_RE =
  /\bid\s*\(?\s*(['"])([\w.\-]+)\1\s*\)?\s*(?:version\s+(['"])([\w.\-+]+)\3)?/g;

/** Match legacy `apply plugin: 'x.y'`. */
const GROOVY_APPLY_PLUGIN_RE = /\bapply\s+plugin\s*:\s*(['"])([\w.\-]+)\1/g;

/** Match `<scope> 'group:artifact:version'` (single-arg form). */
const GROOVY_DEPENDENCY_STRING_RE =
  new RegExp(
    `\\b(${Array.from(DEPENDENCY_SCOPES).join("|")})\\s*\\(?\\s*(['\"])` +
    `([\\w.\\-]+:[\\w.\\-]+(?::[\\w.\\-+]+)?)` +
    `\\2\\s*\\)?`,
    "g",
  );

/** Match `<scope> project(':path')` or `<scope>(project(':path'))`. */
const GROOVY_DEPENDENCY_PROJECT_RE =
  new RegExp(
    `\\b(${Array.from(DEPENDENCY_SCOPES).join("|")})\\s*\\(?\\s*project\\s*\\(\\s*(['\"])` +
    `(:[\\w.:\\-]*)` +
    `\\2\\s*\\)\\s*\\)?`,
    "g",
  );

/** Match `include ':app', ':lib:core'` (Groovy settings.gradle). */
const GROOVY_INCLUDE_RE =
  /\binclude\s+((?:(['"])(:[\w.:\-]*)\2\s*,?\s*)+)/g;

function lineColumnFor(source: string, index: number): { line: number; column: number } {
  let line = 1, col = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source[i] === "\n") { line++; col = 1; } else col++;
  }
  return { line, column: col };
}

function parseGroovyBuildFile(source: string, ctx: WalkCtx): void {
  for (const m of source.matchAll(GROOVY_PLUGIN_RE)) {
    const { line, column } = lineColumnFor(source, m.index ?? 0);
    emitPluginEdge(ctx, {
      id: m[2]!,
      version: m[4],
      evidence: evidenceAt(line, column, Confidence.Medium),
    });
  }
  for (const m of source.matchAll(GROOVY_APPLY_PLUGIN_RE)) {
    const { line, column } = lineColumnFor(source, m.index ?? 0);
    emitPluginEdge(ctx, {
      id: m[2]!,
      evidence: evidenceAt(line, column, Confidence.Medium),
    });
  }
  for (const m of source.matchAll(GROOVY_DEPENDENCY_STRING_RE)) {
    const { line, column } = lineColumnFor(source, m.index ?? 0);
    const coord = parseMavenCoord(m[3]!);
    if (!coord) continue;
    emitDependencyEdge(ctx, {
      scope: m[1]!,
      ...coord,
      evidence: evidenceAt(line, column, Confidence.Medium),
    });
  }
  for (const m of source.matchAll(GROOVY_DEPENDENCY_PROJECT_RE)) {
    const { line, column } = lineColumnFor(source, m.index ?? 0);
    emitDependencyEdge(ctx, {
      scope: m[1]!,
      projectPath: m[3]!,
      evidence: evidenceAt(line, column, Confidence.Medium),
    });
  }
}

function parseGroovySettingsFile(source: string, ctx: WalkCtx): void {
  for (const m of source.matchAll(GROOVY_INCLUDE_RE)) {
    const baseIdx = m.index ?? 0;
    // Re-extract each quoted path from the captured list.
    const pathRe = /(['"])(:[\w.:\-]*)\1/g;
    for (const inner of m[1]!.matchAll(pathRe)) {
      const offset = baseIdx + (m[0]!.indexOf(inner[0]));
      const { line, column } = lineColumnFor(source, offset);
      emitIncludeEdge(ctx, {
        projectPath: inner[2]!,
        evidence: evidenceAt(line, column, Confidence.Medium),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Extractor entry point
// ---------------------------------------------------------------------------

export const gradleExtractor: Extractor = {
  name: NAME,
  version: VERSION,
  extensions: EXTENSIONS,
  parserBacked: true,
  matches(file): boolean {
    return RECOGNISED_BASENAMES.has(file.name);
  },
  async extract(file: ExtractFileInput): Promise<ExtractorOutput> {
    const modulePath = deriveModulePath(file.dirParts);
    const isSettings = isSettingsFile(file.name);
    const kotlinDsl = isKotlinDsl(file.name);

    const entities: ExtractedEntity[] = [
      {
        id: fileEntityId(file.relPath),
        kind: CodeEntityKind.SourceFile,
        name: file.name,
        qualifiedName: file.relPath,
        language: LANGUAGE,
        relPath: file.relPath,
        line: 1,
        column: 1,
      },
    ];

    let ownerEntity: ExtractedEntity;
    if (isSettings) {
      const wsQn = modulePath; // ":" at repo root for settings file
      ownerEntity = {
        id: entityId(file.relPath, CodeEntityKind.Workspace, wsQn),
        kind: CodeEntityKind.Workspace,
        name: file.name,
        qualifiedName: wsQn,
        language: LANGUAGE,
        relPath: file.relPath,
        line: 1,
        column: 1,
        attrs: {
          is_gradle: true,
          dsl: kotlinDsl ? "kotlin" : "groovy",
        },
      };
    } else {
      ownerEntity = {
        id: entityId(file.relPath, CodeEntityKind.BuildTarget, modulePath),
        kind: CodeEntityKind.BuildTarget,
        name: modulePath,
        qualifiedName: modulePath,
        language: LANGUAGE,
        relPath: file.relPath,
        line: 1,
        column: 1,
        attrs: {
          is_gradle: true,
          dsl: kotlinDsl ? "kotlin" : "groovy",
          module_path: modulePath,
        },
      };
    }
    entities.push(ownerEntity);

    const ctx: WalkCtx = {
      relPath: file.relPath,
      fileEntity: fileEntityId(file.relPath),
      ownerId: ownerEntity.id,
      ownerQn: ownerEntity.qualifiedName,
      isSettings,
      entities,
      edges: [],
      diagnostics: [],
    };

    if (kotlinDsl) {
      await parseKotlinDsl(file.source, ctx);
    } else if (isSettings) {
      parseGroovySettingsFile(file.source, ctx);
    } else {
      parseGroovyBuildFile(file.source, ctx);
    }

    return {
      entities: ctx.entities,
      edges: ctx.edges,
      shapes: [],
      diagnostics: ctx.diagnostics,
    };
  },
};
