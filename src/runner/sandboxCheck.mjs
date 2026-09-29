/**
 * `bellows sandbox-check [trial.yaml] [--keep]` — run the Landlock canary
 * against a throwaway run dir laid out exactly like a real run, without a
 * model, a platform call, or pi. Builds the same env (buildPiEnv +
 * agentSpawnEnv) and goes through the same prepareLandlockRun path executeRun
 * uses, so the wrapper argv and probes are identical to a real run's.
 */
import fs from "node:fs";
import path from "node:path";
import { buildPiEnv } from "./run.mjs";
import { agentSpawnEnv } from "./agentEnv.mjs";
import { resolveEffectiveAccordionRepo } from "./accordionRef.mjs";
import { resolveRunsRoot } from "./schedule.mjs";
import { assertLandlockAvailable, resolveSandboxEgress, prepareLandlockRun } from "./sandbox.mjs";

/**
 * @param {object} a
 * @param {import("../types.ts").BenchConfig} a.config
 * @param {import("../types.ts").TrialSpec} [a.spec]  optional: honors its accordionRef
 * @param {boolean} [a.keep]  keep the throwaway run dir for inspection
 * @param {(m:string)=>void} a.log
 * @param {(s:string)=>void} a.out
 * @returns {Promise<boolean>} true when every probe passed
 */
export async function sandboxCheck({ config, spec, keep = false, log, out }) {
  const abi = assertLandlockAvailable();
  out(`Landlock ABI ${abi} on ${process.platform}`);
  const sandboxEgress = resolveSandboxEgress(config, spec);
  out(`sandboxEgress: ${sandboxEgress}`);

  const runsRoot = resolveRunsRoot(config);
  let accordionRepo = config.accordionRepo;
  if (spec?.accordionRef) {
    accordionRepo = (await resolveEffectiveAccordionRepo({
      accordionRepo: config.accordionRepo,
      accordionRef: spec.accordionRef,
      runsDir: runsRoot,
      log,
    })).repo;
  }

  const runDir = path.join(runsRoot, "_sandbox_check", `check-${Date.now()}-${process.pid}`);
  const workspaceDir = path.join(runDir, "workspace");
  const agentDir = path.join(runDir, "agent");
  const accordionHome = path.join(runDir, "accordion-home");
  for (const d of [workspaceDir, agentDir, accordionHome]) fs.mkdirSync(d, { recursive: true });

  const completionLogFile = path.join(runDir, "completions.jsonl");
  const piEnv = buildPiEnv({
    processEnv: process.env,
    agentDir,
    accordionHome,
    scrubPiEnv: config.scrubPiEnv,
    piEnvPassthrough: config.piEnvPassthrough,
    completionLogFile,
    log,
  });
  Object.assign(piEnv, agentSpawnEnv({ baseEnv: piEnv, binDir: path.join(runDir, "bin"), log }));

  let ok = false;
  try {
    const sbx = prepareLandlockRun({
      config,
      runDir,
      workspaceDir,
      agentDir,
      accordionHome,
      accordionRepo,
      hostTelemetryFile: path.join(runDir, "host.jsonl"),
      completionLogFile,
      piRpcLogFile: path.join(runDir, "pi-rpc.log"),
      runsRoot,
      piEnv,
      sandboxEgress,
      log: out, // prints the canary table, pass or fail
    });
    out(`\ngrants (${sbx.rules.length}; everything else is denied):`);
    for (const r of sbx.rules) out(`  --${r.mode} ${r.path}   (${r.why})`);
    out(`\npi would run as:\n  ${[...sbx.prefix.slice(0, 4), "<grants>", "--", sbx.piPath, "--mode", "rpc"].join(" ")}`);
    out(`\nPASS: all ${sbx.canary.rows.length} probes behaved as expected.`);
    ok = true;
  } catch (e) {
    out(`\nFAIL: ${e.message}`);
  } finally {
    if (keep) out(`(kept ${runDir})`);
    else fs.rmSync(runDir, { recursive: true, force: true });
  }
  return ok;
}
