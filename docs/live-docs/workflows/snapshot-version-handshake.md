# Snapshot Version Handshake

> A compatibility workflow that validates Explorer graph snapshots against the client-supported snapshot version before graph consumption proceeds.. Intent: This workflow should exist because fetchSnapshot enforces EXPECTED_SNAPSHOT_VERSION and throws SnapshotVersionError, making compatibility checking an explicit gate in the client data-loading path.

**Trigger:** derived from grounded behavioral evidence  

