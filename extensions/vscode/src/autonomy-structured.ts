import type { RecommendedAction, RecommendedActionSet } from './autonomy.js';
import { rankRecommendedActions } from './autonomy.js';
import { extractPrimaryJsonEnvelope } from './autonomy-contract.js';

const GOAL_COMPLETION_RE =
  /ready for commit|done and verified|goal sufficiently reached|\b(?:original goal|goal|task|request|assessment|implementation|change|work)\b[^.\n]{0,80}\bcompleted successfully\b/i;

export interface StructuredPassEnvelope {
  summary?: string;
  goalStatus?: 'complete' | 'partial' | 'blocked';
  progressStatus?: 'advancing' | 'slowing' | 'stalled';
  uncertainty?: 'low' | 'medium' | 'high';
  nextSteps: RecommendedAction[];
}

export function extractStructuredPassEnvelope(content: string | undefined): StructuredPassEnvelope {
  // Continuation passes can have empty/undefined assistant text (tool-only or
  // aborted). Treat as a neutral envelope rather than crashing.
  const safeContent = content ?? '';
  const block = extractPrimaryJsonEnvelope(safeContent);
  if (block) {
    // Models occasionally emit malformed `recommended_next_steps` entries
    // (missing/non-string `label`, wrong shape). Filter them out before they
    // reach the continuation planner — a malformed step can otherwise crash
    // the autonomy loop the moment any code touches `step.label.toLowerCase()`,
    // which then surfaces to the user as "Error during continuation: Cannot
    // read properties of undefined (reading 'toLowerCase')" and silently
    // skips a continuation that should not have been attempted in the first
    // place.
    const nextSteps = (block.recommended_next_steps ?? [])
      .map((step, index) => toActionFromStructured(step, index + 1))
      .filter((action): action is RecommendedAction => action !== null);
    return {
      summary: block.summary ?? extractSummary(safeContent),
      goalStatus: block.goal_status ?? 'partial',
      progressStatus: block.progress_status ?? 'advancing',
      uncertainty: block.uncertainty ?? 'low',
      nextSteps,
    };
  }

  const nextSteps = extractRecommendedActions(safeContent);
  const lower = safeContent.toLowerCase();
  const goalStatus = GOAL_COMPLETION_RE.test(lower)
    ? 'complete'
    : /blocked|cannot proceed|blocking failure/.test(lower)
      ? 'blocked'
      : 'partial';
  const progressStatus = /stalled progress|no further progress|stuck/.test(lower)
    ? 'stalled'
    : /partial progress|slowing/.test(lower)
      ? 'slowing'
      : 'advancing';
  const uncertainty = /uncertain|not sure|insufficient data|confidence: low/.test(lower)
    ? 'high'
    : /partial|likely|appears|confidence: medium/.test(lower)
      ? 'medium'
      : 'low';

  return {
    summary: extractSummary(safeContent),
    goalStatus,
    progressStatus,
    uncertainty,
    nextSteps,
  };
}

export function buildRecommendedActionSetFromContent(content: string): RecommendedActionSet {
  return rankRecommendedActions(extractStructuredPassEnvelope(content).nextSteps);
}

