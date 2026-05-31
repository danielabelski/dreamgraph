# Instance Isolation Tests

> Integration tests that ensure the integrity and isolation of instances within the DreamGraph application. These tests cover various scenarios to prevent cross-instance contamination and validate policies.

**Repository:** dreamgraph  
**Domain:** testing  
**Status:** active  
**Source files:** tests/instance-isolation.test.ts  

## Relationships

| Target | Type | Relationship | Strength | Description |
|--------|------|--------------|----------|-------------|
| dreamgraph_tests | feature | depends_on | strong | Instance Isolation Tests are part of the broader testing framework in DreamGraph. |
| test_case | feature | realizes | moderate | Instance Isolation Tests define specific test cases to validate instance integrity. |
| tests_suite | feature | composes | weak | Instance Isolation Tests are included in the suite of tests for the DreamGraph application. |
| instance_management | feature | depends_on | moderate | Instance Isolation Tests validate the policies related to instance management. |
| policy_registry | feature | depends_on | weak | Instance Isolation Tests ensure policies are correctly applied to prevent cross-instance contamination. |
| dreamgraph_extensions_vscode_src_test | feature | supports | moderate | auto-backlink |

**Tags:** testing, integration, isolation

