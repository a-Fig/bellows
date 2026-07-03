#!/usr/bin/env node
/**
 * bellows CLI.
 *   bellows run <trial.yaml> [--dry]
 *   bellows report [runsDir] [outFile]
 */
import fs from "node:fs";
import path from "node:path";
import { loadBenchConfig, loadTrialSpec } from "../src/runner/config.mjs";
import { runTrial, planDryRun, resolveRunsRoot } from "../src/runner/schedule.mjs";

function log(msg) {
  process.stderr.write(msg + "\n");
}

function usage() {
  log(`bellows — conductor benchmarking rig

Usage:
  bellows run <trial.yaml> [--dry]   Schedule and execute a trial (or plan it with --dry)
  bellows report [runsDir] [out]     Render RunRecords to an HTML report

Options:
  --dry     Print the plan (runs, rooms, dirs, settings) without spawning pi/host
            or touching the platform.`);
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

async function main() {
  const [, , cmd, ...rest] = process.argv;
  switch (cmd) {
    case "run":
      await cmdRun(rest);
      break;
    case "report":
      await cmdReport(rest);
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

main().catch((e) => {
  log(`fatal: ${e.stack || e.message}`);
  process.exit(1);
});
