# Architect For Dummies

Architect turns repository evidence into useful engineering artifacts while keeping project memory outside chat history. The ten-minute path is simple: open Dashboard, complete required setup, build the project map, choose how Architect answers, then launch a mission or recipe.

## Start Here

1. Open Dashboard and follow `Required to start`.
2. Connect one repository. Add related repos only for cross-repo work.
3. Build the first project map with the governed `scan_project` action.
4. Choose a CLI subscription, API provider, local model, or deterministic fallback. Use `Test setup`.
5. Open Architect and pick a mission or recipe.

## Concepts Without Jargon

| Term | Meaning |
| --- | --- |
| Project map | The graph-backed map learned from configured repositories. |
| Plan | A durable markdown-backed work record with slices, checkpoints, and evidence. |
| Evidence | Source, graph, ADR, workflow, data-model, or command output supporting a claim. |
| Governed action | A daemon-owned action using DreamGraph MCP authority. |
| ADR | An architecture decision record with constraints and guard rails. |
| Tension | An unresolved graph concern worth reviewing. |
| Provider | The API or local inference service. |
| Adapter | The execution route, such as `codex-cli` or the native API tool loop. |
| Autonomy | How independently Architect continues after verified progress. |
| Pass | One bounded execution cycle. |

## Screen Tour

The top runtime strip shows project scope, active model route, live events, pulse weather, cognitive state, plan state, and `dreamgraph_mcp` authority.

The Plans sidebar creates, archives, searches, filters, selects, collapses, and resizes durable plans. The center workspace opens Chat, Plan, ADR Editor, Code Editor, Terminal, and contributed plugin tabs through the `+` menu. The right context sidebar projects registry summary, plugin summaries, Living Plan details, governed actions, review gates, scheduler and dream state, ADR and graph bindings, slices, checkpoints, evidence, VS Code links, raw markdown, and live events.

The provider wizard asks how Architect should answer. The shipped adapter, provider, model, autonomy, and pass controls remain under `Advanced runtime controls`.

## Chat

Chat supports Project scope and selected Plan scope. Attachments are capability-gated by the selected route. Send, Pause, and Stop controls reflect daemon execution capability. Repository-specific replies should remain grounded in daemon facts and DreamGraph MCP tools.

Scope prefixes:

| Prefix | Effect |
| --- | --- |
| `/ask`, `/global`, `/repo` | Send the rest of the prompt in Project scope. |
| `/plan` | Send the rest of the prompt in selected Plan scope when a plan is active. |

## Slash Commands

| Command | Purpose |
| --- | --- |
| `/status` | Show bound instance status. |
| `/stop`, `/pause`, `/resume` | Control a supported running task. |
| `/restart` | Restart the bound daemon instance. |
| `/plugin list`, `/plugin inspect <id>` | Inspect plugins. |
| `/plugin enable|disable|trust|untrust|reload|unload <id>` | Apply daemon-owned plugin actions. |
| `/plan new <name>` | Create and select a durable plan. |
| `/plan archive`, `/plan list`, `/plan status`, `/plan next`, `/plan clear`, `/plan search <query>` | Manage plan lifecycle and selection. |
| `/adr`, `/adr ADR-215`, `/adr edit ADR-215`, `/adr search <query>`, `/adr proposed` | Review ADRs. |
| `/git status|diff|branch|log`, `/git commit <message>` | Run bounded project git actions. |
| `/clear`, `/help` | Clear chat or list commands. |

## Important Buttons

| Button | Meaning |
| --- | --- |
| `New Plan` | Create a durable markdown-backed plan. |
| `Archive` | Preserve plan history while removing active clutter. |
| `Record Action` | Append a governed plan action audit. |
| `Review Gate` | Record a checkpoint before risky continuation. |
| Adaptive Future decisions | Advisory review, not hard enforcement. |
| Scheduler controls | Manage recurring project intelligence. |

## Providers, Adapters, And Autonomy

