# Tension Management

> Manages the identification and resolution of tensions within the knowledge graph, allowing the cognitive engine to detect contradictions and missing links.

**Repository:** dreamgraph  
**Domain:** data-processing  
**Status:** active  
**Source files:** src/explorer/reason-suggest.ts  

## Relationships

| Target | Type | Relationship | Strength | Description |
|--------|------|--------------|----------|-------------|
| tension_view | feature | depends_on | strong | Tension Management relies on Tension View to display tensions within the knowledge graph. |
| cognitive_engine | feature | depends_on | strong | Tension Management operates within the Cognitive Engine to process cognitive tasks. |
| cognitive_producers | feature | depends_on | moderate | Tension Management interacts with Cognitive Producers to manage the state of tensions. |
| tensions_panel | feature | depends_on | strong | Tension Management utilizes the Tensions Panel to display information about tensions. |
| capability_semantic_provenance_preservation | feature | supports | moderate | auto-backlink |
| cognitive_tension_audit | feature | supports | moderate | auto-backlink |

**Tags:** tension, management, cognitive

