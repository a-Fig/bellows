/**
 * The `bellows worker` poll/claim/execute/report loop.
 *
 * Sequence per claimed run:
 *   claim -> provision a runDir under runsDir/<trial>/<arm>-<seed> -> executor(run)
 *   (heartbeat every ~30s while executing; cancel -> abort the executor)
 *   -> events streamed throughout (run-start, sync, warn, ...)
 *   -> complete (record.json + optional gzipped session)
 *
 * The executor is injectable (`executeRunFn`) so tests can substitute a fake
 * without spawning real pi/host processes — production wiring passes
 * `defaultExecutor` (src/runner/run.mjs's executeRun via schedule.mjs's
 * provisioning helpers). This is the seam the brief asks for.
 */
import fs from "node:fs";
import path from "node:path";
import { PlatformClient, sleep, backoffMs } from "./platformClient.mjs";
import { EventBatcher } from "./eventBatcher.mjs";
import { TelemetryTail } from "./telemetryTail.mjs";
import { advertisedConductors } from "./conductorAdvertise.mjs";
import { maybePullAccordion, accordionSha } from "./gitPull.mjs";
import { packSessionForUpload } from "./sessionArchive.mjs";
import { buildSharedContext, resolveRunsRoot } from "../runner/schedule.mjs";
import { executeRun as realExecuteRun } from "../runner/run.mjs";

const HEARTBEAT_INTERVAL_MS = 30_000;
const IDLE_POLL_BASE_MS = 5_000;
const IDLE_POLL_JITTER_MS = 2_000;

/** Test seam: override the poll/heartbeat cadence so tests don't wait real-world seconds. */
export const _timing = {
  heartbeatMs: HEARTBEAT_INTERVAL_MS,
  idleBaseMs: IDLE_POLL_BASE_MS,
  idleJitterMs: IDLE_POLL_JITTER_MS,
};
export function _resetTiming() {
  _timing.heartbeatMs = HEARTBEAT_INTERVAL_MS;
  _timing.idleBaseMs = IDLE_POLL_BASE_MS;
  _timing.idleJitterMs = IDLE_POLL_JITTER_MS;
}

/**
 * Production executor: wraps src/runner/run.mjs's executeRun with the shared
 * fingerprint + a room id, matching what schedule.mjs's runTrial does per run —
 * reused as-is per the brief ("your job is a wrapper, not a rewrite").
 *
 * @param {object} args
 * @param {import("../types.ts").ClaimedRun} args.claimed
 * @param {import("../types.ts").BenchConfig} args.config
 * @param {string} args.apiKey
 * @param {string} args.runDir
 * @param {AbortSignal} args.abortSignal
 * @param {(m:string)=>void} args.log
 * @returns {Promise<import("../types.ts").RunRecord>}
 */
export async function defaultExecutor({ claimed, config, apiKey, runDir, abortSignal, log }) {
  const spec = claimed.config;
  const { sharedFp } = buildSharedContext(spec, config);
  // The platform already picked a room for this claimed run when it's provided;
  // otherwise fall back to the trial's own room supply (create=true trials mint
  // one). Either way this mirrors RoomPool.lease()'s single-room-per-run contract.
  const roomId = claimed.roomId || claimed.room_id || spec.room?.pool?.[0] || "";
  return realExecuteRun({
    spec,
    config,
    arm: claimed.arm.conductor,
    armName: claimed.arm.name || claimed.arm.conductor,
    seed: claimed.seed,
    roomId,
    apiKey,
    runDir,
    sharedFp,
    log,
    abortSignal,
  });
}

/**
 * Run the worker loop. Resolves only when `opts.signal` aborts (SIGINT/shutdown)
 * or `opts.once`/`opts.maxIterations` is satisfied — used by tests to bound a run.
 *
 * @param {object} opts
 * @param {import("../types.ts").BenchConfig} opts.config     must have opts.config.worker set
 * @param {string} opts.apiKey                                 never logged
 * @param {(m:string)=>void} [opts.log]
 * @param {boolean} [opts.once]        claim+execute at most one run, then return
 * @param {AbortSignal} [opts.signal]  external shutdown signal (SIGINT et al.)
 * @param {(args)=>Promise<import("../types.ts").RunRecord>} [opts.executeRunFn]  injectable executor (tests)
 * @param {number} [opts.maxIterations]  test seam: stop after N claim polls (idle or not)
 * @returns {Promise<{claimed:number, completed:number, failed:number}>}
 */
