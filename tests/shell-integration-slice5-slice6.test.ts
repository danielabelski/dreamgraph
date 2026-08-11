import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const routesSource = () => readFileSync(join(process.cwd(), "src", "architect", "routes.ts"), "utf8").replace(/\r\n/g, "\n");

describe("shell integration slices 5 and 6", () => {
  it("keeps the terminal panel height-bounded for xterm vertical fill", () => {
    const source = routesSource();

    expect(source).toContain(".architect-tab-panels {");
    expect(source).toContain("display: grid;\n      grid-template-rows: minmax(0, 1fr);");
    expect(source).toContain(".terminal-surface {");
    expect(source).toContain("grid-template-rows: minmax(24px, auto) minmax(0, 1fr);");
    expect(source).toContain(".terminal-toolbar span {");
    expect(source).toContain("text-overflow: ellipsis;");
    expect(source).toContain(".architect-center-tab-strip {");
    expect(source).toContain("z-index: 5;");
    expect(source).toContain(".terminal-xterm-mount {");
    expect(source).toContain("position: absolute;");
    expect(source).toContain("inset: 8px 8px 16px 8px;");
    expect(source).toContain(".terminal-xterm-mount .xterm {");
    expect(source).toContain("width: 100%;");
    expect(source).toContain("min-height: 0;");
    expect(source).not.toContain("padding-bottom: 2px;");
  });

  it("refits only visible terminals and observes workspace resize sources", () => {
    const source = routesSource();

    expect(source).toContain("mount.offsetParent === null || !mount.clientWidth || !mount.clientHeight");
    expect(source).toContain("tab.terminalResizeObserver.observe(mount);");
    expect(source).toContain("tab.terminalResizeObserver.observe(architectCenterPanelContainer);");
    expect(source).toContain("if (tab && tab.terminalScheduleFit) window.setTimeout(tab.terminalScheduleFit, 0);");
  });

  it("keeps terminal focus opt-in and releases focus when controls receive focus", () => {
    const source = routesSource();

    expect(source).toContain("function blurArchitectTerminalTab(tab) {");
    expect(source).toContain("consoleSurface.addEventListener('pointerdown', function(event) {");
    expect(source).toContain("if (event.button !== 0) return;");
    expect(source).toContain("term.focus();");
    expect(source).toContain("tab.terminalBlurListener = function(event) {");
    expect(source).toContain("if (consoleSurface.contains(event.target)) return;");
    expect(source).toContain("blurArchitectTerminalTab(tab);");
    expect(source).toContain("document.addEventListener('focusin', tab.terminalBlurListener, true);");
    expect(source).not.toContain("document.addEventListener('pointerdown', tab.terminalBlurListener, true);");
    expect(source).not.toContain("if (tab && tab.terminalXterm) window.setTimeout(function() { tab.terminalXterm.focus(); }, 0);");
  });

  it("blurs hidden terminal panels so inactive xterm instances cannot keep input ownership", () => {
    const source = routesSource();

    expect(source).toContain("const isActivePanel = panel.dataset.architectTabPanel === normalized;");
    expect(source).toContain("panel.hidden = !isActivePanel;");
    expect(source).toContain("if (!isActivePanel && panel.dataset.architectTabType === 'terminal') {");
    expect(source).toContain("blurArchitectTerminalTab(inactiveTab);");
    expect(source).toContain("pointer-events: none;");
  });

  it("cleans terminal lifecycle hooks on tab close", () => {
    const source = routesSource();

    expect(source).toContain("terminalResizeListener: null");
    expect(source).toContain("terminalInputDisposable: null");
    expect(source).toContain("terminalBlurListener: null");
    expect(source).toContain("window.removeEventListener('resize', tab.terminalResizeListener);");
    expect(source).toContain("document.removeEventListener('focusin', tab.terminalBlurListener, true);");
    expect(source).toContain("tab.terminalInputDisposable.dispose();");
    expect(source).toContain("tab.terminalResizeObserver.disconnect();");
    expect(source).toContain("tab.terminalXterm.dispose();");
    expect(source).toContain("tab.terminalFitAddon = null;");
    expect(source).toContain("tab.terminalScheduleFit = null;");
  });

  it("keeps terminal tabs clickable and plan filter menus dark themed", () => {
    const source = routesSource();

    expect(source).toContain(".architect-tab-item.is-active {");
    expect(source).toContain("function handleArchitectTabPointerAction(event, action) {");
    expect(source).toContain("button.addEventListener('pointerdown', function(event) {");
    expect(source).toContain("handleArchitectTabPointerAction(event, function() { setArchitectCenterTab(tab.id); });");
    expect(source).toContain("const close = document.createElement('button');");
    expect(source).toContain("close.type = 'button';");
    expect(source).toContain("close.addEventListener('pointerdown', function(event) {");
    expect(source).toContain("handleArchitectTabPointerAction(event, function() { closeArchitectCenterTab(tab.id); });");
    expect(source).toContain("item.appendChild(close);");
    expect(source).not.toContain("close.setAttribute('role', 'button');");
    expect(source).toContain(".plan-filter-field select option {");
    expect(source).toContain("background: #111815;");
  });

  it("treats terminal close requests as idempotent after shell exit", () => {
    const source = routesSource();

    expect(source).toContain("already_closed: true");
    expect(source).toContain("terminal: null");
    expect(source).not.toContain('jsonError(res, 404, "not_found", "Terminal session not found");\n    return;\n  }\n  closeArchitectTerminalSession(session);');
  });

  it("preserves ADR-222 terminal authority guard rail text", () => {
    const source = routesSource();

    expect(source).toContain("Terminal output is local convenience output, not daemon payload authority.");
    expect(source).not.toContain("terminal output is DreamGraph MCP evidence");
  });
});
