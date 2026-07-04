#!/usr/bin/env node
/**
 * bellows CLI.
 *   bellows run <trial.yaml> [--dry]
 *   bellows report [runsDir] [outFile]
 *   bellows worker --poll [--once]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadBenchConfig, loadTrialSpec } from "../src/runner/config.mjs";
import { runTrial, planDryRun, resolveRunsRoot } from "../src/runner/schedule.mjs";
import { runWorkerLoop } from "../src/worker/loop.mjs";
import { makeShutdownSignalHandler } from "../src/worker/shutdownSignal.mjs";

function log(msg) {
  process.stderr.write(msg + "\n");
}

function usage() {
  log(`bellows — conductor benchmarking rig

Usage:
  bellows run <trial.yaml> [--dry]   Schedule and execute a trial (or plan it with --dry)
  bellows report [runsDir] [out]     Render RunRecords to an HTML report
  bellows worker --poll [--once]     Claim + execute runs dispatched by the platform

Options:
  --dry     Print the plan (runs, rooms, dirs, settings) without spawning pi/host
            or touching the platform.
  --once    (worker only) Claim and execute at most one run, then exit.`);
}

async function cmdRun(args) {
  const dry = args.includes("--dry");
  const specArg = args.find((a) => !a.startsWith("--"));
  if (!specArg) {
    log("error: `run` requires a trial YAML path.\n");
    usage();
    process.exit(2);
  }

  let config, spec;
  try {
    ({ config } = loadBenchConfig(log));
    spec = loadTrialSpec(specArg);
  } catch (e) {
    log(`error: ${e.message}`);
    process.exit(2);
  }

  if (dry) {
    process.stdout.write(planDryRun(spec, config) + "\n");
    return;
  }

  // Real run: resolve the platform api key from the configured env var.
  const apiKey = process.env[config.platformApiKeyEnv];
  if (!apiKey) {
    log(`error: platform api key env var ${config.platformApiKeyEnv} is not set. ` +
        `Export it (never commit it) before running, or use --dry.`);
    process.exit(2);
  }

  let records;
  try {
    records = await runTrial({ spec, config, apiKey, log });
  } catch (e) {
    log(`fatal: trial failed: ${e.stack || e.message}`);
    process.exit(1);
  }

  printFinalTable(records);

  // Exit nonzero if any run ERRORED (not merely aborted by a cap).
  const errored = records.filter((r) => r && r.status === "error");
  if (errored.length) {
    log(`\n${errored.length}/${records.length} run(s) errored.`);
    process.exit(1);
  }
}

function printFinalTable(records) {
  const rows = records.map((r) => {
    const p = r.platform;
    return {
      arm: r.fingerprint.conductorId,
      seed: r.label.split("/").pop(),
      status: r.status,
      cost: `$${r.usage.costUsd.toFixed(4)}`,
      tokens: String(r.usage.totalTokens),
      ckpts: p ? `${p.checkpointsSolved}/${p.checkpointsAttempted}` : "-",
    };
  });
  const cols = ["arm", "seed", "status", "cost", "tokens", "ckpts"];
  const width = {};
  for (const c of cols) width[c] = Math.max(c.length, ...rows.map((r) => r[c].length));
  const fmt = (r) => cols.map((c) => String(r[c]).padEnd(width[c])).join("  ");
  const out = [];
  out.push("");
  out.push("=== results ===");
  out.push(fmt(Object.fromEntries(cols.map((c) => [c, c]))));
  out.push(cols.map((c) => "-".repeat(width[c])).join("  "));
  for (const r of rows) out.push(fmt(r));
  process.stdout.write(out.join("\n") + "\n");
}

async function cmdReport(args) {
  let config;
  try {
    ({ config } = loadBenchConfig(log));
  } catch (e) {
    log(`error: ${e.message}`);
    process.exit(2);
  }
  const runsDir = args[0] ? path.resolve(args[0]) : resolveRunsRoot(config);
  const outFile = args[1] ? path.resolve(args[1]) : path.join(runsDir, "report.html");
  if (!fs.existsSync(runsDir)) {
    log(`error: runs dir does not exist: ${runsDir}`);
    process.exit(2);
  }
  let generateReport;
  try {
    ({ default: generateReport } = await import("../src/report/index.mjs"));
  } catch (e) {
    log(`error: could not load report generator (src/report/index.mjs): ${e.message}`);
    process.exit(2);
  }
  try {
    await generateReport(runsDir, outFile);
    log(`report written: ${outFile}`);
  } catch (e) {
    log(`error: report generation failed: ${e.stack || e.message}`);
    process.exit(1);
  }
}

async function cmdWorker(args) {
  const once = args.includes("--once");
  // --poll is the documented/expected flag for the long-running form; accepted but not
  // required to distinguish from --once, since any invocation without --once polls anyway.
  let config;
  try {
    ({ config } = loadBenchConfig(log));
  } catch (e) {
    log(`error: ${e.message}`);
    process.exit(2);
  }
  if (!config.worker) {
    log(`error: bench.config.json has no "worker" section. Add one (see bench.config.example.json):\n` +
      `  "worker": { "platformUrl": "...", "name": "<worker-name>", "caps": ["in-process"] }`);
    process.exit(2);
  }
  // m4 (adversarial review, PM decision): honor config.platformApiKeyEnv exactly
  // like cmdRun does, rather than hardcoding AGENT_TRIALS_API_KEY. The intended
  // deployment is the same key/account creating rooms and running the worker,
  // so both paths must resolve the key the same way — a config pointing
  // platformApiKeyEnv at a different env var previously had no effect on the
  // worker, silently falling back to a var that may not even be set.
  const apiKey = process.env[config.platformApiKeyEnv];
  if (!apiKey) {
    log(`error: platform api key env var ${config.platformApiKeyEnv} is not set. ` +
      `Export it (never commit it) before running the worker.`);
    process.exit(2);
  }

  const abortController = new AbortController();
  const onSignal = makeShutdownSignalHandler({ abortController, log });
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  log(`[worker] ${config.worker.name} polling ${config.worker.platformUrl} (caps: ${config.worker.caps.join(", ") || "none"})`);
  const summary = await runWorkerLoop({ config, apiKey, log, once, signal: abortController.signal });
  log(`[worker] stopped. claimed=${summary.claimed} completed=${summary.completed} failed=${summary.failed}`);
  process.exit(summary.failed > 0 && once ? 1 : 0);
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  switch (cmd) {
    case "run":
      await cmdRun(rest);
      break;
    case "report":
      await cmdReport(rest);
      break;
    case "worker":
      await cmdWorker(rest);
      break;
    case "-h":
    case "--help":
    case undefined:
      usage();
      break;
    default:
      log(`unknown command: ${cmd}\n`);
      usage();
      process.exit(2);
  }
}

// Only run the CLI when this file is the actual entrypoint, not when some
// future test or tool imports it. Node-20-compatible equivalent of
// `import.meta.main` (added in Node 24, after this package's engines >=20
// floor) — compare the resolved module path against argv[1].
const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isEntrypoint) {
  main().catch((e) => {
    log(`fatal: ${e.stack || e.message}`);
    process.exit(1);
  });
}