export async function runWorkerLoop(opts) {
  const {
    config,
    apiKey,
    log = () => {},
    once = false,
    signal,
    executeRunFn = defaultExecutor,
    maxIterations = Infinity,
  } = opts;

  const wc = config.worker;
  if (!wc) throw new Error("bellows worker: bench.config.json has no \"worker\" section — see bench.config.example.json");
  if (wc.parallel > 1) {
    throw new Error(`bellows worker: worker.parallel=${wc.parallel} is not yet supported (only 1 at a time)`);
  }

  const client = new PlatformClient({ base: wc.platformUrl, apiKey, log });
  const runsRoot = resolveRunsRoot(config);

  let claimedCount = 0;
  let completedCount = 0;
  let failedCount = 0;
  let iterations = 0;
  let stopped = false;

  const onStop = () => {
    stopped = true;
  };
  signal?.addEventListener("abort", onStop, { once: true });

  try {
    while (!stopped && iterations < maxIterations) {
      iterations++;

      if (wc.pullBeforeClaim) {
        maybePullAccordion({ accordionRepo: config.accordionRepo, log });
      }

      let conductors = [];
      try {
        conductors = await advertisedConductors({ accordionRepo: config.accordionRepo, log });
      } catch (e) {
        log(`[worker] WARN: could not build conductors list: ${e.message}`);
      }

      let claimed;
      try {
        claimed = await client.claim({ worker: wc.name, caps: wc.caps, conductors });
      } catch (e) {
        log(`[worker] claim failed: ${e.message}`);
        claimed = null;
      }

      if (!claimed) {
        if (once) return { claimed: claimedCount, completed: completedCount, failed: failedCount };
        await waitIdle(signal);
        continue;
      }

      claimedCount++;
      log(`[worker] claimed run ${claimed.id} (${claimed.trial}/${claimed.name}/${claimed.seed})`);
      const ok = await executeClaimedRun({ claimed, config, apiKey, client, runsRoot, executeRunFn, log, shutdownSignal: signal });
      if (ok) completedCount++;
      else failedCount++;

      if (once) return { claimed: claimedCount, completed: completedCount, failed: failedCount };
    }
  } finally {
    signal?.removeEventListener("abort", onStop);
  }

  return { claimed: claimedCount, completed: completedCount, failed: failedCount };
}

