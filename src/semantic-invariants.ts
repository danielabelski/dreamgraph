/**
 * Semantic invariants shared by graph-generation and curation logic.
 *
 * These constants intentionally separate domain semantics from implementation
 * technology so generation code can remain rich without inventing persistence,
 * web, queue, or framework assumptions.
 */
export const GRAPH_SEMANTIC_INVARIANTS = Object.freeze({
  dataModel:
    'A data model is the structure and relationships of information inside the system; it may be in-memory, serialized, binary, schema-based, message-shaped, or persisted, but it does not require a datastore.',
  workflow:
    'A workflow is an ordered or causal progression of actions, events, decisions, or state transitions where one step meaningfully influences or enables another.',
  architecture:
    'Architecture is structural organization, not proof that a particular framework, platform, language, route layer, controller layer, queue, or datastore exists.',
  persistence:
    'Persistence is a state-retention strategy; datastore/table/storage metadata must be emitted only when explicit project evidence supports it.',
});

export const FORBIDDEN_PERSISTENCE_SENTINELS = Object.freeze([
  'not_evidenced',
  'unknown',
  '',
]);
