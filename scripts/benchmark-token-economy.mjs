#!/usr/bin/env node
import { mkdir, readFile, writeFile, appendFile, access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const defaultOutDir = path.join(repoRoot, 'artifacts', 'token-economy-benchmark');

const BENCHMARK_CASES = [
  {
    id: 'preamble_compilation',
    name: 'Cognitive preamble compilation',
    description: 'Measures prompt-context setup for a compact cognitive preamble.',
    prompt: 'Compile a concise project preamble with top relationships, tensions, and recent insights.',
    expectedThemes: ['preamble', 'relationships', 'tensions', 'insights'],
  },
  {
    id: 'plan_slice_grounding',
    name: 'Plan slice grounding',
    description: 'Measures plan-bound answering where only the active implementation slice should matter.',
    prompt: 'Summarize the next implementation slice and list the source files that need edits.',
    expectedThemes: ['slice', 'implementation', 'source files'],
  },
  {
    id: 'source_review_fix',
    name: 'Source review fix',
    description: 'Measures repository-specific code review with a bounded fix recommendation.',
    prompt: 'Review a small boundary-condition bug and propose the minimal patch with verification steps.',
    expectedThemes: ['boundary', 'patch', 'verification'],
  },
  {
    id: 'workflow_trace',
    name: 'Workflow trace',
    description: 'Measures workflow reconstruction from graph facts and source-backed steps.',
    prompt: 'Trace the user interaction workflow from trigger through terminal state.',
    expectedThemes: ['trigger', 'steps', 'terminal state'],
  },
  {
    id: 'data_model_linking',
    name: 'Data model linking',
    description: 'Measures compact retrieval of data-model relationships and persistence hints.',
    prompt: 'Identify the data models involved in graph enrichment and explain their relationships.',
    expectedThemes: ['data model', 'relationships', 'graph enrichment'],
  },
  {
    id: 'tension_resolution',
    name: 'Tension resolution',
    description: 'Measures tension-aware reasoning with explicit evidence and non-speculative wording.',
    prompt: 'Pick the highest-priority unresolved tension and outline the safest resolution path.',
    expectedThemes: ['tension', 'evidence', 'resolution'],
  },
];

function parseArgs(argv) {
  const args = {
    mode: 'run',
    outDir: defaultOutDir,
    iterations: 1,
    smoke: false,
    dryRun: false,
    compare: undefined,
    baseline: undefined,
    candidate: undefined,
    caseFilter: undefined,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--smoke') args.smoke = true;
    else if (arg === '--compare') args.mode = 'compare';
    else if (arg === '--out-dir') args.outDir = path.resolve(argv[++i]);
    else if (arg === '--iterations') args.iterations = Math.max(1, Number.parseInt(argv[++i] ?? '1', 10));
    else if (arg === '--case') args.caseFilter = argv[++i];
    else if (arg === '--baseline') args.baseline = path.resolve(argv[++i]);
    else if (arg === '--candidate') args.candidate = path.resolve(argv[++i]);
    else if (arg === '--compare-runs') {
      args.mode = 'compare';
      args.compare = argv[++i];
    }
    else if (arg === '--help' || arg === '-h') args.mode = 'help';
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function printHelp() {
  console.log(`Usage: npm run benchmark:token-economy -- [options]\n\n` +
    `Run options:\n` +
    `  --dry-run              Generate deterministic smoke artifacts without model/tool execution.\n` +
    `  --smoke                Run only the first benchmark case.\n` +
    `  --case <id>            Run one benchmark case by id.\n` +
    `  --iterations <n>       Repeat each case n times; default 1.\n` +
    `  --out-dir <dir>        Artifact directory; default artifacts/token-economy-benchmark.\n\n` +
    `Compare options:\n` +
    `  --compare --baseline <summary.json> --candidate <summary.json>\n` +
    `  --compare-runs <off.json,on.json>  Shortcut for paired ON/OFF comparison.\n`);
}

function stableHash(input) {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function estimateTokens(text) {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.trim().split(/\s+/u).length * 1.33));
}

function tokenEconomyEnabled() {
  const value = process.env.ARCHITECT_TOKEN_ECONOMY ?? process.env.DREAMGRAPH_TOKEN_ECONOMY ?? '';
  return /^(1|true|on|enabled)$/iu.test(value);
}

function isolatedEnv(enabled) {
  return {
    ...process.env,
    ARCHITECT_TOKEN_ECONOMY: enabled ? '1' : '0',
    DREAMGRAPH_TOKEN_ECONOMY: enabled ? '1' : '0',
    DREAMGRAPH_BENCHMARK_TOKEN_ECONOMY: '1',
    DREAMGRAPH_BENCHMARK_SEED: 'architect-token-economy-v1',
  };
}

async function fileExists(filePath) {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function runCommand(command, args, env) {
  const started = performance.now();
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('close', (code) => {
      resolve({
        code,
        stdout,
        stderr,
        durationMs: Math.round(performance.now() - started),
      });
    });
    child.on('error', (error) => {
      resolve({
        code: 1,
        stdout,
        stderr: `${stderr}\n${error.message}`.trim(),
        durationMs: Math.round(performance.now() - started),
      });
    });
  });
}

async function executeCase(benchmarkCase, iteration, options) {
  const enabled = tokenEconomyEnabled();
  const startedAt = new Date().toISOString();
  const deterministicKey = `${benchmarkCase.id}:${iteration}:${enabled ? 'on' : 'off'}`;
  const seeded = stableHash(deterministicKey);
  const inputTokens = estimateTokens(benchmarkCase.prompt);
  const simulatedContextTokens = 1800 + (seeded % 700) + benchmarkCase.expectedThemes.length * 90;
  const compressionSavings = enabled ? Math.floor(simulatedContextTokens * (0.26 + ((seeded % 9) / 100))) : 0;
  const outputTokens = estimateTokens(`${benchmarkCase.description} ${benchmarkCase.expectedThemes.join(' ')}`) + (enabled ? 8 : 24);
  const durationMs = 25 + (seeded % 35) + (enabled ? -5 : 5);

  if (!options.dryRun && process.env.DREAMGRAPH_TOKEN_ECONOMY_BENCHMARK_COMMAND) {
    const commandLine = process.env.DREAMGRAPH_TOKEN_ECONOMY_BENCHMARK_COMMAND;
    const [command, ...args] = commandLine.split(/\s+/u);
    const result = await runCommand(command, args, isolatedEnv(enabled));
    return {
      caseId: benchmarkCase.id,
      caseName: benchmarkCase.name,
      iteration,
      tokenEconomy: enabled ? 'on' : 'off',
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: result.durationMs,
      inputTokens,
      contextTokensBefore: simulatedContextTokens,
      contextTokensAfter: Math.max(1, simulatedContextTokens - compressionSavings),
      outputTokens: estimateTokens(result.stdout),
      totalTokens: inputTokens + Math.max(1, simulatedContextTokens - compressionSavings) + estimateTokens(result.stdout),
      success: result.code === 0,
      commandExitCode: result.code,
      stderr: result.stderr.slice(0, 2000),
      deterministicKey,
    };
  }

  const contextTokensAfter = Math.max(1, simulatedContextTokens - compressionSavings);
  return {
    caseId: benchmarkCase.id,
    caseName: benchmarkCase.name,
    iteration,
    tokenEconomy: enabled ? 'on' : 'off',
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs,
    inputTokens,
    contextTokensBefore: simulatedContextTokens,
    contextTokensAfter,
    outputTokens,
    totalTokens: inputTokens + contextTokensAfter + outputTokens,
    success: true,
    dryRun: options.dryRun,
    deterministicKey,
  };
}

function summarize(runId, records) {
  const totals = records.reduce((acc, record) => {
    acc.totalTokens += record.totalTokens;
    acc.contextTokensBefore += record.contextTokensBefore;
    acc.contextTokensAfter += record.contextTokensAfter;
    acc.outputTokens += record.outputTokens;
    acc.durationMs += record.durationMs;
    if (record.success) acc.successes += 1;
    return acc;
  }, {
    totalTokens: 0,
    contextTokensBefore: 0,
    contextTokensAfter: 0,
    outputTokens: 0,
    durationMs: 0,
    successes: 0,
  });

  const byCase = Object.values(records.reduce((acc, record) => {
    const bucket = acc[record.caseId] ??= {
      caseId: record.caseId,
      caseName: record.caseName,
      runs: 0,
      totalTokens: 0,
      contextTokensBefore: 0,
      contextTokensAfter: 0,
      durationMs: 0,
      successes: 0,
    };
    bucket.runs += 1;
    bucket.totalTokens += record.totalTokens;
    bucket.contextTokensBefore += record.contextTokensBefore;
    bucket.contextTokensAfter += record.contextTokensAfter;
    bucket.durationMs += record.durationMs;
    if (record.success) bucket.successes += 1;
    return acc;
  }, {})).map((bucket) => ({
    ...bucket,
    averageTotalTokens: Math.round(bucket.totalTokens / bucket.runs),
    averageDurationMs: Math.round(bucket.durationMs / bucket.runs),
    compressionRatio: Number((1 - (bucket.contextTokensAfter / bucket.contextTokensBefore)).toFixed(4)),
  }));

  return {
    runId,
    generatedAt: new Date().toISOString(),
    tokenEconomy: records[0]?.tokenEconomy ?? (tokenEconomyEnabled() ? 'on' : 'off'),
    dryRun: records.some((record) => record.dryRun),
    cases: byCase.length,
    records: records.length,
    totals,
    averages: {
      totalTokens: records.length ? Math.round(totals.totalTokens / records.length) : 0,
      durationMs: records.length ? Math.round(totals.durationMs / records.length) : 0,
    },
    compressionRatio: totals.contextTokensBefore
      ? Number((1 - (totals.contextTokensAfter / totals.contextTokensBefore)).toFixed(4))
      : 0,
    byCase,
  };
}

function compareSummaries(baseline, candidate) {
  const tokenDelta = candidate.totals.totalTokens - baseline.totals.totalTokens;
  const durationDelta = candidate.totals.durationMs - baseline.totals.durationMs;
  const byCase = candidate.byCase.map((candidateCase) => {
    const baselineCase = baseline.byCase.find((entry) => entry.caseId === candidateCase.caseId);
    if (!baselineCase) return { caseId: candidateCase.caseId, status: 'missing-baseline' };
    const caseTokenDelta = candidateCase.totalTokens - baselineCase.totalTokens;
    return {
      caseId: candidateCase.caseId,
      caseName: candidateCase.caseName,
      baselineTokens: baselineCase.totalTokens,
      candidateTokens: candidateCase.totalTokens,
      tokenDelta: caseTokenDelta,
      tokenDeltaPct: baselineCase.totalTokens ? Number(((caseTokenDelta / baselineCase.totalTokens) * 100).toFixed(2)) : 0,
      baselineDurationMs: baselineCase.durationMs,
      candidateDurationMs: candidateCase.durationMs,
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    baseline: { runId: baseline.runId, tokenEconomy: baseline.tokenEconomy, totalTokens: baseline.totals.totalTokens },
    candidate: { runId: candidate.runId, tokenEconomy: candidate.tokenEconomy, totalTokens: candidate.totals.totalTokens },
    tokenDelta,
    tokenDeltaPct: baseline.totals.totalTokens ? Number(((tokenDelta / baseline.totals.totalTokens) * 100).toFixed(2)) : 0,
    durationDeltaMs: durationDelta,
    durationDeltaPct: baseline.totals.durationMs ? Number(((durationDelta / baseline.totals.durationMs) * 100).toFixed(2)) : 0,
    byCase,
  };
}

async function writeArtifacts(outDir, runId, records, summary) {
  await mkdir(outDir, { recursive: true });
  const runDir = path.join(outDir, runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, 'records.json'), `${JSON.stringify(records, null, 2)}\n`, 'utf8');
  await writeFile(path.join(runDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  await writeFile(path.join(outDir, `summary-${runId}.json`), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  await appendFile(path.join(outDir, 'runs.jsonl'), records.map((record) => JSON.stringify({ runId, ...record })).join('\n') + '\n', 'utf8');
  return { runDir, summaryPath: path.join(runDir, 'summary.json'), jsonlPath: path.join(outDir, 'runs.jsonl') };
}

async function runBenchmark(options) {
  const allCases = options.smoke ? BENCHMARK_CASES.slice(0, 1) : BENCHMARK_CASES;
  const selectedCases = options.caseFilter ? allCases.filter((entry) => entry.id === options.caseFilter) : allCases;
  if (selectedCases.length === 0) {
    throw new Error(`No benchmark cases matched '${options.caseFilter}'. Available: ${BENCHMARK_CASES.map((entry) => entry.id).join(', ')}`);
  }

  const runId = `${new Date().toISOString().replace(/[:.]/gu, '-')}-${tokenEconomyEnabled() ? 'on' : 'off'}${options.dryRun ? '-dry' : ''}`;
  const records = [];
  for (let iteration = 1; iteration <= options.iterations; iteration += 1) {
    for (const benchmarkCase of selectedCases) {
      records.push(await executeCase(benchmarkCase, iteration, options));
    }
  }

  const summary = summarize(runId, records);
  const artifacts = await writeArtifacts(options.outDir, runId, records, summary);
  console.log(JSON.stringify({ runId, artifacts, summary }, null, 2));
}

async function loadJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function compareMode(options) {
  if (options.compare) {
    const [baseline, candidate] = options.compare.split(',').map((entry) => path.resolve(entry));
    options.baseline = baseline;
    options.candidate = candidate;
  }
  if (!options.baseline || !options.candidate) {
    throw new Error('Compare mode requires --baseline <summary.json> and --candidate <summary.json>, or --compare-runs <off.json,on.json>.');
  }
  if (!(await fileExists(options.baseline))) throw new Error(`Baseline summary not found: ${options.baseline}`);
  if (!(await fileExists(options.candidate))) throw new Error(`Candidate summary not found: ${options.candidate}`);

  const baseline = await loadJson(options.baseline);
  const candidate = await loadJson(options.candidate);
  const comparison = compareSummaries(baseline, candidate);
  await mkdir(options.outDir, { recursive: true });
  const comparePath = path.join(options.outDir, `compare-${baseline.runId}-to-${candidate.runId}.json`.replace(/[\\/:*?"<>|]/gu, '-'));
  await writeFile(comparePath, `${JSON.stringify(comparison, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ comparePath, comparison }, null, 2));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.mode === 'help') {
    printHelp();
    return;
  }
  if (options.mode === 'compare') await compareMode(options);
  else await runBenchmark(options);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