/** Sleep the idle poll interval (with jitter), or return early if the shutdown signal fires. */
function waitIdle(signal) {
  const ms = _timing.idleBaseMs + Math.floor(Math.random() * _timing.idleJitterMs);
  if (!signal) return sleep(ms);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Execute exactly one claimed run end to end: provision dir, heartbeat loop,
 * telemetry tail -> events, executor invocation, complete. Never throws — any
 * failure (including an executor crash) is folded into a "failed" complete()
 * call so the worker loop always continues to the next claim.
 * @returns {Promise<boolean>} true if the run completed successfully (not necessarily
 *   a winning score — "done" vs "failed" as reported to the platform)
 */
async function executeClaimedRun({ claimed, config, apiKey, client, runsRoot, executeRunFn, log, shutdownSignal }) {
  const worker = config.worker.name;
  const runDir = path.join(runsRoot, "_worker", claimed.trial, `${claimed.arm.name || claimed.arm.conductor}-${claimed.seed}`);
  fs.mkdirSync(runDir, { recursive: true });

  const events = new EventBatcher({ client, runId: claimed.id, worker });
  const sha = accordionSha(config.accordionRepo);
  events.push("run-start", { arm: claimed.arm.conductor, seed: claimed.seed, accordion_sha: sha });

  const abortController = new AbortController();
  let cancelled = false;
  let cancelError = null;
  // Distinct from a plain cancel: the platform already considers this run gone
  // (409 on heartbeat), so events/complete would just 409 again — skip them.
  let reaped = false;

  // Crash-safety: a host shutdown (SIGINT et al., surfaced as the loop's own
  // `signal` aborting) must abort whatever run is in flight too, so it gets a
  // best-effort complete(failed, "worker shutdown") instead of being silently
  // dropped mid-execution.
  const onShutdown = () => {
    if (abortController.signal.aborted) return;
    cancelled = true;
    cancelError = "worker shutdown";
    abortController.abort();
  };
  if (shutdownSignal) {
    if (shutdownSignal.aborted) onShutdown();
    else shutdownSignal.addEventListener("abort", onShutdown, { once: true });
  }

  const hostTelemetryFile = path.join(runDir, "host.jsonl");
  const tail = new TelemetryTail({
    file: hostTelemetryFile,
    onEvent: (type, data) => events.push(type, data),
    log,
  });

  const heartbeatTimer = setInterval(async () => {
    try {
      const { cancel, conflict } = await client.heartbeat(claimed.id, worker);
      if (conflict) {
        // 409: reaped/cancelled server-side — stop driving, but don't try to send a
        // duplicate complete() the server would just reject again.
        cancelled = true;
        reaped = true;
        cancelError = "run reaped/cancelled by platform (409 on heartbeat)";
        abortController.abort();
        return;
      }
      if (cancel && !abortController.signal.aborted) {
        cancelled = true;
        cancelError = "cancelled by platform";
        events.push("status-change", { status: "cancelling" });
        abortController.abort();
      }
    } catch (e) {
      log(`[worker] heartbeat error for ${claimed.id}: ${e.message}`);
    }
  }, _timing.heartbeatMs);
  heartbeatTimer.unref?.();

  let record = null;
  let status = "done";
  let error = null;
  try {
    record = await executeRunFn({
      claimed,
      config,
      apiKey,
      runDir,
      abortSignal: abortController.signal,
      log,
    });
    if (cancelled) {
      status = "failed";
      error = cancelError || "cancelled by platform";
    } else if (record && record.status === "error") {
      status = "failed";
      error = record.statusDetail || "run errored";
    }
  } catch (e) {
    status = "failed";
    error = cancelled ? cancelError || "cancelled by platform" : `executor threw: ${e && e.stack ? e.stack : e}`;
    log(`[worker] run ${claimed.id} executor threw: ${e && e.message ? e.message : e}`);
  } finally {
    clearInterval(heartbeatTimer);
    tail.stop();
    shutdownSignal?.removeEventListener("abort", onShutdown);
  }

  if (reaped) {
    // The platform already reaped this run server-side (409 on heartbeat) — it will
    // 409 events/complete too, so don't bother. record.json is still written to disk
    // by executeRun itself; nothing more to do here.
    log(`[worker] run ${claimed.id}: platform reaped this run — skipping events/complete`);
    return false;
  }

  const { sessionGzB64, skippedReason } = record
    ? packSessionForUpload(record.artifacts?.agentDir || path.join(runDir, "agent"), log)
    : { sessionGzB64: null, skippedReason: "no record produced" };
  if (skippedReason) events.push("warn", { message: `session upload skipped: ${skippedReason}` });

  const completeBody = {
    worker,
    status,
    record: record || syntheticRecord(claimed, error),
  };
  if (claimed.room_id || claimed.roomId) completeBody.room_id = claimed.room_id || claimed.roomId;
  if (error) completeBody.error = error;
  if (sessionGzB64) completeBody.session_gz_b64 = sessionGzB64;

  events.push("status-change", { status });
  await events.drain();
  if (events.dropCount > 0) {
    log(`[worker] run ${claimed.id}: dropped ${events.dropCount} event(s) after retry`);
  }

  const delivered = await client.complete(claimed.id, completeBody);
  if (!delivered) {
    log(`[worker] run ${claimed.id}: complete() was not delivered — record.json remains at ${runDir}`);
  }
  return status === "done";
}

/** A minimal RunRecord-shaped stub for a run that never produced a real record (crash before executor returned). */
function syntheticRecord(claimed, error) {
  const now = new Date().toISOString();
  return {
    id: claimed.id,
    label: `${claimed.trial}/${claimed.arm.name || claimed.arm.conductor}/${claimed.seed}`,
    status: "error",
    statusDetail: error || "unknown failure",
    fingerprint: null,
    timing: { startedAt: now, endedAt: now, wallClockS: 0 },
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costUsd: 0, assistantTurns: 0, toolCalls: 0 },
    turns: [],
    conductor: null,
    platform: null,
    artifacts: { piSessionFile: "", hostTelemetryFile: null, workspaceDir: "", agentDir: "" },
  };
}

export { backoffMs };
