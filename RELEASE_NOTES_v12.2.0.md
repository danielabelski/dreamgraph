# DreamGraph v12.2.0 - Trust Calibration and Reviewable Cognition

DreamGraph v12.2.0 sharpens the standalone Architect and cognitive projection surfaces around trust calibration, reviewability, provenance, lifecycle visibility, and bounded creativeness.

## Highlights

- Added a shared cognitive trust-state contract for accepted facts, validated insights, advisory candidates, latent/speculative links, rejected links, expired artifacts, and human-reviewed decisions.
- Added evidence-ledger projections for dream playback candidates and promoted edges, grouped by source class with semantic anchors first.
- Added precision categories for tension clustering: duplicate edge, insufficient evidence, missing fact-graph entity, stale/expired artifact, and actionable architecture gap.
- Added lifecycle transition projections for superseded futures, retired/resolved/expired tensions, and expired insight or narrative-style cognitive artifacts.
- Added a repeatable Architect calibration evaluation endpoint at `GET /api/architect/v1/calibration/evaluation`.
- Updated product vocabulary to position DreamGraph as a governed architecture cognition layer rather than a generic memory product.

## Architect API Additions

- `GET /api/architect/v1/lifecycle` returns lifecycle transition chains with prior state, new state, timestamp/source, authority, triggering evidence, superseding artifact, and remaining uncertainty.
- `GET /api/architect/v1/calibration/evaluation` reports trust-state distribution, evidence completeness, stale/expired artifact rate, uncertainty labeling, lifecycle explainability, operator review outcomes, and speculative reviewability.

## Verification

- `npx vitest run tests/architect-pulse.test.ts tests/living-dreamgraph-projections.test.ts`
- `npm run build:server`
- `npm run build:explorer`

Rejected, retired, expired, and superseded artifacts remain inspectable historical context. Dream output remains advisory until backed by source, tests, ADRs, governed workflow evidence, daemon validation, or explicit human review.
