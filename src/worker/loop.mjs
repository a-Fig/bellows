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
import { advertisedConductors, clearConductorCache } from "./conductorAdvertise.mjs";
import { maybePullAccordion, accordionSha } from "./gitPull.mjs";
import { packSessionForUpload } from "./sessionArchive.mjs";
import { buildSharedContext, resolveRunsRoot, describeRoomConfig } from "../runner/schedule.mjs";
import { executeRun as realExecuteRun } from "../runner/run.mjs";
import { createRoom } from "../runner/platform.mjs";
import { slopcodeRoomConfig } from "../runner/roomConfig.mjs";

const HEARTBEAT_INTERVAL_MS = 30_000;
const IDLE_POLL_BASE_MS = 5_000;
const IDLE_POLL_JITTER_MS = 2_000;
// M3 (adversarial review): complete()'s default retry budget is ~5 minutes,
// which is right for a normal run finishing but wrong on the shutdown path —
// SIGINT should exit promptly rather than block on an unreachable platform.
const SHUTDOWN_COMPLETE_DEADLINE_MS = 10_000;

/**
 * M2 (adversarial review): sanitize an arm name before it becomes a path segment.
 * `external:<id>` arm names contain a literal colon, which is a reserved path
 * character on Windows (`ENOENT`/`EINVAL` from fs.mkdirSync) — this worker's
 * runDir previously built straight from the raw arm name and crashed on any
 * external-conductor arm. The main bellows checkout fixed the equivalent bug in
 * schedule.mjs's expandRuns (commit 827a914, not present in this worktree) with
 * this exact regex; replicated verbatim here so the two fixes are byte-identical
 * and the branches merge cleanly later.
 * @param {string} name
 * @returns {string}
 */