`CLI subscription` selects `codex-cli` with provider `none`. Copilot CLI remains available in advanced controls. `API provider` selects the native tool loop with an API-backed provider. `Local model` starts with Ollama. `No AI fallback` keeps non-LLM setup and browser features usable. All routes retain DreamGraph MCP authority for repository facts and mutations.

## Code Editor Tab

Open Code Editor from the `+` menu only when direct visual editing is useful. It loads configured repo trees and files through daemon routes, uses Monaco for editing, tracks dirty state, checks revision conflicts, saves through daemon-governed mutation, and reports graph synchronization separately. Repo selection changes the visible tree, not the authority boundary. Prefer plan/chat-led narrow mutations for normal work.

## Terminal Tab

Open Terminal from the `+` menu for direct operator diagnostics and local commands. It is a daemon-hosted local convenience shell. Terminal output is not repository truth, plan state, runtime identity, or the canonical browser/chat contract. It does not permit provider-native authority bypasses.

## Plans And Plan-Based Development

Plans survive chat reloads. Create, select, review, resume, and archive them from the Plans sidebar or `/plan` commands. The Living Plan projection shows open questions and nervous points. Slices, checkpoints, evidence links, implementation logs, and review gates keep continuation inspectable.

## Recipe Library

### Prototype Or Small App

| Recipe | First artifact | Verify |
| --- | --- | --- |
| Explain this app before I change it | Project overview | Cite modules and entry points |
| Find the safest first cleanup | Ranked cleanup report | Name one bounded verified slice |
| Add a small feature with a plan | Implementation plan | Include build and test checks |
| Generate a missing README | README draft | Check commands against repository evidence |
| Prepare release notes | Release notes draft | Ground changes in repository history |

### Existing Service Or Legacy Repo

| Recipe | First artifact | Verify |
| --- | --- | --- |
| Find entry points and runtime dependencies | Runtime inventory | Cite source files and config |
| Map API and data-model risks | API and data risk map | List evidence and open questions |
| Find stale docs before a migration | Documentation drift report | Cross-check docs against source |
| Propose the smallest verified repair | Bounded repair plan | Name the narrow verification command |
| Record an architecture decision | ADR proposal | State alternatives and guard rails |

### Multi-Repo System

| Recipe | First artifact | Verify |
| --- | --- | --- |
| Inventory repos and their roles | Cross-repo inventory | Use configured repository scope |
| Trace a concept across services | Cross-service trace | Cite each repository hop |
| Identify cross-repo change risks | Change-risk report | List affected repos and checks |
| Create a coordinated implementation plan | Multi-repo plan | Split verification by repo |
| Set up recurring architecture review | Review schedule proposal | Preview the report before scheduling |

### Plugin Or Tool Integration

| Recipe | First artifact | Verify |
| --- | --- | --- |
| Inventory available plugins and MCP tools | Capability inventory | Use daemon runtime facts |
| Inspect plugin trust and availability | Plugin trust report | Cite manifest and runtime state |
| Connect a local workflow | Workflow integration plan | Name governed actions and checks |
| Review tool traces and governed actions | Trace review | Separate evidence from convenience output |

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Daemon not ready | Run `dg status <instance>` and confirm HTTP mode. |
| No project attached | Attach the intended project and reload Dashboard. |
| Map stale or missing | Run the governed project-map action. |
| Provider test failed | Follow the readiness message: select a model, set an API key, or start the local service. |
| No repos available | Open `Connect repositories`, validate paths, and save. |
| Editor save conflict | Reload the file before retrying the save. |
| Graph scan failed | Review the separate graph-sync status and rerun a bounded scan. |
| Terminal session failed | Reopen the Terminal tab and use daemon logs for diagnosis. |

## Authority Limits

The browser is a projection and control surface. Repository facts, governed mutations, plan state, runtime identity, and browser/chat contracts remain daemon-owned and DreamGraph MCP-authoritative. Code Editor and Terminal are useful companion surfaces, not alternate authority routes.
