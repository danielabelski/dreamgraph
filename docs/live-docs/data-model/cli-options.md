# CLI Options

> Holds the configuration for the command-line interface of the DreamGraph server, including transport mode and port number. It is used to parse and validate user input when starting the server.

**Table:** `cli_options`  
**Storage:** memory  

## Fields

| Field | Type | Description |
|-------|------|-------------|
| transport | string | The transport mode for the server, either 'stdio' or 'http'. |
| port | number | The port number for HTTP mode. |