export function sanitizeForPath(name) {
  return name.replace(/[<>:"/\\|?*]/g, "-");
}

/** Test seam: override the poll/heartbeat cadence so tests don't wait real-world seconds. */
export const _timing = {
  heartbeatMs: HEARTBEAT_INTERVAL_MS,
  idleBaseMs: IDLE_POLL_BASE_MS,
  idleJitterMs: IDLE_POLL_JITTER_MS,
  shutdownCompleteDeadlineMs: SHUTDOWN_COMPLETE_DEADLINE_MS,
};
export function _resetTiming() {
  _timing.heartbeatMs = HEARTBEAT_INTERVAL_MS;
  _timing.idleBaseMs = IDLE_POLL_BASE_MS;
  _timing.idleJitterMs = IDLE_POLL_JITTER_MS;
  _timing.shutdownCompleteDeadlineMs = SHUTDOWN_COMPLETE_DEADLINE_MS;
}

/**
 * Resolve the room a platform-dispatched run should join, mirroring
 * RoomPool.lease()'s single-room-per-run contract: prefer a pooled room,
 * otherwise mint one when `room.create` is set. A run without either is
 * refused loudly — silently passing an empty room id sends the agent into a
 * workspace with a blank `__ROOM_ID__` and it burns its whole turn cap
 * looking for a room (that exact failure shipped: claimed.roomId/room_id were
 * phantom reads — ClaimedRun has no such field and POST /workers/claim only
 * returns {id, trial, name, config, arm, seed}; the platform never picks
 * rooms for bench runs, so the trial's own room supply is the only source).
 *
 * @param {object} args
 * @param {import("../types.ts").TrialSpec} args.spec
 * @param {import("../types.ts").BenchConfig} args.config
 * @param {string} args.apiKey
 * @param {(m:string)=>void} args.log
 * @returns {Promise<string>} the room id to join
 */
export async function resolveWorkerRoom({ spec, config, apiKey, log }) {
  const pooled = spec.room?.pool?.[0];
  if (pooled) return pooled;
  if (spec.room?.create === true) {
    const base = spec.room.base || config.platformBase;
    const roomConfig = slopcodeRoomConfig(spec.problems);
    log(`[worker] room.create: leaderboard bucket ${describeRoomConfig(roomConfig)}`);
    const id = await createRoom({ base, apiKey, roomConfig });
    log(`[worker] created room ${id}`);
    return id;
  }
  throw new Error(
    "run has no room: spec.room.pool is empty and room.create is not true — refusing to launch an agent with a blank room id",
  );
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
  const roomId = await resolveWorkerRoom({ spec, config, apiKey, log });
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
        const headMoved = maybePullAccordion({ accordionRepo: config.accordionRepo, log });
        // m9 (adversarial review): a pull that actually moved HEAD may have added/
        // removed conductors (new IN_PROCESS_CONDUCTORS registrations, new/removed
        // conductors/<id>/launch.json dirs) — the 60s conductor-list cache must not
        // paper over that for up to a minute. clearConductorCache's own docstring
        // already calls out this exact use.
        if (headMoved) clearConductorCache();
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
  const armName = claimed.arm.name || claimed.arm.conductor;
  const runDir = path.join(runsRoot, "_worker", claimed.trial, `${sanitizeForPath(armName)}-${claimed.seed}`);
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

  // m8 (adversarial review — documented, not changed, per PM decision): this maps
  // the run's detailed RunStatus (src/types.ts) down to the platform's two-value
  // {done, failed}. Only "error" (an infrastructure failure — pi crash, WS death,
  // ...) becomes "failed". Every capped/aborted status — "aborted-cost",
  // "aborted-turns", "aborted-time", "aborted-stall" — maps to "done", same as a
  // clean "completed": a capped run still produced a gradeable result (whatever
  // checkpoints it reached before the cap), and the platform grades independently
  // of this status field. "failed" is reserved for "nothing gradeable came out of
  // this at all" (executor crash, platform-side cancel/reap). The detailed
  // RunStatus is not lost — it's carried in record.status (record.json) and now
  // also in the final "status-change" event's data (see below) so a UI can show
  // "done (aborted-turns)" rather than a bare "done".
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

  // m5 (adversarial review): every exit past this point — including the early
  // `reaped` return — must drain the EventBatcher so its setInterval timer is
  // always cleared. It used to leak on the reaped path (an early `return`
  // before `events.drain()`), which left the flush timer running (it's
  // `.unref()`'d so it doesn't itself hang the process, but a leaked interval
  // is still a bug — and any *pending* events on that path were silently
  // dropped without even counting toward dropCount).
  try {
    if (reaped) {
      // The platform already reaped this run server-side (409 on heartbeat) — it will
      // 409 events/complete too, so don't bother sending them. record.json is still
      // written to disk by executeRun itself; nothing more to do here.
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
    // Nit (adversarial review): room_id is deliberately omitted here, not a gap.
    // claimed never carries a room id (see defaultExecutor's comment above) —
    // POST .../complete's room_id field is optional and platform/bench_routes.py's
    // complete_bench_run doesn't require or use it for bench runs, so there is
    // nothing to echo back.
    if (error) completeBody.error = error;
    if (sessionGzB64) completeBody.session_gz_b64 = sessionGzB64;

    // m8: carry the detailed RunStatus (record.status, e.g. "aborted-turns")
    // alongside the platform's coarse done/failed status so a UI can distinguish
    // a clean "completed" from a capped run without a second lookup.
    const detailedStatus = record ? record.status : null;
    events.push("status-change", { status, detailedStatus });

    // On the shutdown path (SIGINT et al.) give complete() a short deadline
    // instead of the default ~5 minute retry budget — the process is exiting
    // and should not hang waiting on a possibly-unreachable platform. Any
    // shutdown signal firing (not just one that cancelled *this* run) means
    // we're on that path.
    const completeOpts = shutdownSignal?.aborted ? { deadlineMs: _timing.shutdownCompleteDeadlineMs } : {};
    const delivered = await client.complete(claimed.id, completeBody, completeOpts);
    if (!delivered) {
      log(`[worker] run ${claimed.id}: complete() was not delivered — record.json remains at ${runDir}`);
    }
    return status === "done";
  } finally {
    await events.drain();
    if (events.dropCount > 0) {
      log(`[worker] run ${claimed.id}: dropped ${events.dropCount} event(s) after retry`);
    }
  }
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
