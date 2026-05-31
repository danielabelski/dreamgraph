# Graph RAG Cognitive Module

> Handles retrieval-augmented generation (RAG) processes within the cognitive engine, allowing for enhanced data retrieval and generation capabilities based on user queries.

**Repository:** dreamgraph  
**Domain:** cognitive  
**Status:** active  
**Source files:** src/cognitive/graph-rag.ts  

## Relationships

| Target | Type | Relationship | Strength | Description |
|--------|------|--------------|----------|-------------|
| cognitive_producers | feature | depends_on | moderate | The Graph RAG Cognitive Module relies on cognitive producers for event management. |
| cognitive_engine | feature | belongs_to | strong | The Graph RAG Cognitive Module is part of the cognitive engine architecture. |
| cognitive_workflows | feature | manages | moderate | The Graph RAG Cognitive Module manages cognitive workflows for enhanced data retrieval. |
| graph_enrichment_strategy | feature | composes | weak | The Graph RAG Cognitive Module composes strategies for enriching data in graphs. |
| dreamgraph_src_cognitive | feature | related_to | moderate | auto-backlink |
| dreamgraph_src_cognitive_flow | feature | related_to | moderate | auto-backlink |

**Tags:** cognitive, RAG, data-retrieval

