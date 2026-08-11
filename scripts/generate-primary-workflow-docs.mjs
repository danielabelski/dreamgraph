#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const repoRoot = process.cwd();
const workflowsPath = process.env.DREAMGRAPH_DATA_DIR
  ? path.resolve(process.env.DREAMGRAPH_DATA_DIR, 'workflows.json')
  : path.join(repoRoot, 'data', 'workflows.json');

const TARGETS = new Map([
  ['workflow_dream_cycle', path.join(repoRoot, 'docs', 'workflows', 'workflow-dream-cycle.md')],
  ['workflow_execution', path.join(repoRoot, 'docs', 'workflows', 'workflow-execution.md')],
  ['workflow_project_onboarding', path.join(repoRoot, 'docs', 'workflows', 'workflow-project-onboarding.md')],
  ['workflow_vscode_assisted_reasoning', path.join(repoRoot, 'docs', 'workflows', 'workflow-vscode-assisted-reasoning.md')],
  ['workflow_discipline_task_lifecycle', path.join(repoRoot, 'docs', 'workflows', 'workflow-discipline-task-lifecycle.md')],
  ['workflow_ui_registration_flow', path.join(repoRoot, 'docs', 'workflows', 'workflow-ui-registration-flow.md')],
  ['workflow_scheduled_cognitive_execution', path.join(repoRoot, 'docs', 'workflows', 'workflow-scheduled-cognitive-execution.md')],
  ['workflow_vscode_autonomy_continuation_loop', path.join(repoRoot, 'docs', 'workflows', 'workflow-vscode-autonomy-continuation-loop.md')],
  ['workflow_cli_enrich_pipeline', path.join(repoRoot, 'docs', 'workflows', 'workflow-cli-enrich-pipeline.md')],
  ['workflow_cli_curate_audit', path.join(repoRoot, 'docs', 'workflows', 'workflow-cli-curate-audit.md')],
  ['workflow_architect_agentic_tool_execution', path.join(repoRoot, 'docs', 'workflows', 'workflow-architect-agentic-tool-execution.md')],
]);

function escapeMermaidLabel(value) {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function normalizeStep(step, index) {
  const order = Number(step?.order ?? step?.step ?? index + 1);
  const name = String(step?.name ?? step?.action ?? `Step ${index + 1}`).trim();
  const description = String(step?.description ?? '').trim();
  return { order, name, description };
}

function normalizeWorkflow(entry) {
  const steps = Array.isArray(entry?.steps)
    ? entry.steps.map(normalizeStep).sort((a, b) => a.order - b.order)
    : [];

  return {
    id: String(entry?.id ?? '').trim(),
    name: String(entry?.name ?? '').trim(),
    description: String(entry?.description ?? '').trim(),
    trigger: String(entry?.trigger ?? '').trim(),
    source_files: Array.isArray(entry?.source_files)
      ? entry.source_files.map((item) => String(item).trim()).filter(Boolean)
      : [],
    steps,
  };
}

function buildFlowchart(steps) {
  let md = '## Flowchart\n\n';
  md += '```mermaid\nflowchart TD\n';
  steps.forEach((step, index) => {
    const sid = `S${index + 1}`;
    md += `    ${sid}["${escapeMermaidLabel(step.name)}"]\n`;
    if (index > 0) md += `    S${index} --> ${sid}\n`;
  });
  md += '```\n\n';
  return md;
}

function buildSteps(steps) {
  let md = '## Steps\n\n';
  for (const step of steps) {
    md += `### ${step.order}. ${step.name}\n\n`;
    if (step.description) {
      md += `${step.description}\n\n`;
    }
  }
  return md;
}

function buildDoc(workflow) {
  let md = `# ${workflow.name}\n\n`;
  md += '> Auto-generated primary workflow doc. Canonical structured source: data/workflows.json.\n\n';
  if (workflow.description) {
    md += `> ${workflow.description}\n\n`;
  }
  md += `**Trigger:** ${workflow.trigger || 'N/A'}  \n`;
  if (workflow.source_files.length) {
    md += `**Source files:** ${workflow.source_files.join(', ')}  \n`;
  }
  md += '\n';
  md += buildFlowchart(workflow.steps);
  md += buildSteps(workflow.steps);
  return md;
}

async function main() {
  const raw = await readFile(workflowsPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('Expected data/workflows.json to contain an array');
  }

  const byId = new Map(parsed.map((entry) => {
    const workflow = normalizeWorkflow(entry);
    return [workflow.id, workflow];
  }));

  let updated = 0;
  const missing = [];
  for (const [id, filePath] of TARGETS.entries()) {
    const workflow = byId.get(id);
    if (!workflow || !workflow.steps.length) {
      missing.push(id);
      continue;
    }
    const content = buildDoc(workflow);
    await writeFile(filePath, content, 'utf8');
    updated += 1;
  }

  if (updated === 0) {
    throw new Error(`None of the ${TARGETS.size} primary workflow ids exist with steps in ${workflowsPath}`);
  }
  console.log(`Updated ${updated} primary workflow docs from ${workflowsPath}`);
  if (missing.length > 0) {
    console.warn(`Skipped ${missing.length} workflow ids not present in the active graph: ${missing.join(', ')}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