function extractSummary(content: string): string | undefined {
  const match = content.match(/## Short description\s+([^\n]+)/i) ?? content.match(/short description:\s*([^\n]+)/i);
  return match?.[1]?.trim();
}

function extractRecommendedActions(content: string): RecommendedAction[] {
  const lines = content.split(/\r?\n/);
  // First pass: collect every bullet inside the "Recommended Next Step(s)"
  // section along with its indent. We then decide AFTER the scan which
  // indent depth represents the actual action chips — necessary because
  // models sometimes wrap the real list under a header-bullet like
  // "- Strongest safe next action:" with the actions as numbered children.
  type Bullet = { indent: number; label: string };
  const found: Bullet[] = [];
  let inSection = false;
  let sectionLevel = 0;

  // Accept any heading level (#, ##, ###, ####). Singular "step",
  // "Recommended Next Step(s)", "Next Recommended Slice", "Strongest safe
  // next action", or a plain "Recommended next steps:" prose lead-in.
  const sectionRe = /^(#{1,6})\s+(?:next recommended slice|recommended next steps?|next steps?|suggested next steps?|strongest safe next actions?)\b/i;
  const proseRe = /^(?:recommended next steps?|next steps?|strongest safe next actions?):/i;

  for (const line of lines) {
    const trimmed = line.trim();
    const sectionMatch = trimmed.match(sectionRe);
    if (sectionMatch) {
      inSection = true;
      sectionLevel = sectionMatch[1].length;
      continue;
    }
    if (proseRe.test(trimmed) && !inSection) {
      inSection = true;
      sectionLevel = 6;
      continue;
    }
    if (inSection) {
      const h = trimmed.match(/^(#{1,6})\s+/);
      if (h && h[1].length <= sectionLevel) break;
    }
    const bulletMatch = trimmed.match(/^[-*]\s+(.+)/) ?? trimmed.match(/^\d+[.)]\s+(.+)/);
    if (inSection && bulletMatch) {
      const leading = line.match(/^[ \t]*/)?.[0] ?? '';
      const indent = leading.replace(/\t/g, '  ').length;
      const label = bulletMatch[1].trim().replace(/^\*\*(.+?)\*\*$/, '$1').trim();
      if (!label) continue;
      const stripped = label.replace(/`[^`]*`/g, '').trim();
      if (!stripped) continue;
      found.push({ indent, label });
    }
  }

  if (found.length === 0) {
    const single = content.match(/next recommended slice:\s*([^\n]+)/i)
      ?? content.match(/next recommended step:\s*([^\n]+)/i)
      ?? content.match(/recommended next step:\s*([^\n]+)/i);
    if (single?.[1]) {
      const action = toAction(single[1].trim(), 1);
      return action ? [action] : [];
    }
    return [];
  }

  // Pick the action-bullet depth.
  // Default: the shallowest indent we saw. But if that depth contains exactly
  // one bullet AND that bullet's text reads like a header (ends with ":" or
  // is a known wrapper phrase), then descend to the NEXT shallower depth
  // — those are the real actions.
  const minIndent = Math.min(...found.map((b) => b.indent));
  const topLevel = found.filter((b) => b.indent === minIndent);
  const isHeaderBullet = (label: string) =>
    label.endsWith(':') || /^strongest safe next actions?\s*:?$/i.test(label);

  let actionsAtIndent: number;
  if (topLevel.length === 1 && isHeaderBullet(topLevel[0].label)) {
    const deeper = found
      .filter((b) => b.indent > minIndent)
      .map((b) => b.indent);
    actionsAtIndent = deeper.length > 0 ? Math.min(...deeper) : minIndent;
  } else {
    actionsAtIndent = minIndent;
  }

  let priority = 1;
  return found
    .filter((b) => b.indent === actionsAtIndent && !isHeaderBullet(b.label))
    .map((b) => toAction(b.label, priority++))
    .filter((action): action is RecommendedAction => action !== null);
}

function toAction(label: unknown, priority: number): RecommendedAction | null {
  // Coerce defensively: structured envelopes occasionally arrive with
  // non-string labels (number, null, nested object) when the model
  // hallucinates the schema. Reject anything that doesn't yield a
  // non-empty trimmed string — a step with no human-readable label is
  // not actionable anyway.
  const labelStr = typeof label === 'string' ? label.trim() : '';
  if (!labelStr) return null;
  const id = labelStr
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || `action-${priority}`;
  const batchGroup = /clickable|webview|ui|header|status/.test(labelStr.toLowerCase()) ? 'ui' : undefined;
  return {
    id,
    label: labelStr,
    priority,
    eligible: true,
    withinScope: true,
    batchGroup,
  };
}

function toActionFromStructured(step: {
  id?: string;
  label: string;
  rationale?: string;
  priority?: number;
  eligible?: boolean;
  within_scope?: boolean;
  mutually_exclusive_with?: string[];
  batch_group?: string;
  tool?: string;
  tool_args?: Record<string, unknown>;
}, fallbackPriority: number): RecommendedAction | null {
  const normalized = toAction(step.label, step.priority ?? fallbackPriority);
  if (!normalized) return null;
  return {
    ...normalized,
    id: step.id?.trim() || normalized.id,
    rationale: step.rationale,
    priority: step.priority ?? fallbackPriority,
    eligible: step.eligible ?? true,
    withinScope: step.within_scope ?? true,
    mutuallyExclusiveWith: step.mutually_exclusive_with,
    batchGroup: step.batch_group ?? normalized.batchGroup,
    tool: typeof step.tool === 'string' && step.tool.trim() ? step.tool.trim() : undefined,
    toolArgs: step.tool_args && typeof step.tool_args === 'object' ? step.tool_args : undefined,
  };
}
