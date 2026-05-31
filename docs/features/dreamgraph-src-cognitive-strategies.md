# Strategies

> Strategies — 8 source file(s): src/cognitive/strategies/cross-domain-bridging.ts, src/cognitive/strategies/gap-detection.ts, src/cognitive/strategies/llm-dream.ts, src/cognitive/strategies/missing-abstraction.ts, src/cognitive/strategies/pgo-wave.ts, src/cognitive/strategies/symmetry-completion.ts, src/cognitive/strategies/tension-directed.ts, src/cognitive/strategies/weak-reinforcement.ts

**Repository:** dreamgraph  
**Domain:** cognitive  
**Status:** active  
**Source files:** src/cognitive/strategies/cross-domain-bridging.ts, src/cognitive/strategies/gap-detection.ts, src/cognitive/strategies/llm-dream.ts, src/cognitive/strategies/missing-abstraction.ts, src/cognitive/strategies/pgo-wave.ts, src/cognitive/strategies/symmetry-completion.ts, src/cognitive/strategies/tension-directed.ts, src/cognitive/strategies/weak-reinforcement.ts  

## Relationships

| Target | Type | Relationship | Strength | Description |
|--------|------|--------------|----------|-------------|
| dreamgraph_src_cognitive | feature | depends_on | strong | Strategies depend on the Cognitive data model for cognitive processing. |
| feature_cognitive_runtime | feature | realizes | strong | Strategies realize cognitive workflows supported by the Cognitive Runtime. |
| cognitive_engine | feature | manages | strong | The Cognitive Engine manages the execution of cognitive strategies. |
| cognitive_workflows | feature | defines | strong | Strategies define various cognitive workflows for processing tasks. |
| cognitive_registry | feature | maintains | moderate | The Cognitive Registry maintains configurations for cognitive strategies. |

**Tags:** cognitive, ts

