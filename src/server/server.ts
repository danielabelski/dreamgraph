/**
 * DreamGraph MCP Server — Server setup and orchestration.
 *
 * Creates the McpServer instance and registers all resources and tools.
 * Transport-agnostic: callers provide the transport (Stdio, SSE, etc.)
 * and call `server.connect(transport)` themselves.
 *
 * The server sends `instructions` on initialization so AI agents know
 * how to use every tool from the first message — no trial-and-error.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { config } from "../config/config.js";
import { registerResources } from "../resources/register.js";
import { registerTools } from "../tools/register.js";
import {
  registerCognitiveResources,
  registerCognitiveTools,
} from "../cognitive/register.js";
import { registerDisciplineResource } from "../discipline/register.js";
import { startScheduler, stopScheduler } from "../cognitive/scheduler.js";
import { startLlmReadinessWatcher, stopLlmReadinessWatcher } from "../cognitive/llm-readiness.js";
import { wireBootstrapOnReady } from "../cognitive/bootstrap-driver.js";
import { recordToolCall } from "../instance/index.js";
import { logger } from "../utils/logger.js";

function buildInstructions(): string {
  const repoNames = Object.keys(config.repos);
  const repoList = repoNames.length > 0
    ? repoNames.map((r) => `- ${r}: ${config.repos[r]}`).join("\n")
    : "- none configured; run init_graph/scan_project or set DREAMGRAPH_REPOS";

  const defaultRepo = repoNames[0] ?? "REPO_NAME";
  const dbLine = config.database.connectionString.length > 0
    ? "\n- Database: query_db_schema(search?, table_name?) is available."
    : "";

  return `DreamGraph MCP Server v${config.server.version}

Purpose: project-aware cognitive knowledge graph for code, architecture, workflows, data models, ADRs, UI semantics, runtime senses, and dream/insight analysis.

Repos usable with repo-scoped tools:
${repoList}
Default repo hint: ${defaultRepo}

Core workflow:
1. Discover current knowledge with system://overview, system://capabilities, system://index, or cognitive_status().
2. If knowledge is sparse, scan_project() or init_graph() can bootstrap graph data.
3. Read code with list_directory(repo, dirPath?) and read_source_code(repo, filePath, entity?/range?). Prefer entity/range reads over full files.
4. Inspect graph/resources with query_resource(uri) and focused tools such as get_workflow(), search_data_model(), query_api_surface(), graph_rag_retrieve(), shortest_path().
5. Enrich durable facts with enrich_seed_data(), register_ui_element(), record_architecture_decision(), or solidify_cognitive_insight() when new knowledge is confirmed.
6. Explore speculative cognition with dream_cycle(), cognitive_status(), get_dream_insights(), get_temporal_insights(), get_causal_insights(), and get_remediation_plan().

Common resources:
- System: system://overview, system://features, system://workflows, system://data-model, system://capabilities, system://index
- Cognitive: dream://graph, dream://status, dream://tensions, dream://validated, dream://history, dream://adrs, dream://ui-registry, dream://story
- Discipline: discipline://manifest

Tool use rules:
- Prefer the narrowest factual tool for the question; avoid broad reads unless needed.
- High-volume outputs may be clipped intentionally; re-run with a narrower query/entity/range/filter.
- For code edits, inspect the target/API first, preserve behavior unless asked to change it, then run the relevant build/test command when possible.${dbLine}
`;
}

export function createServer(): McpServer {
  const instructions = buildInstructions();

  const server = new McpServer(
    {
      name: config.server.name,
      version: config.server.version,
    },
    { instructions },
  );

  logger.info(
    `Initializing ${config.server.name} v${config.server.version}`
  );

  // ---- Wrap server.tool() to auto-count every MCP tool invocation ----
  // The handler is always the last argument regardless of which overload
  // is used:  tool(name, cb) | tool(name, desc, cb) | tool(name, schema, cb)
  //          | tool(name, desc, schema, cb)
  const _originalTool = server.tool.bind(server);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).tool = (...args: unknown[]) => {
    const lastIdx = args.length - 1;
    const originalHandler = args[lastIdx];
    if (typeof originalHandler === "function") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args[lastIdx] = async (...handlerArgs: any[]) => {
        // Fire-and-forget — don't block the tool response on counter I/O
        recordToolCall().catch(() => {});
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (originalHandler as any)(...handlerArgs);
      };
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (_originalTool as any)(...args);
  };

  // Register all MCP resources (READ-ONLY context data)
  registerResources(server);

  // Register all MCP tools (READ-ONLY query tools)
  registerTools(server);

  // Register cognitive dreaming system (resources + tools)
  registerCognitiveResources(server);
  registerCognitiveTools(server);

  // v7.0 — Register discipline execution system (ADR-001)
  registerDisciplineResource(server);

  // v5.2 — Start the dream scheduler
  startScheduler(config.scheduler);

  // ADR-098 (Slice 2A) — Start the LLM-readiness watcher. Probes the
  // configured provider with a real completion call on a fixed interval
  // and surfaces state via `cognitive_status`. The watcher is observable-
  // only at this stage; bootstrap-firing on the ready transition is wired
  // in Slice 2B.
  startLlmReadinessWatcher();

  // ADR-098 (Slice 2B) — Subscribe the bootstrap chain to ready transitions.
  // Idempotent. Fires `bootstrapNewInstance()` exactly once per fingerprint
  // for fresh instances; logs+skips fingerprint rotations on populated
  // instances pending the Slice 2C re-enrich-only path.
  wireBootstrapOnReady();

  // Clean shutdown — flush logs before exiting so daemon can verify
  const gracefulExit = () => {
    stopLlmReadinessWatcher();
    stopScheduler();
    logger.info("Shutdown complete");
    // Allow stderr to flush to the log file descriptor before exiting
    setTimeout(() => process.exit(0), 200);
  };
  process.on("SIGINT", gracefulExit);
  process.on("SIGTERM", gracefulExit);

  return server;
}
