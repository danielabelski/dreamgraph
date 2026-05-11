"use strict";
/**
 * card-renderer.ts — Slice 3 structured card rendering.
 *
 * Exports a script-string generator for the webview. The script exposes
 * window.registerCardFencePlugin(md), which installs a markdown-it fence rule
 * handling these language tags:
 *   - entity
 *   - adr
 *   - tension
 *   - insight
 *
 * Contract from TDD:
 * - cards are driven exclusively by fenced blocks in LLM output
 * - malformed card bodies fall back to regular fenced code blocks
 * - unknown fence types are untouched
 * - no crash, no partial broken DOM
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getCardRendererScript = getCardRendererScript;
function getCardRendererScript() {
    return `
    (function() {
      function escHtml(s) {
        return String(s)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
      }

      function escAttr(s) {
        return String(s)
          .replace(/&/g, '&amp;')
          .replace(/"/g, '&quot;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
      }

      function parseCardBody(src) {
        const lines = String(src || '').replace(/\\r\\n/g, '\\n').split('\\n');
        const out = { fields: {}, bodyLines: [] };
        let inBody = false;
        for (const line of lines) {
          const match = !inBody ? line.match(/^([A-Za-z][A-Za-z0-9_-]*):\\s*(.*)$/) : null;
          if (match) {
            out.fields[match[1].toLowerCase()] = match[2];
            continue;
          }
          if (line.trim() === '' && Object.keys(out.fields).length > 0 && !inBody) {
            inBody = true;
            continue;
          }
          if (inBody || line.trim() !== '') {
            inBody = true;
            out.bodyLines.push(line);
          }
        }
        out.body = out.bodyLines.join('\\n').trim();
        return out;
      }

      function normalizeCard(type, parsed) {
        const f = parsed.fields || {};
        if (type === 'entity') {
          if (!f.id && !f.name) return null;
          return {
            title: f.name || f.id,
            subtitle: f.id ? 'ID: ' + f.id : '',
            meta: [f.kind, f.status].filter(Boolean),
            body: parsed.body || f.description || '',
          };
        }
        if (type === 'adr') {
          if (!f.id && !f.title) return null;
          return {
            title: (f.id ? f.id + ': ' : '') + (f.title || f.id),
            subtitle: f.status ? 'Status: ' + f.status : '',
            meta: [f.decided_by, f.date].filter(Boolean),
            body: parsed.body || f.chosen || f.summary || '',
          };
        }
        if (type === 'tension') {
          if (!f.id && !f.title && !parsed.body) return null;
          return {
            title: f.title || f.id || 'Tension',
            subtitle: f.id ? 'ID: ' + f.id : '',
            meta: [f.severity, f.status].filter(Boolean),
            body: parsed.body || f.description || '',
          };
        }
        if (type === 'insight') {
          if (!f.title && !parsed.body) return null;
          return {
            title: f.title || 'Insight',
            subtitle: f.confidence ? 'Confidence: ' + f.confidence : '',
            meta: [f.kind, f.source].filter(Boolean),
            body: parsed.body || f.summary || '',
          };
        }
        if (type === 'outcome') {
          // Patch #1 (renderer invariant): every action result is a typed,
          // collapsible OutcomeCard. The payload body is hidden behind an
          // inner <details> so raw JSON never leaks into the chat surface.
          var status = (f.status || 'ok').toLowerCase();
          var statusLabel = status === 'error' || status === 'fail' ? 'ERROR' : 'OK';
          return {
            title: f.tool ? ('Tool: ' + f.tool) : 'Action result',
            subtitle: f.summary || '',
            meta: [statusLabel, f.duration_ms ? (f.duration_ms + 'ms') : null].filter(Boolean),
            body: parsed.body || '',
            collapsedBody: true,
          };
        }
        return null;
      }

      function renderCard(type, normalized) {
        const title = escHtml(normalized.title || '');
        const subtitle = normalized.subtitle ? '<div class="dg-card-subtitle">' + escHtml(normalized.subtitle) + '</div>' : '';
        const meta = Array.isArray(normalized.meta) && normalized.meta.length > 0
          ? '<div class="dg-card-meta">' + normalized.meta.map(function(item) { return '<span class="dg-card-chip">' + escHtml(item) + '</span>'; }).join('') + '</div>'
          : '';
        var body = '';
        if (normalized.body) {
          if (normalized.collapsedBody) {
            // Payload tucked away — preserves whitespace, never markdown-injects.
            body = '<details class="dg-card-payload"><summary>Show payload</summary>' +
              '<pre class="dg-card-payload-pre">' + escHtml(normalized.body) + '</pre>' +
            '</details>';
          } else {
            body = '<div class="dg-card-body">' + escHtml(normalized.body).replace(/\\n/g, '<br>') + '</div>';
          }
        }
        var openAttr = normalized.collapsedBody ? '' : ' open';
        return '<details class="dg-card dg-card-' + escAttr(type) + '"' + openAttr + '>' +
          '<summary class="dg-card-summary">' +
            '<span class="dg-card-type">' + escHtml(type.toUpperCase()) + '</span>' +
            '<span class="dg-card-title">' + title + '</span>' +
          '</summary>' +
          '<div class="dg-card-content">' + subtitle + meta + body + '</div>' +
        '</details>';
      }

      function renderEnvelope(env) {
        var html = '<div class="dg-envelope">';
        html += '<div class="dg-envelope-title">SUMMARY</div>';
        html += '<div class="dg-envelope-summary">' + escHtml(env.summary) + '</div>';
        html += '<div class="dg-envelope-meta">';
        if (env.goal_status) {
          html += '<span class="dg-envelope-pill dg-pill-' + escAttr(env.goal_status) + '">' + escHtml(env.goal_status) + '</span>';
        }
        if (env.progress_status) {
          html += '<span class="dg-envelope-pill dg-pill-' + escAttr(env.progress_status) + '">' + escHtml(env.progress_status) + '</span>';
        }
        if (env.uncertainty) {
          html += '<span class="dg-envelope-pill">' + escHtml('uncertainty: ' + env.uncertainty) + '</span>';
        }
        html += '</div>';

        var steps = Array.isArray(env.recommended_next_steps) ? env.recommended_next_steps : [];
        if (steps.length > 0) {
          // Per user rule: never render a button that hides what it does.
          // Drop steps whose visible label would be a synthetic "Step N"
          // placeholder, and synthesize a useful label from the rationale
          // when the model omitted one. Any step lacking BOTH a usable
          // label/rationale AND a tool binding is silently skipped — a
          // dead button is worse than no button.
          var rendered = [];
          for (var i = 0; i < steps.length; i++) {
            var step = steps[i] || {};
            var rawLabel = (typeof step.label === 'string' ? step.label : '').trim();
            var rationale = (typeof step.rationale === 'string' ? step.rationale : '').trim();
            var hasToolBinding = !!(step.tool && String(step.tool).trim());
            // Reject placeholder labels like "Step 1", "step 2", "Step N".
            var looksGeneric = /^step\s*\d+$/i.test(rawLabel) || /^todo$/i.test(rawLabel);
            var label = rawLabel && !looksGeneric ? rawLabel : '';
            if (!label && rationale) {
              label = rationale.length > 60 ? rationale.slice(0, 57).trim() + '…' : rationale;
            }
            if (!label && hasToolBinding) {
              label = 'Run ' + String(step.tool);
            }
            if (!label) continue; // skip dead button
            rendered.push({ id: step.id || '', label: label, title: rationale, raw: step });
          }
          if (rendered.length > 0) {
            html += '<div class="dg-envelope-actions">';
            html += '<div class="dg-envelope-actions-label">Suggested Actions</div>';
            for (var j = 0; j < rendered.length; j++) {
              var r = rendered[j];
              html += '<button class="action-chip dg-envelope-action" data-action-id="' + escAttr(r.id) + '"' +
                      ' data-action-label="' + escAttr(r.label) + '"' +
                      (r.title ? ' title="' + escAttr(r.title) + '"' : '') + '>' +
                      escHtml(r.label) + '</button>';
            }
            if (rendered.length > 1) {
              html += '<button class="action-chip action-chip-all dg-envelope-do-all">Do all</button>';
            }
            html += '</div>';
          }
        }
        html += '</div>';
        return html;
      }

      window.renderEnvelope = renderEnvelope;

      // SYNC: keep the helpers below in lockstep with src/envelope-utils.ts.
      // The host parser (autonomy-contract.ts -> envelope-utils.ts) and this
      // webview parser must agree on which shapes count as envelopes; any
      // divergence resurfaces the bug where the bubble shows raw JSON while
      // autonomy silently drops the next-step list.

      // String-aware helpers so we don't corrupt summary content that contains
      // // or , ] sequences inside legitimate strings.
      function stripCommentsOutsideStrings(input) {
        var out = '', i = 0, inString = false, quote = '', esc = false;
        while (i < input.length) {
          var ch = input[i];
          if (inString) {
            out += ch;
            if (esc) { esc = false; i++; continue; }
            if (ch === '\\\\') { esc = true; i++; continue; }
            if (ch === quote) { inString = false; quote = ''; }
            i++; continue;
          }
          if (ch === '"' || ch === "'") { inString = true; quote = ch; out += ch; i++; continue; }
          if (ch === '/' && input[i + 1] === '/') {
            while (i < input.length && input[i] !== '\\n') i++;
            continue;
          }
          if (ch === '/' && input[i + 1] === '*') {
            i += 2;
            while (i < input.length && !(input[i] === '*' && input[i + 1] === '/')) i++;
            i += 2;
            continue;
          }
          out += ch; i++;
        }
        return out;
      }

      function stripTrailingCommasOutsideStrings(input) {
        var out = '', i = 0, inString = false, quote = '', esc = false;
        while (i < input.length) {
          var ch = input[i];
          if (inString) {
            out += ch;
            if (esc) { esc = false; i++; continue; }
            if (ch === '\\\\') { esc = true; i++; continue; }
            if (ch === quote) { inString = false; quote = ''; }
            i++; continue;
          }
          if (ch === '"' || ch === "'") { inString = true; quote = ch; out += ch; i++; continue; }
          if (ch === ',') {
            var j = i + 1;
            while (j < input.length && /\\s/.test(input[j])) j++;
            if (input[j] === '}' || input[j] === ']') { i++; continue; }
          }
          out += ch; i++;
        }
        return out;
      }

      // Repair common JSON quirks that providers (esp. Claude w/ extended thinking)
      // emit and that strict JSON.parse rejects. Mirrors envelope-utils.ts.
      function repairJsonish(src) {
        var s = String(src || '');
        if (!s) return s;
        s = s.replace(/\\u00A0/g, ' ');                          // NBSP -> space
        s = s.replace(/[\\u201C\\u201D\\u201E\\u201F]/g, '"');   // smart double quotes
        s = s.replace(/[\\u2018\\u2019\\u201A\\u201B]/g, "'");   // smart single quotes
        s = stripCommentsOutsideStrings(s);
        s = stripTrailingCommasOutsideStrings(s);
        return s.trim();
      }

      function isEnvelopeShape(obj) {
        if (!obj || typeof obj !== 'object') return false;
        // Canonical envelopes have a string summary; drifted (gpt-5.5 et al.)
        // envelopes may omit summary entirely. normalizeLooseEnvelope() will
        // synthesize a string summary before this gate is reached, so accept
        // anything with envelope-marker keys.
        var hasEnvelopeKeys = ('goal_status' in obj) || ('recommended_next_steps' in obj) || ('progress_status' in obj);
        return hasEnvelopeKeys && (typeof obj.summary === 'string' || hasEnvelopeKeys);
      }

      // Normalize loose / drifted envelope shapes that LLMs emit into the canonical
      // shape that isEnvelopeShape + renderEnvelope expect.
      // SYNC: keep in lockstep with src/envelope-utils.ts normalizeLooseEnvelope.
      // Drifts handled:
      //   A) summary is a nested object { discovered, changed, current_state, ... }
      //   B) singular recommended_next_step -> plural array
      //   C) progress_status / uncertainty as nested objects (gpt-5.5)
      //   D) goal_status outside the {complete|partial|blocked} enum
      //   E) recommended_next_steps[*].actions sub-arrays -> folded into rationale
      function normalizeLooseEnvelope(obj) {
        if (!obj || typeof obj !== 'object') return obj;
        var out = Object.assign({}, obj);

        // ── Drift A: nested-summary wrapper ─────────────────────────────────
        if (typeof out.summary === 'object' && out.summary !== null && !Array.isArray(out.summary)) {
          var inner = out.summary;
          var parts = [];
          if (typeof inner.summary === 'string' && inner.summary.trim()) parts.push(inner.summary.trim());
          function pushList(label, key) {
            var v = inner[key];
            if (Array.isArray(v) && v.length) parts.push(label + ': ' + v.join(' | '));
          }
          pushList('Discovered', 'discovered');
          pushList('Changed', 'changed');
          pushList('Current state', 'current_state');
          var nextSteps = out.recommended_next_steps || inner.recommended_next_steps;
          if (!Array.isArray(nextSteps)) {
            var single = out.recommended_next_step || inner.recommended_next_step;
            if (typeof single === 'string' && single.trim()) nextSteps = [{ id: 'next', label: single.trim() }];
            else if (single && typeof single === 'object') nextSteps = [single];
          }
          out.summary = parts.join('\\n\\n') || (typeof inner.summary === 'string' ? inner.summary : '');
          out.goal_status = out.goal_status || inner.goal_status;
          out.progress_status = out.progress_status || inner.progress_status;
          out.uncertainty = out.uncertainty || inner.uncertainty;
          out.recommended_next_steps = Array.isArray(nextSteps) ? nextSteps : [];
        }

        // ── Drift B: singular -> plural at top level ────────────────────────
        if (typeof out.summary === 'string' && !out.recommended_next_steps && out.recommended_next_step) {
          var s = out.recommended_next_step;
          out.recommended_next_steps = typeof s === 'string'
            ? [{ id: 'next', label: s }]
            : (s && typeof s === 'object' ? [s] : []);
        }

        // ── Drift C: nested progress_status / uncertainty (gpt-5.5) ─────────
        var progressNarrative = '';
        if (out.progress_status && typeof out.progress_status === 'object' && !Array.isArray(out.progress_status)) {
          var ps = out.progress_status;
          var completed = Array.isArray(ps.completed_this_run) ? ps.completed_this_run : [];
          var remaining = Array.isArray(ps.remaining_work) ? ps.remaining_work : [];
          var changed = Array.isArray(ps.changed_artifacts_this_run) ? ps.changed_artifacts_this_run : [];
          var sb = [];
          if (completed.length) sb.push('Completed this run: ' + completed.map(String).join(' | '));
          if (changed.length) sb.push('Changed: ' + changed.map(String).join(' | '));
          if (remaining.length) sb.push('Remaining: ' + remaining.map(String).join(' | '));
          progressNarrative = sb.join('\\n\\n');
          out.progress_status = (completed.length === 0 && changed.length === 0 && remaining.length > 0)
            ? 'stalled' : 'advancing';
        }
        if (out.uncertainty && typeof out.uncertainty === 'object' && !Array.isArray(out.uncertainty)) {
          var lvl = typeof out.uncertainty.level === 'string' ? out.uncertainty.level.toLowerCase() : '';
          out.uncertainty = (lvl === 'low' || lvl === 'medium' || lvl === 'high') ? lvl : 'low';
        }

        // ── Drift D: goal_status synonyms ───────────────────────────────────
        if (typeof out.goal_status === 'string') {
          var g = out.goal_status.toLowerCase();
          if (g !== 'complete' && g !== 'partial' && g !== 'blocked') {
            out.goal_status = (g === 'done' || g === 'finished' || g === 'success') ? 'complete'
              : (g === 'incomplete' || g === 'in_progress' || g === 'in-progress') ? 'partial'
              : (g === 'failed' || g === 'error') ? 'blocked'
              : 'partial';
          }
        }

        // ── Drift E: recommended_next_steps[*].actions sub-arrays ───────────
        if (Array.isArray(out.recommended_next_steps)) {
          out.recommended_next_steps = out.recommended_next_steps.map(function (step) {
            if (!step || typeof step !== 'object') return step;
            var sCopy = Object.assign({}, step);
            if (Array.isArray(sCopy.actions) && sCopy.actions.length) {
              var joined = sCopy.actions.map(String).join(' → ');
              sCopy.rationale = (typeof sCopy.rationale === 'string' && sCopy.rationale.trim())
                ? (sCopy.rationale + ' (' + joined + ')')
                : joined;
              delete sCopy.actions;
            }
            return sCopy;
          });
        }

        // ── Synthesize summary if missing so isEnvelopeShape() accepts it ───
        if (typeof out.summary !== 'string' || !out.summary.trim()) {
          out.summary = progressNarrative || '';
        }
        return out;
      }

      function tryParseEnvelope(src) {
        var raw = String(src || '').trim();
        if (!raw) return null;
        try {
          var direct = JSON.parse(raw);
          var nDirect = normalizeLooseEnvelope(direct);
          if (isEnvelopeShape(nDirect)) return nDirect;
        } catch (_e) { /* fall through */ }
        try {
          var repaired = JSON.parse(repairJsonish(raw));
          var nRepaired = normalizeLooseEnvelope(repaired);
          if (isEnvelopeShape(nRepaired)) return nRepaired;
        } catch (_e2) { /* give up */ }
        return null;
      }

      // Expose to webview script consumers (chat-panel.ts uses window.tryParseEnvelope
      // for its fast-path check before falling through to markdown rendering).
      window.tryParseEnvelope = tryParseEnvelope;
      window.isEnvelopeShape = isEnvelopeShape;

      // Find a balanced { ... } substring starting at index i. Respects string literals.
      function findBalancedObject(text, startIdx) {
        var depth = 0, inStr = false, esc = false, quote = '';
        for (var i = startIdx; i < text.length; i++) {
          var ch = text[i];
          if (inStr) {
            if (esc) { esc = false; continue; }
            if (ch === '\\\\') { esc = true; continue; }
            if (ch === quote) { inStr = false; }
            continue;
          }
          if (ch === '"' || ch === "'") { inStr = true; quote = ch; continue; }
          if (ch === '{') { depth++; continue; }
          if (ch === '}') {
            depth--;
            if (depth === 0) return text.slice(startIdx, i + 1);
          }
        }
        return null;
      }

      // Normalize any envelope-shaped JSON in content into a clean ` + '```json' + ` fenced block
      // that markdown-it will reliably tokenize. Handles fenced (any case/indent) and bare trailing JSON.
      window.normalizeEnvelopeFence = function(content) {
        var text = String(content || '');
        if (!text) return text;

        // 1) Fenced ` + '```' + ` blocks. Accept ` + '```json' + `, ` + '```jsonc' + ` or
        //    a bare ` + '```' + ` with no language hint — LLMs frequently omit the
        //    language tag entirely, especially mid-stream.
        var fenceRe = /^[ \\t]*` + '```' + `[ \\t]*([A-Za-z0-9_-]*)[^\\n]*\\n([\\s\\S]*?)\\n[ \\t]*` + '```' + `[ \\t]*$/gm;
        text = text.replace(fenceRe, function(match, lang, body) {
          var langLower = String(lang || '').toLowerCase();
          if (langLower && langLower !== 'json' && langLower !== 'jsonc') return match;
          var env = tryParseEnvelope(body);
          if (!env) return match;
          return '\\n\\n' + '` + '```' + `json\\n' + JSON.stringify(env, null, 2) + '\\n' + '` + '```' + `' + '\\n\\n';
        });

        // 2) Bare top-level JSON object containing "summary" — only consider if not already inside a fence.
        // Quick guard: skip if a recognized envelope fence is now present.
        if (/` + '```' + `json\\s*\\n\\s*\\{[\\s\\S]*?"summary"/i.test(text)) {
          return text;
        }
        var summaryIdx = text.search(/"summary"\\s*:/);
        if (summaryIdx >= 0) {
          // Walk backward to find the enclosing '{' at depth 0.
          var braceStart = -1, depth = 0, inStr = false, esc = false, quote = '';
          for (var j = summaryIdx; j >= 0; j--) {
            var ch = text[j];
            if (inStr) {
              if (esc) { esc = false; continue; }
              if (ch === '\\\\') { esc = true; continue; }
              if (ch === quote) { inStr = false; }
              continue;
            }
            if (ch === '"' || ch === "'") { inStr = true; quote = ch; continue; }
            if (ch === '}') depth++;
            else if (ch === '{') {
              if (depth === 0) { braceStart = j; break; }
              depth--;
            }
          }
          if (braceStart >= 0) {
            var candidate = findBalancedObject(text, braceStart);
            if (candidate) {
              var env2 = tryParseEnvelope(candidate);
              if (env2) {
                var before = text.slice(0, braceStart).replace(/[ \\t]+$/, '');
                var after = text.slice(braceStart + candidate.length).replace(/^[ \\t]+/, '');
                text = before + '\\n\\n' + '` + '```' + `json\\n' + JSON.stringify(env2, null, 2) + '\\n' + '` + '```' + `' + '\\n\\n' + after;
              }
            }
          }
        }
        return text;
      };

      window.registerCardFencePlugin = function(md) {
        if (!md || typeof md.renderer !== 'object') return;
        const defaultFence = md.renderer.rules.fence || function(tokens, idx, options, env, self) {
          return self.renderToken(tokens, idx, options);
        };

        md.renderer.rules.fence = function(tokens, idx, options, env, self) {
          const token = tokens[idx];
          const info = String(token.info || '').trim();
          const lang = info.split(/\\s+/)[0].toLowerCase();

          // Handle structured JSON envelopes from DreamGraph. Accept
          // ` + '```json' + `, ` + '```jsonc' + `, or a bare ` + '```' + ` whose body
          // happens to be an envelope. normalizeEnvelopeFence usually rewrites
          // these to ` + '```json' + ` first, but we double-check here so a
          // pre-normalised stream chunk still renders as a card.
          if (lang === 'json' || lang === 'jsonc' || lang === '') {
            var envParsed = tryParseEnvelope(token.content || '');
            if (envParsed) {
              return renderEnvelope(envParsed);
            }
            if (lang === '') {
              return defaultFence(tokens, idx, options, env, self);
            }
            return defaultFence(tokens, idx, options, env, self);
          }

          if (!/^(entity|adr|tension|insight|outcome)$/.test(lang)) {
            return defaultFence(tokens, idx, options, env, self);
          }

          try {
            const parsed = parseCardBody(token.content || '');
            const fieldCount = Object.keys(parsed.fields || {}).length;
            const onlyId = fieldCount === 1 && Object.prototype.hasOwnProperty.call(parsed.fields, 'id');
            if (onlyId && !parsed.body && !/\\n$/.test(String(token.content || ''))) {
              return defaultFence(tokens, idx, options, env, self);
            }
            const normalized = normalizeCard(lang, parsed);
            if (!normalized) {
              return defaultFence(tokens, idx, options, env, self);
            }
            return renderCard(lang, normalized);
          } catch (_err) {
            return defaultFence(tokens, idx, options, env, self);
          }
        };
      };
    })();
  `;
}
//# sourceMappingURL=card-renderer.js.map