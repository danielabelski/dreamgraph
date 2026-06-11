# Startup Initialization Process

> This process initializes the DreamGraph server, setting up the necessary configurations and starting the server based on the specified transport mode. It also handles command-line arguments for configuration.

**Trigger:** Server start command  
**Source files:** src/index.ts  

## Steps

### 1. Parse CLI Arguments

Parse the command-line arguments to determine the transport mode and port.

### 2. Initialize Server

Create and configure the server based on the parsed arguments.

### 3. Start Data Directory Watcher

Begin watching the data directory for changes.

