# State Machine

> Manages the various states and transitions of entities within the DreamGraph system. It ensures that entities move through defined states in a controlled manner.

**Table:** `state_machine`  
**Storage:** memory  

## Fields

| Field | Type | Description |
|-------|------|-------------|
| current_state | string | The current state of the entity managed by the state machine. |
| transitions | array | List of possible transitions from the current state. |

