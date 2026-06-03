# Event Router

> Manages the routing of events within the cognitive engine, ensuring that events are processed correctly and efficiently. This component is crucial for the responsiveness of the system.

**Repository:** dreamgraph  
**Domain:** data-processing  
**Status:** active  
**Source files:** src/cognitive/event-router.ts  

## Relationships

| Target | Type | Relationship | Strength | Description |
|--------|------|--------------|----------|-------------|
| cognitive_engine | feature | depends_on | strong | The Event Router manages event routing within the Cognitive Engine. |
| cognitive_producers | feature | interacts_with | moderate | Cognitive Producers produce events that the Event Router manages. |
| event_dispatcher | feature | composes | moderate | The Event Router works alongside the Event Dispatcher to manage event messages. |
| event_integration_hub | feature | integrates_with | weak | The Event Router integrates with the Event Integration Hub for event-driven communication. |
| event_logging | feature | reads_from | weak | The Event Router may utilize Event Logging for auditing event processing. |
| event_dashboard | feature | provides_data_to | weak | The Event Router contributes to the data presented on the Event Dashboard. |

**Tags:** event, routing

