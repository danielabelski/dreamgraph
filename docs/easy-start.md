# DreamGraph Easy Start

> **Start here.** You do not need to understand the internals before using DreamGraph. Pick the path that matches your project, run the short command list, and keep three browser tabs open: Dashboard, Explorer, and Architect.

DreamGraph v12 is browser-first. **Architect** is the main working surface. The Dashboard helps with setup and health. Explorer gives you a visual map when you need orientation.

## Before you start

Install DreamGraph from the repository root:

```bash
# Windows
scripts/install.ps1 -Force

# macOS or Linux
bash scripts/install.sh --force
```

Open a new terminal and verify the install:

```bash
dg --version
```

You should see DreamGraph CLI v12.1.0 or newer.

## Pick your setup path

### A. Start a completely new project

Use this when the project folder is empty or does not exist yet.

```bash
mkdir my-app
cd my-app
dg init --name my-app --project . --transport http
dg start my-app --http
dg scan my-app --depth deep
```

DreamGraph creates `plans/` automatically. You do not need to create it by hand.

### B. Read an existing project

Run these commands from the existing repository root:

```bash
cd path/to/existing-project
dg init --name existing-project --project . --transport http
dg start existing-project --http
dg scan existing-project --depth deep
```

The scan reads the project and prepares DreamGraph's project map. It does not rewrite your application code.

### C. Read a multi-repo system

Choose one folder as the main project root. This is usually the folder that contains your system-level README, workspace file, or deployment configuration.

```bash
cd path/to/system-root
dg init --name platform --project . --transport http
dg attach . --instance platform --repo api=../platform-api
dg start platform --http
dg scan platform --depth deep
```

For additional repositories, open the Dashboard Config page and add a `DREAMGRAPH_REPOS` JSON map to the instance `engine.env` file:

```dotenv
DREAMGRAPH_REPOS={"api":"C:/work/platform-api","web":"C:/work/platform-web","infra":"C:/work/platform-infra"}
```

Restart after changing configuration:

```bash
dg restart platform
```

Keep the list focused. Add the repositories that belong to the system you want Architect to reason about.

### D. Bring an existing Codex or Claude workflow

You do not need to migrate chat history. Keep your repository where it is and initialize DreamGraph against that folder.

For Codex CLI, install and sign in to Codex as usual. Open Architect and choose:

- Adapter: `Codex CLI`
- Model: your preferred Codex model or `auto`

For Claude, use the Anthropic API route. In Dashboard > Config, set:

```dotenv
DREAMGRAPH_LLM_PROVIDER=anthropic
DREAMGRAPH_LLM_API_KEY=your-api-key
DREAMGRAPH_LLM_ARCHITECT_PROVIDER=anthropic
DREAMGRAPH_LLM_ARCHITECT_ADAPTER=native_api_tool_loop
DREAMGRAPH_LLM_ARCHITECT_MODEL=your-claude-model
```

Then restart the instance. DreamGraph does not currently import Claude Code conversations or expose a Claude Code inline CLI adapter. The supported Claude path is Anthropic API configuration.

## Open the three browser tabs

Run:

```bash
dg status my-app
```

Use the host and port shown by `dg status`. If the port is `8100`, open:

| Tab | URL | Use it for |
|-----|-----|------------|
| Dashboard | `http://127.0.0.1:8100/` | Health, status, schedules, configuration, and docs. |
| Explorer | `http://127.0.0.1:8100/explorer/` | Visual orientation, search, relationships, and tensions. Keep the trailing slash. |
| Architect | `http://127.0.0.1:8100/architect` | Your main working tab: ask questions, make plans, implement changes, and verify work. |

Use them together simply:

1. Start in **Architect** and describe what you want in normal language.
2. Use **Explorer** when you want to understand how parts of the system connect.
3. Use **Dashboard** when setup, health, or configuration needs attention.

## What to ask Architect first

For a new project:

```text
Help me define the smallest useful first version of this project. Create a plan and start with the simplest working slice.
```

For an existing project:

```text
Read this project and explain the main user-facing parts, the important workflows, and the first risks I should review. Keep it practical.
```

For a large multi-repo system:

```text
Map the repositories at a high level. Tell me which repo owns each major responsibility, then identify the first three cross-repo workflows worth reviewing.
```

## Daily commands

Most days, these are enough:

```bash
dg status my-app
dg start my-app --http
dg restart my-app
dg stop my-app
dg scan my-app --depth deep
```

Use `dg scan` after attaching a project, after adding repositories, or after major structural changes.

## Questions and troubleshooting

### Do I need to create `plans/` manually?

No. DreamGraph creates `<project>/plans/` when you initialize or attach a project. Architect also safeguards plan creation if the folder is missing.

### I already use Codex. What changes?

Keep using Codex authentication. In Architect, select the Codex CLI adapter. DreamGraph supplies project context and governed repository tools through the browser workflow.

### I already use Claude Code. What changes?

Your repository stays unchanged. Configure the Anthropic API provider for Architect. Claude Code transcript import and a Claude Code inline CLI adapter are not currently supported.

### Can I use a local model?

Yes. Dashboard > Config can point DreamGraph to Ollama or LM Studio. Use the existing [LLM setup guide](../guide/04-llm-setup.md) when you want local model details.

### Which tab should I leave open?

Leave Architect open. Keep Explorer beside it for orientation. Visit Dashboard when you need status or configuration.

### Architect opens the wrong project

Run:

```bash
dg status my-app
dg attach path/to/correct-project --instance my-app
dg restart my-app
```

### The browser does not open

Confirm the daemon is running in HTTP mode:

```bash
dg start my-app --http
dg status my-app
```

If `8100` was already in use, DreamGraph may choose another port. Use the port reported by `dg status`.

### Explorer does not load

Use `/explorer/` with the trailing slash.

### I added more repositories but Architect cannot see them

Check `DREAMGRAPH_REPOS` in Dashboard > Config, restart the instance, and run a deep scan again.

### Where do I go next?

Continue with the detailed [user guide](../guide/README.md) only when you need more detail.
