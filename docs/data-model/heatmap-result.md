# Heatmap Result

> Stores the results of traffic analysis over a specified time window, providing insights into event occurrences and patterns. It is useful for performance monitoring and optimization.

**Table:** `heatmap_result`  
**Storage:** json  

## Fields

| Field | Type | Description |
|-------|------|-------------|
| window_seconds | number | Time window for the heatmap analysis. |
| generated_at | string | Timestamp when the heatmap was generated. |
| nodes | array | List of nodes with their event counts. |

