// Provider-agnostic tool classification.
//
// Used by the autonomy/agentic-loop layer to apply structural pressure
// when the model has exhausted reads without writing — Lever 1
// (tool-catalog narrowing toward write+verify) and Lever 2 (binding a
// concrete write tool to apply/patch-style recommended actions).
//
// Classification is PURELY name-based and prefix-driven. We do not
// hardcode an exhaustive list of tool names because the live catalog
// (host-local tools, MCP-deferred tools, dynamically discovered tools)
// changes per session. The semantic groups the user explicitly named
// in the design rule are:
//
//   write    : patch* write* edit* replace* append* create* delete*
//              rename* insert* mutate* modify*  (plus multi_replace*
//              for multi_replace_string_in_file). MCP tools carry a
//              `mcp_<server>_` prefix that is stripped before matching.
//
//   verify   : tools that execute / build / test / inspect errors
//              after a write. Includes the canonical host helpers
//              (get_errors, runTests, run_in_terminal, run_notebook_cell)
//              and any prefix-matched build/test/lint/check/verify
//              tooling. read_file is included so the model can
//              read-back what it just wrote.
//
// The classifiers are deliberately permissive on the write side: a
// false positive (treating a read tool as a write) only loosens the
// narrow filter, while a false negative (treating a write as a read)
// is the actual failure mode we are trying to prevent.

const WRITE_PREFIXES: readonly string[] = [
  'patch',
  'write',
  'edit',
  'replace',
  'append',
  'create',
  'delete',
  'rename',
  'insert',
  'mutate',
  'modify',
  'multi_replace',
  // Cognitive-graph mutators (DreamGraph MCP) — these change persistent
  // state and therefore count as "writes" for the purposes of the
  // anti-re-read pressure machinery.
  'register_',
  'record_',
  'enrich_',
  'solidify_',
  'wire_',
  'set_',
  'init_',
  'bootstrap_',
  'deprecate_',
  'resolve_',
];

const VERIFY_PREFIXES: readonly string[] = [
  'run_',
  'runtests',
  'test_',
  'build_',
  'lint_',
  'check_',
  'verify_',
  'validate_',
  'get_errors',
];

/**
 * Strip an `mcp_<server>_` prefix when present so `mcp_dreamgraph_create_file`
 * matches the same prefix rules as the host-local `create_file`.
 */
function stripMcpPrefix(name: string): string {
  return name.toLowerCase().replace(/^mcp_[a-z0-9-]+_/, '');
}

/**
 * True when the tool's name semantically denotes a state-mutating action
 * (file write, MCP graph mutation). Provider/server-agnostic and
 * tolerant of MCP namespacing.
 */
export function isWriteToolName(name: string): boolean {
  if (!name) return false;
  const stripped = stripMcpPrefix(name);
  return WRITE_PREFIXES.some((p) => stripped.startsWith(p));
}

/**
 * True when the tool's name semantically denotes a verification step
 * after a write — running the build/tests, inspecting errors, executing
 * a command, or reading the file back to confirm the write landed.
 */
export function isVerifyToolName(name: string): boolean {
  if (!name) return false;
  const stripped = stripMcpPrefix(name);
  if (stripped === 'read_file') return true;
  return VERIFY_PREFIXES.some((p) => stripped.startsWith(p));
}

/**
 * Lever 1 — narrow a live tool catalog to write + verify tools only.
 *
 * Called on the second consecutive sticky-anchor locate-only pass to
 * mechanically eliminate the ability of the model to spend another
 * turn on pure reads. Falls back to the original catalog when the
 * narrowing would produce an empty set (the loop must never deadlock
 * because of an unfortunate filter — "no failure: keep going until done").
 */
export function narrowToWriteAndVerify<T extends { readonly name: string }>(
  tools: readonly T[],
): T[] {
  const filtered = tools.filter((t) => isWriteToolName(t.name) || isVerifyToolName(t.name));
  return filtered.length > 0 ? filtered : tools.slice();
}

/**
 * Lever 2 — pick the strongest write tool available in `tools` for an
 * apply/patch-style recommended action. Preference order matches the
 * host's own examples in the agentic-loop write-reservation prompt.
 * Returns `undefined` when no write tool is available.
 */
export function pickPreferredWriteTool<T extends { readonly name: string }>(
  tools: readonly T[],
): string | undefined {
  const PREFERRED: readonly string[] = [
    'multi_replace_string_in_file',
    'replace_string_in_file',
    'create_file',
    'patch_file',
    'edit_file',
    'edit_entity',
    'edit_markdown_section',
  ];
  const byName = new Map(tools.map((t) => [t.name, t.name]));
  for (const p of PREFERRED) {
    if (byName.has(p)) return p;
    // MCP-prefixed variant.
    for (const t of tools) {
      if (stripMcpPrefix(t.name) === p) return t.name;
    }
  }
  // Fallback: first write-classified tool in the catalog.
  for (const t of tools) {
    if (isWriteToolName(t.name)) return t.name;
  }
  return undefined;
}

/**
 * Pattern that identifies a recommended-action label as an "apply / patch /
 * implement / write / fix / edit"-style step that should be bound to a
 * concrete write tool when no tool is set (Lever 2).
 */
export const APPLY_LABEL_PATTERN = /\b(apply|patch|implement|write|fix|edit|land|commit|introduce)\b/i;
