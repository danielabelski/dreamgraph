import type { RecommendedAction, RecommendedActionSet } from './autonomy.js';
import { rankRecommendedActions } from './autonomy.js';
import { extractPrimaryJsonEnvelope } from './autonomy-contract.js';

export interface StructuredPassEnvelope {
  summary?: string;
  goalStatus?: 'complete' | 'partial' | 'blocked';
  progressStatus?: 'advancing' | 'slowing' | 'stalled';
  uncertainty?: 'low' | 'medium' | 'high';
  nextSteps: RecommendedAction[];
}

export function extractStructuredPassEnvelope(content: string): StructuredPassEnvelope {
  const block = extractPrimaryJsonEnvelope(content);
  if (block) {
    const nextSteps = (block.recommended_next_steps ?? []).map((step, index) => toActionFromStructured(step, index + 1));
    return {
      summary: block.summary ?? extractSummary(content),
      goalStatus: block.goal_status ?? 'partial',
      progressStatus: block.progress_status ?? 'advancing',
      uncertainty: block.uncertainty ?? 'low',
      nextSteps,
    };
  }

  const nextSteps = extractRecommendedActions(content);
  const lower = content.toLowerCase();
  const goalStatus = /goal sufficiently reached|done and verified|completed successfully|ready for commit/.test(lower)
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
    summary: extractSummary(content),
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
  const collected: RecommendedAction[] = [];
  let inSection = false;
  let sectionLevel = 0;
  let priority = 1;
  // Indent (in spaces; tab=2) of the first top-level bullet seen in the section.
  // Subsequent bullets must match this indent — deeper bullets are sub-detail
  // (e.g. "verify /metrics" under "Smoke test the new metrics surfaces") and
  // must NOT become their own action chips.
  let topBulletIndent: number | null = null;

  // Accept any heading level (#, ##, ###, ####). LLMs frequently emit ###
  // for sub-sections inside a SUMMARY card. Also accept singular "step",
  // "Recommended Next Step(s)", "Next Recommended Slice", or a plain
  // "Recommended next steps:" prose lead-in.
  const sectionRe = /^(#{1,6})\s+(?:next recommended slice|recommended next steps?|next steps?|suggested next steps?)\b/i;
  const proseRe = /^(?:recommended next steps?|next steps?):/i;

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
      sectionLevel = 6; // any subsequent heading ends the section
      continue;
    }
    // Section ends at the next heading of the same or shallower depth.
    if (inSection) {
      const h = trimmed.match(/^(#{1,6})\s+/);
      if (h && h[1].length <= sectionLevel) {
        break;
      }
    }
    const bulletMatch = trimmed.match(/^[-*]\s+(.+)/) ?? trimmed.match(/^\d+[.)]\s+(.+)/);
    if (inSection && bulletMatch) {
      // Compute indent of this bullet (tabs count as 2 spaces).
      const leading = line.match(/^[ \t]*/)?.[0] ?? '';
      const indent = leading.replace(/\t/g, '  ').length;
      if (topBulletIndent === null) {
        topBulletIndent = indent;
      } else if (indent > topBulletIndent) {
        // Sub-bullet — supporting detail, not its own action.
        continue;
      }
      // Strip surrounding bold markers so chip labels stay clean.
      const label = bulletMatch[1].trim().replace(/^\*\*(.+?)\*\*$/, '$1').trim();
      if (!label) continue;
      // Skip sub-bullets that are obviously continuation detail (very short
      // code-only fragments like `npm run build`). Heuristic: must contain
      // at least one whitespace-separated word outside backticks.
      const stripped = label.replace(/`[^`]*`/g, '').trim();
      if (!stripped) continue;
      collected.push(toAction(label, priority++));
      continue;
    }
  }

  if (collected.length > 0) {
    return collected;
  }

  const single = content.match(/next recommended slice:\s*([^\n]+)/i)
    ?? content.match(/next recommended step:\s*([^\n]+)/i)
    ?? content.match(/recommended next step:\s*([^\n]+)/i);
  if (single?.[1]) {
    return [toAction(single[1].trim(), 1)];
  }

  return [];
}

function toAction(label: string, priority: number): RecommendedAction {
  const id = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || `action-${priority}`;
  const batchGroup = /clickable|webview|ui|header|status/.test(label.toLowerCase()) ? 'ui' : undefined;
  return {
    id,
    label,
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
}, fallbackPriority: number): RecommendedAction {
  const normalized = toAction(step.label, step.priority ?? fallbackPriority);
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
