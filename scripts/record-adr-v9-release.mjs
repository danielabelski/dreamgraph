import { recordADR } from '../dist/tools/adr-historian.js';

const adr = await recordADR({
  title: 'DreamGraph v9.0.0 Lattice is the released baseline and SDK roadmap M0-M6 is complete, tested, documented, committed, and tagged',
  decided_by: 'collaborative',
  problem: 'The repository now presents DreamGraph v9.0.0 (Lattice) as the active release with the Plugin SDK roadmap completed through M6, but the graph still needed an authoritative release-state decision tying together versioning, test verification, documentation baseline, commit/tag evidence, and release governance so future reasoning does not treat M0-M6 as merely planned or partially delivered.',
  constraints: [
    'Release-state facts recorded in the graph must be grounded in direct repo and git evidence rather than inferred from roadmap intent alone.',
    'The release claim must unify core package version, workspace package versions, SDK/host package versions, documentation baseline, tests, and git tag state.',
    'M4 schedule actions remain explicitly deferred even while M0-M6 is considered implemented overall.',
    'Graph updates available in this surface are ADR-oriented rather than generic entity upserts, so the release baseline must be captured via ADR semantics.'
  ],
  affected_entities: [
    'repository_dreamgraph',
    'packages/sdk/package.json',
    'packages/host/package.json',
    'package.json',
    'RELEASE_NOTES_v9.0.0.md',
    'docs/sdk/plugin-developer-guide/00-index.md',
    'docs/sdk/plugin-reference/00-index.md',
    'docs/architecture.md',
    'guide/02-installation.md',
    'tests/plugins/manager.test.ts',
    'tests/plugins/hello-events-e2e.test.ts',
    'tests/webhooks/sign.test.ts',
    'tests/webhooks/store.test.ts',
    'tests/webhooks/worker.test.ts',
    'tests/plugins/archetypes-seam.test.ts',
    'tests/plugins/policies-seam.test.ts',
    'tests/plugins/markdown-fences-seam.test.ts',
    'tests/plugins/ui-seam.test.ts',
    'ADR-137',
    'ADR-138'
  ],
  chosen: 'Treat DreamGraph v9.0.0 "Lattice" as the authoritative released baseline in the graph. Record that the root package, @dreamgraph/sdk, and @dreamgraph/host are all versioned 9.0.0; git tag v9.0.0 exists; release commits identify the v9.0.0 release; release notes explicitly mark Plugin SDK milestones M0→M6 complete; docs/sdk baselines declare v9.0.0 with M0-M6 implemented; and the root test suite passes, including M4 contribution tests, M5 webhook suites, M6 closure seam suites, plugin lifecycle tests, and hello-events end-to-end validation. The graph should therefore reason about M0-M6 as shipped platform capability for v9.0.0, with the caveat that M4 schedule actions remain deferred as documented.',
  alternatives: [
    {
      option: 'Wait for external registry publish metadata before recording release state in the graph',
      rejected_because: 'The repository and git evidence already establish the authoritative project release baseline needed for architectural reasoning, even if external package-registry confirmation is out of scope here.'
    },
    {
      option: 'Record only a softer statement that v9.0.0 is documented but not necessarily released',
      rejected_because: 'That would understate available evidence: package versions are 9.0.0, git tag v9.0.0 exists, release commits are present, release notes and docs align, and the full test suite passed locally.'
    }
  ],
  expected_consequences: [
    'Future graph queries can safely treat DreamGraph v9.0.0 as the active released baseline rather than a draft milestone.',
    'The SDK roadmap through M6 can be reasoned about as implemented/shipped capability, reducing repeated source verification.',
    'Release notes, docs, tests, and git state become semantically unified in the graph under one release-governance decision.',
    'Subsequent releases can supersede this baseline explicitly with later ADRs.'
  ],
  risks: [
    'This ADR records repository/gittag release truth, not third-party registry audit proof for every publish target.',
    'Some graph feature/workflow nodes may still require later normalization even though the release baseline is now recorded.'
  ],
  guard_rails: [
    'Do not describe DreamGraph v9.0.0 or SDK M0-M6 as unreleased, incomplete, or roadmap-only unless this ADR is superseded.',
    'Do not claim M4 schedule actions shipped in v9.0.0; they remain explicitly deferred in the release baseline.',
    'Do not downgrade @dreamgraph/sdk or @dreamgraph/host below stable 9.0.0 release status without a superseding ADR.',
    'Do not treat plugin lifecycle, M5 webhook, or M6 seam coverage as unverified for v9.0.0 while this ADR stands.'
  ],
  tags: ['release', 'v9.0.0', 'sdk', 'plugins', 'm0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'testing', 'documentation']
});

if (!adr) {
  console.error('Failed to record ADR');
  process.exit(1);
}

console.log(JSON.stringify({ success: true, adr_id: adr.id, title: adr.title }, null, 2));
