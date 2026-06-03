# Session

> Represents a user session within the DreamGraph system, including user preferences and state. It is used to manage user interactions and maintain context across requests.

**Table:** `session`  
**Storage:** memory  

## Fields

| Field | Type | Description |
|-------|------|-------------|
| id | string | Unique identifier for the session. |
| user_id | string | Identifier for the user associated with the session. |
| preferences | object | User preferences for the session. |

