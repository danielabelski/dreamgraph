# LLM Provider Module

> Integrates with large language models (LLMs) to enhance the cognitive capabilities of the DreamGraph application. This module provides access to LLMs for generating insights and responses based on user queries.

**Repository:** dreamgraph  
**Domain:** cognitive  
**Status:** active  
**Source files:** src/cognitive/llm.ts  

## Relationships

| Target | Type | Relationship | Strength | Description |
|--------|------|--------------|----------|-------------|
| llm_config | feature | depends_on | strong | The LLM Provider Module relies on the LLM Configuration for its settings. |
| capability_llm_dreaming | feature | uses | strong | LLM Dreaming utilizes the LLM Provider Module to generate cognitive connections. |
| llm_provider | feature | realizes | moderate | The LLM Provider Module is realized by the LLM Provider feature that manages LLM integration. |
| cognitive_engine | feature | depends_on | strong | The LLM Provider Module enhances the Cognitive Engine's capabilities. |
| dreamgraph_src_cognitive | feature | related_to | moderate | auto-backlink |

**Tags:** cognitive, llm, integration

