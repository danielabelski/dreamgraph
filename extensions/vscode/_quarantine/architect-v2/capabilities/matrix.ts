// STRICT ISOLATION (ADR-140): no import from v1.
// Slice 6 — Capability matrix (typed mirror of plans/ARCHITECT_V2_SLICE6_CAPABILITY_MATRIX.md).
//
// Every capability has:
//   - graphFirst: ≥1 Slice-4 Intent that is the DreamGraph-native path
//   - fallback:   0+ Slice-4 Intents (T4/T5) used when the graph is sparse
//   - graphOnly:  true when there is no fallback (capability is a pure graph win)
//   - winRationale: short human-readable justification (renders on cards)

import type { Intent } from '../execution/index.js';

export type CapabilityGroup =
  | 'navigation'
  | 'history'
  | 'mutation'
  | 'verification'
  | 'cognition'
  | 'environment';

export type CapabilityId =
  // 2.1 Navigation & search (10)
  | 'navigate.symbol'
  | 'navigate.references'
  | 'read.file'
  | 'read.dir'
  | 'read.markdown.chapter'
  | 'search.text'
  | 'search.semantic'
  | 'search.api'
  | 'search.data_model'
  | 'search.ui'
  // 2.2 History & rationale (8)
  | 'read.history.git'
  | 'read.adr'
  | 'read.workflow'
  | 'read.narrative'
  | 'explain.causal'
  | 'explain.temporal'
  | 'plan.remediation'
  | 'memory.recall'
  // 2.3 Mutation (9)
  | 'mutate.file.create'
  | 'mutate.file.edit'
  | 'mutate.file.patch'
  | 'mutate.file.append'
  | 'mutate.file.delete_rename'
  | 'mutate.markdown.chapter'
  | 'mutate.api.surface'
  | 'mutate.graph.wire'
  | 'mutate.entity.edit'
  // 2.4 Verification (6)
  | 'verify.build'
  | 'verify.test'
  | 'verify.type'
  | 'verify.lint'
  | 'verify.discipline'
  | 'verify.invariant'
  // 2.5 Cognition (4)
  | 'memory.persist'
  | 'cognition.dream'
  | 'cognition.tension.resolve'
  | 'task.create_continuation'
  // 2.6 Environment (5)
  | 'env.web.fetch'
  | 'env.terminal.run'
  | 'env.clipboard'
  | 'env.diagnostics.live'
  | 'env.lm.invoke_tool';

export interface CapabilityRecord {
  readonly id: CapabilityId;
  readonly group: CapabilityGroup;
  readonly graphFirst: readonly Intent[];
  readonly fallback: readonly Intent[];
  readonly graphOnly: boolean;
  readonly winRationale: string;
  /** Optional: enrichment intent to queue when fallback is used. */
  readonly enrichOnFallback?: Intent;
}

/**
 * Frozen capability matrix. Mirrors the §2 tables of
 * `plans/ARCHITECT_V2_SLICE6_CAPABILITY_MATRIX.md` 1:1.
 */
