# Anthropic Architect Configuration and Claude Migration

This document describes how DreamGraph's VS Code architect integrates with Anthropic models, with guidance for **Claude Opus 4.7**, **Claude Fable 5**, and **Claude Mythos 5**.

## Current DreamGraph defaults

DreamGraph currently keeps **`claude-opus-4-7`** as the default Anthropic Architect model. `claude-fable-5` and `claude-mythos-5` are first-class selectable options, but they do not change first-run behavior.

Why:

- ADR-150 locks the Anthropic default to Opus 4.7 and xhigh effort until a superseding ADR is accepted
- Fable 5 can be adopted explicitly without requiring `Custom...`
- Mythos 5 may require Anthropic account access and must not be presented as generally available

## Relevant VS Code settings

DreamGraph exposes these extension settings:

- `dreamgraph.architect.provider`
- `dreamgraph.architect.model`
- `dreamgraph.architect.anthropic.effort`
- `dreamgraph.architect.anthropic.adaptiveThinking`
- `dreamgraph.architect.anthropic.showThinkingSummary`

Recommended starting values:

| Model | Recommended effort | Adaptive thinking | Thinking summary |
|---|---|---:|---:|
| `claude-opus-4-7` | `xhigh` for coding/agentic work | on | on |
| `claude-fable-5` | `xhigh` for coding/agentic work | on | on |
| `claude-mythos-5` | `xhigh`, if the account has access | on | on |
| `claude-opus-4-6` | `high` | off or conservative | optional |

Example settings:

```json
{
  "dreamgraph.architect.provider": "anthropic",
  "dreamgraph.architect.model": "claude-fable-5"
}
```

```json
{
  "dreamgraph.architect.provider": "anthropic",
  "dreamgraph.architect.model": "claude-mythos-5"
}
```

## Implemented DreamGraph behavior

Current Architect behavior for Anthropic requests:

- **Opus 4.7** remains the governed default selection.
- **Fable 5** and **Mythos 5** are directly selectable in VS Code and standalone Architect surfaces.
- **Mythos 5** selection only sends the configured model string; Anthropic account access controls may still reject unauthorized calls.
- If effort is configured as `xhigh` while using **Opus 4.6**, DreamGraph clamps it to `high` for compatibility.
- For **Opus 4.7**, **Opus 4.8**, **Fable 5**, and **Mythos 5**, DreamGraph sends `output_config.effort` and can send adaptive thinking with optional summarized visibility.
- For unknown custom `claude-*` IDs, DreamGraph avoids adaptive thinking and provider-specific beta fields.

## Claude Opus 4.7 API migration notes

Anthropic changed several Messages API behaviors for Opus 4.7.

### 1. Extended thinking budgets are removed

Old pattern:

```python
client.messages.create(
    model="claude-opus-4-6",
    max_tokens=64000,
    thinking={"type": "enabled", "budget_tokens": 32000},
    messages=[{"role": "user", "content": "..."}],
)
```

New pattern:

```python
client.messages.create(
    model="claude-fable-5",
    max_tokens=128000,
    thinking={"type": "adaptive"},
    output_config={"effort": "xhigh"},
    messages=[{"role": "user", "content": "..."}],
)
```

For DreamGraph this means:

- do not send `thinking: { type: "enabled", budget_tokens: N }` to Opus 4.7, Opus 4.8, Fable 5, or Mythos 5
- use adaptive thinking instead for the supported model IDs
- control depth primarily through `output_config.effort`
- omit non-default sampling parameters unless a later provider contract explicitly supports them

### 2. Effort matters more on Opus 4.7

Anthropic guidance indicates:

- `xhigh` is the recommended default for coding and agentic use cases
- `high` is a strong minimum for intelligence-sensitive work
- `medium` and `low` should be treated as deliberate cost/latency trade-offs
- `max` may improve some difficult tasks but can increase token use and overthinking risk

Practical DreamGraph guidance:

- use `xhigh` for graph-grounded coding, architecture analysis, and multi-step tool orchestration on Opus 4.7
- keep `claude-opus-4-7` as the stable default model unless an accepted ADR supersedes ADR-150
- use explicit user settings to move a workspace to Fable 5 or Mythos 5

### 3. Thinking summaries are no longer implicit

On Opus 4.7, thinking content is omitted by default unless explicitly requested.

If your product benefits from visible reasoning progress during long-running traces, opt in:

```python
thinking = {
    "type": "adaptive",
    "display": "summarized",
}
```

For DreamGraph this maps to:

- `dreamgraph.architect.anthropic.showThinkingSummary = true`

This is especially relevant for chat UX because otherwise long reasoning phases may appear as a silent pause.

### 4. Sampling knobs should be omitted

Anthropic documents that non-default `temperature`, `top_p`, and `top_k` values can cause 400 errors on Opus 4.7.

DreamGraph guidance:

- omit non-default sampling parameters for Opus 4.7 requests
- steer behavior with prompting, effort, and task shaping instead

### 5. Token budgeting should be re-baselined

Opus 4.7 uses a newer tokenizer and may consume more tokens than Opus 4.6 for the same text.

Implications for DreamGraph:

- re-check `max_tokens` assumptions for long Architect interactions
- re-test any token estimation logic
- leave extra headroom for graph-grounded tool traces, especially at `xhigh` or `max`

Anthropic recommends starting around **64k max output tokens** for `xhigh` or `max` effort configurations.

### 6. High-resolution image support changes cost and behavior

Opus 4.7 supports higher-resolution images automatically:

- up to **2576 px / 3.75 MP**
- previous practical cap was **1568 px / 1.15 MP**

Implications:

- better screenshot, artifact, and document understanding
- simpler coordinate handling because coordinates are 1:1 with actual pixels
- potentially much higher token usage for image-heavy prompts

Recommendation:

- downsample images before sending when the extra fidelity is unnecessary
- re-budget image-heavy Architect workflows

## Task budgets

Anthropic introduced **task budgets** for Opus 4.7 as a beta feature.

These are advisory budgets across the full agentic loop, including:

- thinking
- tool calls
- tool results
- final output

DreamGraph does **not** need to enable this by default.

Recommended posture:

- do not default task budgets on for open-ended architecture and coding work
- consider them later for constrained, budget-sensitive workflows
- treat them separately from `max_tokens`, which remains a hard cap

## Suggested migration checklist for DreamGraph users

- Update model name to `claude-opus-4-7`, `claude-fable-5`, or `claude-mythos-5` when ready.
- Use Mythos 5 only when the Anthropic account has access.
- Remove non-default `temperature`, `top_p`, and `top_k` from modern Claude request payloads.
- Replace old extended thinking budgets with adaptive thinking plus effort.
- Explicitly enable summarized thinking if your UX depends on visible progress.
- Re-test token usage, latency, and cost.
- Re-tune `max_tokens` for long-running Architect tasks.
- Re-budget image-heavy workloads because high-resolution vision can use materially more tokens.
- Review prompts for modern Claude models' more literal instruction following and different verbosity calibration.

## Prompting considerations

Anthropic's migration guidance suggests Opus 4.7 is:

- more literal
- more direct in tone
- less likely to overuse tools by default
- more sensitive to effort level

That means DreamGraph operators should:

- be more explicit in tool-use and output-shape instructions
- prefer positive examples over vague warnings
- tune prompts for desired verbosity rather than assuming a stable baseline
- raise effort instead of trying to prompt around under-thinking on complex tasks

## External reference

Anthropic migration guide:

- https://platform.claude.com/docs/en/about-claude/models/migration-guide#migrating-to-claude-opus-4-7
