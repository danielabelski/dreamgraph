# SDK testing harness

M1 testing is schema-only and packaging-focused. It intentionally does not execute third-party plugin code or load runtime plugins.

## Required checks

- `npm run build`
- `npm test`
- `npm pack --workspace @dreamgraph/sdk`
- `npm pack --workspace @dreamgraph/host`
- install the packed tarballs into a scratch consumer and verify public ESM imports

## Manifest fixtures

The minimum fixture set locks the M1 contract:

- valid minimal manifest
- missing `id`
- invalid capability
- invalid tool prefix
- invalid resource namespace

## Out of scope for M1

- runtime plugin discovery
- plugin execution sandboxes
- host capability enforcement gates
- end-to-end event emission from external plugins
- Gemini/provider integration