export const CAPABILITY_MATRIX: readonly CapabilityRecord[] = Object.freeze([
  // --- 2.1 Navigation & search ---
  cap('navigate.symbol', 'navigation',
    ['api.query'],
    ['editor.symbol'],
    'Graph returns the entity in context (callers, callees, ADRs); generic LSP returns one location.',
    'graph.scan'),
  cap('navigate.references', 'navigation',
    ['api.query', 'graph.shortest_path'],
    ['source.search'],
    'Graph returns the dependency path, not a flat list; cycles and transitive coupling become visible.',
    'api.modify'),
  cap('read.file', 'navigation',
    ['file.read'],
    ['editor.openFile'],
    'Entity-scoped reads minimize tokens and preserve semantic boundaries.'),
  cap('read.dir', 'navigation',
    ['dir.list'],
    ['editor.command'],
    'list_directory annotates entries with entity counts; guides which files matter first.'),
  cap('read.markdown.chapter', 'navigation',
    ['markdown.list_chapters', 'markdown.read'],
    ['file.read'],
    'Chapter id is a durable anchor shared with patch_markdown_chapter; survives header rewrites.'),
  cap('search.text', 'navigation',
    ['source.search'],
    ['editor.command'],
    'Matches inside known entities are auto-promoted to entity refs.'),
  cap('search.semantic', 'navigation',
    ['graph.rag'],
    ['source.search'],
    'RAG over the graph returns connected evidence (function + ADR + dream), not disconnected snippets.'),
  cap('search.api', 'navigation',
    ['api.query'],
    ['source.search'],
    'Structural search by signature/tag/return-type; not regex over `function `.'),
  cap('search.data_model', 'navigation',
    ['data_model.search', 'db_schema.query'],
    ['source.search'],
    'Schema is a first-class entity with relationships and PII tags; not re-derived from migrations.'),
  cap('search.ui', 'navigation',
    ['ui.query'],
    ['source.search'],
    'UI registry is the single source of truth; finds dynamic/virtual components grep cannot.',
    'ui.register'),

  // --- 2.2 History & rationale ---
  cap('read.history.git', 'history',
    ['git.read.log', 'git.read.blame'],
    ['shell.run'],
    'Commits are joined to entities; the architect sees which ADR a commit triggered.'),
  cap('read.adr', 'history',
    ['adr.read'],
    ['file.read'],
    'ADRs are graph entities with affected_entities, guard_rails, deprecation chains.'),
  cap('read.workflow', 'history',
    ['graph.read'],
    ['markdown.read'],
    'Workflows are typed step graphs with inputs/outputs; not prose docs re-derived each pass.'),
  cap('read.narrative', 'history',
    ['narrative.read'],
    [],
    'Auto-maintained chronicle citing entities and ADRs. Pure graph win; no generic equivalent.'),
  cap('explain.causal', 'history',
    ['graph.rag', 'graph.shortest_path'],
    ['adr.read', 'git.read.log'],
    'Returns the chain of decisions and edges that produced the coupling; not rediscovered from prose.'),
  cap('explain.temporal', 'history',
    ['dream.read'],
    ['git.read.log'],
    'Joins git history + ADR timeline + dream insights about the entity; not git only.'),
  cap('plan.remediation', 'history',
    ['remediation.read'],
    ['graph.rag'],
    'Pre-computed by nightmare cycles; cites root-cause edges.'),
  cap('memory.recall', 'cognition', // group=cognition per plan §2.5; matrix tables put it in 2.2 visually
    ['dream.read', 'graph.rag'],
    ['adr.read', 'narrative.read'],
    'Dreams are validated insights with provenance; not just the current chat window.'),

  // --- 2.3 Mutation ---
  cap('mutate.file.create', 'mutation',
    ['file.create', 'graph.wire'],
    ['editor.command'],
    'New file becomes a graph node immediately; future reads find it without re-scan.',
    'graph.scan'),
  cap('mutate.file.edit', 'mutation',
    ['file.edit'],
    ['editor.command'],
    'Surface diff captured; graph reflects the new shape immediately when followed by api.modify.',
    'api.modify'),
  cap('mutate.file.patch', 'mutation',
    ['file.patch'],
    ['file.edit'],
    'Patch is scoped to an entity, not a line range; survives reformatting.'),
  cap('mutate.file.append', 'mutation',
    ['file.append'],
    ['file.edit'],
    'Same as generic; for known markdown docs the matrix prefers markdown.patch_chapter.'),
  cap('mutate.file.delete_rename', 'mutation',
    ['file.delete', 'file.rename', 'graph.wire'],
    ['editor.command'],
    'Edges to deleted entities surface as graph orphans the architect can repair in the same pass.'),
  cap('mutate.markdown.chapter', 'mutation',
    ['markdown.patch_chapter', 'markdown.edit_section'],
    ['file.edit'],
    'Chapter id is durable across header renames; TOC stays valid; chapter remains a graph entity.'),
  cap('mutate.api.surface', 'mutation',
    ['api.modify'],
    ['source.search', 'file.patch'],
    'Refactor is expressed as an entity transformation; consistency across call sites enforced.'),
  cap('mutate.graph.wire', 'mutation',
    ['graph.wire', 'graph.scan'],
    [],
    'The architect repairs its own foundation between passes. Pure graph capability.'),
  cap('mutate.entity.edit', 'mutation',
    ['entity.edit'],
    [],
    'Entity-level edit (rename, retag, re-attribute). Pure graph capability.'),

  // --- 2.4 Verification ---
  cap('verify.build', 'verification',
    ['cognitive.event'],
    ['shell.run'],
    'Build outcome lands as a graph event with artifact refs; cross-pass continuity.'),
  cap('verify.test', 'verification',
    ['cognitive.event'],
    ['shell.run'],
    'Test failures become tension entries the dream cycle can analyze.'),
  cap('verify.type', 'verification',
    ['verify.invariant'],
    ['editor.diagnostics'],
    'Errors carry the entity they violate; refactor decisions can target them.'),
  cap('verify.lint', 'verification',
    ['verify.invariant'],
    ['editor.diagnostics'],
    'Same as type; entity-bound diagnostics.'),
  cap('verify.discipline', 'verification',
    ['verify.discipline'],
    [],
    'Verifies system invariants encoded in the graph (ADR guard rails). Pure graph capability.'),
  cap('verify.invariant', 'verification',
    ['metacognition.analyze', 'verify.invariant'],
    [],
    'Cross-cutting invariant check. Pure graph capability.'),

  // --- 2.5 Cognition ---
  cap('memory.persist', 'cognition',
    ['cognitive.solidify', 'adr.record'],
    [],
    'Insight gains provenance, guard rails, queryability across sessions.'),
  cap('cognition.dream', 'cognition',
    ['dream.cycle', 'dream.nightmare'],
    [],
    'Generates remediation plans, surfaces tensions, proposes ADRs. Pure graph capability.'),
  cap('cognition.tension.resolve', 'cognition',
    ['cognitive.resolve_tension'],
    [],
    'Closes the loop between observation and resolution in the same data model.'),
  cap('task.create_continuation', 'cognition',
    ['cognitive.preamble'],
    [],
    'Continuation is typed, embeds the exact next tool, survives streaming (Slice 3 ADR-154).'),

  // --- 2.6 Environment ---
  cap('env.web.fetch', 'environment',
    ['web.fetch'],
    ['shell.run'],
    'Fetched fact can be promoted to a dream insight or ADR citation.'),
  cap('env.terminal.run', 'environment',
    ['cognitive.event'],
    ['shell.run'],
    'Same exec, but outcome enters the graph (verify.build/verify.test pattern).'),
  cap('env.clipboard', 'environment',
    [],
    ['clipboard.read', 'clipboard.write'],
    'Pure environment IO; no graph variant.'),
  cap('env.diagnostics.live', 'environment',
    ['runtime.metrics'],
    ['editor.diagnostics'],
    'Diagnostics joined to entities; entity-bound errors guide refactor.'),
  cap('env.lm.invoke_tool', 'environment',
    [],
    ['lm.tool'],
    'Escape hatch when no T1\u2013T3 entry exists; outcome still normalized as ToolOutcome (ADR-157).'),
] as const);

function cap(
  id: CapabilityId,
  group: CapabilityGroup,
  graphFirst: readonly Intent[],
  fallback: readonly Intent[],
  winRationale: string,
  enrichOnFallback?: Intent,
): CapabilityRecord {
  return Object.freeze({
    id,
    group,
    graphFirst: Object.freeze([...graphFirst]),
    fallback: Object.freeze([...fallback]),
    graphOnly: fallback.length === 0,
    winRationale,
    enrichOnFallback,
  });
}

const BY_ID: ReadonlyMap<CapabilityId, CapabilityRecord> = new Map(
  CAPABILITY_MATRIX.map((c) => [c.id, c] as const),
);

export function getCapability(id: CapabilityId): CapabilityRecord {
  const r = BY_ID.get(id);
  if (!r) throw new Error(`Unknown capability id: ${id}`);
  return r;
}

export const CAPABILITY_COUNT = CAPABILITY_MATRIX.length;
