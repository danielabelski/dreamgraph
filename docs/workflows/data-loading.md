# Data Loading Process

> This process loads necessary data files and configurations into the system at startup. It ensures that all required data is available for the application to function correctly.

**Trigger:** Server startup  
**Source files:** src/api/routes.ts, src/instance/index.ts  

## Steps

### 1. Load JSON Data

Load configuration and data files from the specified directory.

### 2. Validate Loaded Data

Ensure that the loaded data conforms to expected schemas and structures.

