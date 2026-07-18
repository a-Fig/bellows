/**
 * Single-run driver: provision dirs, spawn pi (+ host), send kickoff, enforce
 * caps, tear down, collect artifacts into a RunRecord.
 * Conforms to src/types.ts (RunRecord, RunStatus).
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSafe, killTree } from "./proc.mjs";
import { parseConductorArm, REPO_ROOT } from "./config.mjs";
import { resolveEffectiveAccordionRepo } from "./accordionRef.mjs";

/** Resolve runsDir relative to the repo root if not absolute (mirrors schedule.mjs). */
function runsRootFrom(config) {
  const rd = config.runsDir || "./runs";
  return path.isAbsolute(rd) ? rd : path.resolve(REPO_ROOT, rd);
}

/** Bellows repo root — the host's vite-node config and bench.config.json live here. */
const BELLOWS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
import { provisionRun, KICKOFF_PROMPT } from "./provision.mjs";
import { agentSpawnEnv } from "./agentEnv.mjs";
import { PiRpc } from "./rpc.mjs";
import {
  findNewestSessionFile,
  collectSession,
  collectHostTelemetry,
  enrichTurnsWithWire,
  computePlanRtt,
} from "./collect.mjs";
import { harvestLeaderboard, normalizeLabel, finalizeStaleAgent, resolveSessionRoomId } from "./platform.mjs";

const CONDUCTOR_HEARTBEAT_TIMEOUT_MS = 20_000;
const CONDUCTOR_HEARTBEAT_STALE_MS = 15_000; // mirrors Accordion's STALE_AFTER_MS

const STALL_TIMEOUT_MS = 10 * 60 * 1000; // 10 min without any event
const STATS_POLL_MIN_INTERVAL_MS = 5_000; // don't hammer get_session_stats
const MAX_FAILED_STATS_POLLS = 6; // ~30s+ of cost blindness -> stop the run

/**
 * Execute one run end to end.
 * @param {object} args
 * @param {import("../types.ts").TrialSpec} args.spec
 * @param {import("../types.ts").BenchConfig} args.config
 * @param {string} args.arm            conductor id for this arm
 * @param {string} args.armName
 * @param {number} args.seed
 * @param {string} args.roomId
 * @param {string} args.apiKey
 * @param {string} args.runDir
 * @param {Omit<import("../types.ts").Fingerprint,"conductorId">} args.sharedFp
 * @param {(m:string)=>void} args.log
 * @param {AbortSignal} [args.abortSignal]  when aborted, tears the run down early
 *   (status "error", statusDetail "cancelled"). Additive — omitted by `bellows run`;
 *   used by `bellows worker` to honor a platform-issued cancel via heartbeat.
 * @returns {Promise<import("../types.ts").RunRecord>}
 */
export async function executeRun(args) {
  const { spec, config, arm, armName, seed, roomId, apiKey, runDir, sharedFp, log, abortSignal } = args;
  // Label = "<trial>/<arm>/<seed>", trimmed + clamped to the platform's 64-char
  // limit. Used both as the run id and the leaderboard label (pull key).
  const label = normalizeLabel(`${spec.trial}/${armName}/${seed}`);
  // Agent name MUST be unique per run: the public leaderboard keeps one row per
  // agent_name (best run_score, case-insensitive) even inside a label filter, so
  // a shared name silently drops all but the best run.
  const agentName = platformAgentName(spec.trial, armName, seed);
  // Human-readable join metadata — the leaderboard displays this instead of the
  // raw (unique but gibberish) agent name. Purely additive: an old platform
  // ignores the extra "meta" body field.
  const joinMeta = buildJoinMeta({ armName, model: spec.model, conductor: arm, trial: spec.trial, seed });
  const startedAt = new Date();

  /** @type {import("../types.ts").RunStatus} */
  let status = "error";
  let statusDetail;
  // Out-param driveUntilDone mutates when it sees the agent itself call
  // `slopcode_client ... finalize` — read after the run settles to attribute
  // platform finalization to the agent vs. the post-run sweep (record.agentFinalized).
  const driveTelemetry = { sawAgentFinalize: false };

  fs.mkdirSync(runDir, { recursive: true });
  const hostTelemetryFile = arm === "none" ? null : path.join(runDir, "host.jsonl");

  // Resolve up front so a bad "external:<id>" fails before anything is spawned.
  // config.mjs's trial validation already calls parseConductorArm on load, but a
  // caller may construct/execute a run without going through that path (e.g. tests).
  const armDispatch = arm === "none" ? { type: "in-process", id: "none" } : parseConductorArm(arm);

  const fingerprint = { ...sharedFp, conductorId: arm };
  // Per-trial accordionRef: resolve to a pinned worktree (the effective accordion
  // repo) WITHOUT touching config.accordionRepo's working tree. Absent => use
  // config.accordionRepo as-is (today's behavior). The resolved SHA overrides the
  // shared fingerprint's accordionCommit so two runs on different refs fingerprint
  // differently (the comparison key). Resolution is idempotent + worktree-reused,
  // so calling it per run (incl. from tests/worker) is cheap.
  let accordionRepo = config.accordionRepo;
  if (spec.accordionRef) {
    try {
      const eff = resolveEffectiveAccordionRepo({
        accordionRepo: config.accordionRepo,
        accordionRef: spec.accordionRef,
        runsDir: runsRootFrom(config),
        log: (m) => log(`[${label}] ${m}`),
      });
      accordionRepo = eff.repo;
      if (eff.sha) fingerprint.accordionCommit = eff.sha;
      log(`[${label}] accordionRef "${eff.ref}" resolved to ${eff.sha} at worktree ${eff.repo}`);
    } catch (e) {
      // A bad ref must fail the run cleanly (before spawning anything), not run
      // silently against the wrong (base-checkout) tree.
      status = "error";
      statusDetail = `accordionRef "${spec.accordionRef}" resolution failed: ${e.message}`;
      log(`[${label}] ERROR: ${statusDetail}`);
      const endedAt = new Date();
      const record = {
        id: label,
        label,
        status,
        statusDetail,
        fingerprint,
        timing: { startedAt: startedAt.toISOString(), endedAt: endedAt.toISOString(), wallClockS: 0 },
        usage: emptyUsage(),
        turns: [],
        conductor: null,
        platform: null,
        // This run never got as far as spawning an agent, so neither finalize
        // path ever had a chance to run.
        agentFinalized: false,
        sweepFinalize: null,
        // hostTelemetryFile is null (not the would-be path): this run never spawned
        // a host, so the file will never exist — matches schedule.mjs's errorRecord
        // convention for never-started runs.
        artifacts: { piSessionFile: "", hostTelemetryFile: null, workspaceDir: runDir, agentDir: runDir },
      };
      try {
        fs.writeFileSync(path.join(runDir, "record.json"), JSON.stringify(record, null, 2));
      } catch {
        /* best-effort */
      }
      logRunSummary(record, log);
      return record;
    }
  }
  // Effective-repo-bound config for downstream consumers (provision, host spawn,
  // external-conductor launch). Only accordionRepo differs from `config`.
  const effConfig = accordionRepo === config.accordionRepo ? config : { ...config, accordionRepo };
  let workspaceDir = path.join(runDir, "workspace");
  let agentDir = path.join(runDir, "agent");
  let accordionHome = path.join(runDir, "accordion-home");

  /** @type {PiRpc | null} */
  let pi = null;
  /** @type {import("node:child_process").ChildProcess | null} */
  let host = null;
  /** @type {import("node:child_process").ChildProcess | null} */
  let externalConductor = null;
  /** @type {import("node:fs").WriteStream | null} */
  let externalConductorLog = null;

  try {
    const prov = provisionRun({
      runDir,
      spec,
      config: effConfig,
      roomId,
      agentName,
      runLabel: label,
      apiKey,
      meta: joinMeta,
    });
    workspaceDir = prov.workspaceDir;
    agentDir = prov.agentDir;
    accordionHome = prov.accordionHome;

    // Spawn pi in RPC mode with an isolated agent dir + shared accordion home.
    // ACCORDION_PLAN_TIMEOUT_MS / ACCORDION_PLAN_DEADLINE_MS (Accordion issue #58)
    // still flow through via the process.env spread below untouched — they
    // remain real tuning knobs. The armed bit that used to ride a steering env
    // var no longer travels as env: the host (src/host/main.ts) now declares
    // it over the wire to the attached extension on every (re)connect.
    const piEnv = {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      ACCORDION_HOME: accordionHome,
    };
    // A parent-shell PI_CODING_AGENT_SESSION_DIR would redirect the session
    // JSONL outside agentDir and blind the collector — force the default layout.
    delete piEnv.PI_CODING_AGENT_SESSION_DIR;
    // Issue #16: heal macOS worker-provisioning defects before the agent's first
    // command — wire certifi into SSL_CERT_FILE (else every HTTPS call fails with
    // CERTIFICATE_VERIFY_FAILED) and shim `python` -> `python3` on PATH (the
    // briefing + platform guides say `python`, but the workers expose only
    // `python3`). Both are no-ops on a healthy env (e.g. Windows workers).
    Object.assign(
      piEnv,
      agentSpawnEnv({ baseEnv: piEnv, binDir: path.join(runDir, "bin"), log }),
    );
    pi = new PiRpc({ piCommand: "pi", cwd: workspaceDir, env: piEnv }).start();

    const piLog = fs.createWriteStream(path.join(runDir, "pi-rpc.log"), { flags: "a" });
    pi.on("stderr", (s) => piLog.write(s));
    pi.on("line", (o) => piLog.write("<< " + JSON.stringify(o) + "\n"));

    // Spawn the host child (unless raw baseline).
    let conductorUrl = null;
    if (armDispatch.type === "external") {
      const spawned = await spawnExternalConductor({
        config: effConfig,
        conductorId: armDispatch.id,
        accordionHome,
        runDir,
        log,
        label,
      });
      externalConductor = spawned.child;
      externalConductorLog = spawned.conductorLog;
      conductorUrl = spawned.url;
    }
    if (arm !== "none") {
      host = spawnHost({
        config: effConfig,
        arm,
        armDispatch,
        conductorUrl,
        spec,
        accordionHome,
        hostTelemetryFile,
        runDir,
        log,
      });
    }

    // Kick off the agent.
    pi.send({ type: "prompt", message: KICKOFF_PROMPT });

    const outcome = await driveUntilDone({ pi, host, spec, log, label, abortSignal, telemetry: driveTelemetry });
    status = outcome.status;
    statusDetail = outcome.statusDetail;
  } catch (e) {
    status = "error";
    statusDetail = `run driver failed: ${e && e.stack ? e.stack.split("\n")[0] : String(e)}`;
    log(`[${label}] ERROR: ${statusDetail}`);
  } finally {
    const stopHost = async () => {
      if (host && host.exitCode === null && !host.killed) {
        host.kill("SIGTERM");
        await waitProc(host, 5_000);
        if (host.exitCode === null) host.kill("SIGKILL");
      }
    };
    // The v15 controller owns resident extension state. Stop it while the
    // extension socket is still alive so POSIX workers can disarm/detach
    // cleanly; on Windows the child is terminated directly and pi follows
    // immediately. Legacy hosts retain their established pi-first ordering.
    const v15Host = hostEntryForAccordion(effConfig.accordionRepo) === "src/host/main-v15.ts";
    if (v15Host) {
      try {
        await stopHost();
      } catch (e) {
        log(`[${label}] host teardown error: ${e.message}`);
      }
    }
    try {
      if (pi && !pi.exited) {
        await pi.abort();
        await pi.close();
      }
    } catch (e) {
      log(`[${label}] pi teardown error: ${e.message}`);
    }
    if (!v15Host) {
      try {
        await stopHost();
      } catch (e) {
        log(`[${label}] host teardown error: ${e.message}`);
      }
    }
    // The external conductor is killed AFTER the host so the host's WS close is a
    // clean session-end rather than racing a dropped conductor connection.
    // m4: killTree so a conductor's own grandchildren (e.g. a Python probe) don't
    // survive the run on win32, where a plain kill() only signals this one PID.
    try {
      if (externalConductor && externalConductor.exitCode === null && !externalConductor.killed) {
        killTree(externalConductor, "SIGTERM");
        await waitProc(externalConductor, 5_000);
        if (externalConductor.exitCode === null) killTree(externalConductor, "SIGKILL");
      }
    } catch (e) {
      log(`[${label}] external conductor teardown error: ${e.message}`);
    }
    // n9 (adversarial review): close the conductor's log write stream on every
    // teardown path — it was left open for the run's duration on the success path.
    if (externalConductorLog) {
      try {
        await new Promise((resolve) => externalConductorLog.end(resolve));
      } catch (e) {
        log(`[${label}] external conductor log close error: ${e.message}`);
      }
    }
  }

  const endedAt = new Date();

  // --- Collect ---------------------------------------------------------------
  let sessionFile = "";
  let usage;
  let turns;
  let terminalError;
  try {
    sessionFile = findNewestSessionFile(agentDir) || "";
    const s = collectSession(sessionFile);
    usage = s.usage;
    turns = s.turns;
    terminalError = s.terminalError;
    // Custom providers (e.g. token-router entries with no cost rates) make pi
    // price every message at $0. If the config carries fallback pricing for
    // this model, estimate the real spend and mark it as an estimate.
    if (usage.costUsd === 0 && usage.totalTokens > 0) {
      const modelId = spec.model.slice(spec.model.indexOf(":") + 1);
      const p = config.pricing?.[modelId];
      if (p) {
        usage.costUsd =
          (usage.input / 1e6) * (p.inputPerMtok ?? 0) +
          (usage.output / 1e6) * (p.outputPerMtok ?? 0) +
          (usage.cacheRead / 1e6) * (p.cacheReadPerMtok ?? 0) +
          (usage.cacheWrite / 1e6) * (p.cacheWritePerMtok ?? 0);
        usage.costEstimated = true;
        log(`[${label}] provider priced run at $0 — estimated $${usage.costUsd.toFixed(4)} from config.pricing`);
      } else {
        log(`[${label}] WARN: provider priced ${usage.totalTokens} tokens at $0 and no config.pricing entry for "${modelId}" — cost data is missing`);
      }
    }
  } catch (e) {
    log(`[${label}] session collect error: ${e.message}`);
    usage = emptyUsage();
    turns = [];
  }

  // Pi emits agent_end after a terminal provider/model failure too. The live
  // driver normally catches the assistant message_end error, but retain a
  // persisted-session guard so an event-stream race or older Pi build can
  // never turn stopReason=error into a gradeable "completed" run.
  if (status === "completed" && terminalError) {
    const detail = `terminal model error: ${terminalError}`;
    log(`[${label}] integrity guard: ${detail} — forcing status=error`);
    status = "error";
    statusDetail = statusDetail ? `${statusDetail}; ${detail}` : detail;
  }

  let conductor = null;
  try {
    conductor = collectHostTelemetry(hostTelemetryFile, arm === "none" ? "" : arm);
    turns = enrichTurnsWithWire(turns, conductor);
  } catch (e) {
    log(`[${label}] host telemetry collect error: ${e.message}`);
  }

  // Integrity guard: a run whose conductor never attached must not be scored as that conductor.
  // If a real conductor was requested (arm !== "none") but the host produced zero attach and
  // zero sync events while surfacing at least one error, the conductor under test never ran —
  // force the run to error so it is not gradeable as that conductor. (Issue #14.)
  // The errors>0 clause is what distinguishes a real non-attach failure from a trivially short
  // run: every genuine non-attach path emits >=1 error event (dial refused, "no session
  // descriptor", "unknown conductor", protocol mismatch), so its absence means "no failure seen".
  if (conductorNeverAttached(arm, conductor, status)) {
    const detail = `conductor "${arm}" never attached (0 attach / 0 sync; ${conductor.errors[0]})`;
    log(`[${label}] integrity guard: ${detail} — forcing status=error`);
    status = "error";
    statusDetail = statusDetail ? `${statusDetail}; ${detail}` : detail;
  }

  // Post-run finalize sweep: if the agent joined but never finalized (caps,
  // crash, forgot), close its game now — an open game wedges the pooled room
  // forever (rooms only auto-reset ~5 min AFTER finalize) and leaves the
  // leaderboard row non-final. Best-effort. finalizeStaleAgent itself
  // poll-and-retries for a bounded ~4 min when the platform refuses with
  // E_GRADE_PENDING (grading is async and can take a couple of minutes even
  // when healthy) — the run is already over, so that bounded wait here is
  // acceptable and does not block the runner's own model calls.
  // Its return value is provenance (record.sweepFinalize): "finalized" means
  // THIS sweep — not the agent — is what closed the platform game.
  let sweepFinalize = null;
  try {
    sweepFinalize = await finalizeStaleAgent({
      base: spec.room.base || config.platformBase,
      apiKey,
      workspaceDir,
      log: (m) => log(`[${label}] ${m}`),
    });
  } catch (e) {
    log(`[${label}] finalize sweep error: ${e.message}`);
  }

  // Room-scoped harvest (2026-07-18 investigation): a reused trial name can
  // collide with an older leaderboard partition, letting harvestLeaderboard
  // pick a row from a DIFFERENT room. Scope by the room the agent actually
  // joined (.slopcode_session.json), falling back to this run's pre-assigned
  // pooled room when the agent never got that far.
  const harvestRoomId = resolveSessionRoomId(workspaceDir, roomId);

  let platform = null;
  try {
    // Always harvest — even a capped/aborted run leaves a non-final leaderboard
    // snapshot for each graded submission. Grading is platform-throttled, so the
    // window is generous (~5 min).
    platform = await harvestLeaderboard({
      base: spec.room.base || config.platformBase,
      label,
      roomId: harvestRoomId,
      log,
    });
  } catch (e) {
    log(`[${label}] leaderboard harvest error: ${e.message}`);
  }
  if (platform) {
    const isFinal = platform.raw && platform.raw.final === true;
    if (!isFinal && status === "completed") {
      // pi's loop ended but the platform row isn't finalized — the agent stopped
      // without a clean finalize. Reflect that rather than overclaiming.
      statusDetail = (statusDetail ? statusDetail + "; " : "") + "platform row present but not finalized";
    } else if (status !== "completed") {
      statusDetail =
        (statusDetail ? statusDetail + "; " : "") +
        `platform row present (final=${isFinal})`;
    }
  }

  // Surface non-agent finalization even when the harvest above found nothing
  // to append to (e.g. the row wasn't visible yet) — this is about the
  // finalize CALLER, not the leaderboard row's final flag.
  statusDetail = appendAgentFinalizeNote(status, statusDetail, driveTelemetry.sawAgentFinalize, sweepFinalize);

  /** @type {import("../types.ts").RunRecord} */
  const record = {
    id: label,
    label,
    status,
    statusDetail,
    fingerprint,
    timing: {
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      wallClockS: Math.round((endedAt - startedAt) / 1000),
    },
    usage,
    planRtt: computePlanRtt(turns),
    turns,
    conductor,
    platform,
    agentFinalized: driveTelemetry.sawAgentFinalize,
    sweepFinalize,
    artifacts: {
      piSessionFile: sessionFile,
      hostTelemetryFile,
      workspaceDir,
      agentDir,
    },
  };

  const recordPath = path.join(runDir, "record.json");
  try {
    fs.writeFileSync(recordPath, JSON.stringify(record, null, 2));
  } catch (e) {
    log(`[${label}] failed to write record.json: ${e.message}`);
  }

  logRunSummary(record, log);
  return record;
}

// (helpers below)

/**
 * Watch pi's event stream and enforce caps. Resolves with a status.
 * @param {import("node:child_process").ChildProcess | null} [host]  conductor host process, if spawned (see Layer 1, issue #14)
 * @param {AbortSignal} [abortSignal]  external cancellation (see executeRun's jsdoc)
 * @param {{sawAgentFinalize:boolean}} [telemetry]  optional mutable out-param the
 *   caller reads after this promise settles (e.g. for record.agentFinalized).
 *   Kept OUT of the resolved value so the {status, statusDetail} shape driven
 *   callers/tests already depend on never changes.
 * @returns {Promise<{status:import("../types.ts").RunStatus, statusDetail?:string}>}
 */
export function driveUntilDone({ pi, host, spec, log, label, abortSignal, telemetry }) {
  return new Promise((resolve) => {
    const deadline = Date.now() + spec.caps.minutes * 60 * 1000;
    // Stall detection must never pre-empt the wall-clock cap. The run contract is
    // "end only on agent-finish or the time cap", so the short stall safety is
    // clamped to never fire before the time cap. (Every run is time-capped, so a
    // genuinely hung run is still bounded — just by `minutes`, not by the stall.)
    const stallMs = Math.max(STALL_TIMEOUT_MS, spec.caps.minutes * 60 * 1000 + 60_000);
    let assistantTurns = 0;
    let lastEventAt = Date.now();
    let lastStatsAt = 0;
    let settled = false;
    let statsInFlight = false;
    let latestAssistantError = null;
    let latestAssistantMessage = null;

    const finish = (status, statusDetail) => {
      if (settled) return;
      settled = true;
      clearInterval(ticker);
      pi.off("event", onEvent);
      pi.off("exit", onExit);
      abortSignal?.removeEventListener("abort", onAbort);
      if (host) host.off("exit", onHostExit);
      resolve({ status, statusDetail });
    };

    // Layer 1 (issue #14): the conductor host is a separate process from pi. If it
    // dies before the run finishes — e.g. it threw "unknown conductor" during
    // attach and called process.exit(1) — pi's event stream never learns about it
    // and would otherwise sail on to "completed". A nonzero host exit is always
    // fatal to the conductor under test, so fail the run fast. A clean exit(0) is
    // the host's normal end-of-run shutdown and is left to the pi-driven paths
    // above; our own teardown SIGTERM/SIGKILL yields code===null and must not be
    // misread as a failure (finish's settled guard also makes any post-settle
    // call here a no-op).
    const onHostExit = (code, signal) => {
      if (code && code !== 0) {
        finish("error", `conductor host exited (code ${code}) before the run finished — conductor likely failed to attach`);
      }
    };
    host?.on("exit", onHostExit);

    const onAbort = () => {
      log(`[${label}] cancelled externally`);
      finish("error", "cancelled by platform");
    };
    if (abortSignal) {
      if (abortSignal.aborted) {
        // Already cancelled before we even started driving — finish on the next tick so
        // the caller's listeners (attached right after this promise is constructed) run.
        queueMicrotask(onAbort);
      } else {
        abortSignal.addEventListener("abort", onAbort, { once: true });
      }
    }

    let failedStatsPolls = 0;
    let warnedZeroCost = false;
    const maybePollCost = async () => {
      if (statsInFlight) return;
      const now = Date.now();
      if (now - lastStatsAt < STATS_POLL_MIN_INTERVAL_MS) return;
      lastStatsAt = now;
      statsInFlight = true;
      const stats = await pi.getSessionStats();
      statsInFlight = false;
      if (settled) return;
      if (!stats || typeof stats.cost !== "number") {
        // The cost cap must never silently disable itself: after repeated failed
        // polls we cannot see spend, so stop the run instead of running capless.
        failedStatsPolls++;
        log(`[${label}] WARN: get_session_stats gave no cost (${failedStatsPolls} consecutive)`);
        if (failedStatsPolls >= MAX_FAILED_STATS_POLLS) {
          finish("error", `cost cap blind: ${failedStatsPolls} consecutive failed stats polls`);
        }
        return;
      }
      failedStatsPolls = 0;
      if (stats.cost >= spec.caps.costUsd) {
        log(`[${label}] cost cap hit: $${stats.cost.toFixed(4)} >= $${spec.caps.costUsd}`);
        finish("aborted-cost", `cost $${stats.cost.toFixed(4)} >= cap $${spec.caps.costUsd}`);
        return;
      }
      // Zero-priced custom providers make the dollar cap inert — the token cap
      // is the backstop. Warn once so a capless run is never silent.
      const totalTokens = stats.tokens && typeof stats.tokens.total === "number" ? stats.tokens.total : null;
      if (stats.cost === 0 && totalTokens !== null && totalTokens > 100_000 && !warnedZeroCost) {
        warnedZeroCost = true;
        log(`[${label}] WARN: provider reports $0 at ${totalTokens} tokens — dollar cap is inert${spec.caps.totalTokens ? "" : " and no caps.totalTokens is set"}`);
      }
      if (spec.caps.totalTokens && totalTokens !== null && totalTokens >= spec.caps.totalTokens) {
        log(`[${label}] token cap hit: ${totalTokens} >= ${spec.caps.totalTokens}`);
        finish("aborted-cost", `totalTokens ${totalTokens} >= cap ${spec.caps.totalTokens}`);
      }
    };

    // Pi's streamed AgentEvent types (verified from pi-coding-agent
    // dist/core/agent-session.js — every raw agent event reaches session.subscribe,
    // which RPC mode writes to stdout):
    //   message_start | message_update | message_end (carries .message) |
    //   turn_start | turn_end | agent_start | agent_end (loop done) |
    //   tool_execution_* | ...
    // There is NO flat {type:"message"} streamed event — that shape only exists in
    // the persisted session JSONL (which the collector parses).
    //
    // We count each assistant `message_end` as a "turn" so the live cap lines up
    // with usage.assistantTurns (the collector counts one per assistant message).
    const onEvent = (ev) => {
      lastEventAt = Date.now();
      const type = ev && ev.type;
      if (type === "message_end" && ev.message && ev.message.role === "assistant") {
        assistantTurns++;
        latestAssistantMessage = ev.message;
        if (ev.message.stopReason === "error") {
          latestAssistantError =
            typeof ev.message.errorMessage === "string" && ev.message.errorMessage.trim()
              ? ev.message.errorMessage.trim()
              : "model response ended with stopReason=error";
        } else latestAssistantError = null;
        void maybePollCost();
        if (assistantTurns >= spec.caps.turns) {
          log(`[${label}] turn cap hit: ${assistantTurns} >= ${spec.caps.turns}`);
          finish("aborted-turns", `${assistantTurns} assistant turns >= cap ${spec.caps.turns}`);
        }
      } else if (type === "tool_execution_start") {
        // Agent-issued platform finalize (as opposed to the runner's own
        // post-run sweep) — tracked here so executeRun can record provenance
        // (record.agentFinalized) without re-deriving it from the session file.
        if (telemetry && !telemetry.sawAgentFinalize && looksLikeAgentFinalizeCall(ev.args)) {
          telemetry.sawAgentFinalize = true;
        }
      } else if (type === "agent_end") {
        // Pi also emits agent_end between automatic provider retries. Keep driving
        // while willRetry=true; only the final agent_end can settle the run.
        void maybePollCost();
        if (ev.willRetry === true) {
          log(`[${label}] model response failed; pi will retry automatically`);
        } else if (latestAssistantError) {
          log(`[${label}] terminal model error: ${latestAssistantError}`);
          finish("error", `terminal model error: ${latestAssistantError}`);
        } else if (isDegenerateAssistantMessage(latestAssistantMessage) && !telemetry?.sawAgentFinalize) {
          // Sentinel-echo failure mode (2026-07-18 investigation): the final
          // response is a syntactically normal stop (stopReason "stop", not
          // "error") whose content is reasoning-only — no text, no tool call.
          // Pi reports this identically to a genuine success, so without this
          // check the run is misclassified "completed" and the post-run sweep
          // finalizes an unfinished game on the agent's behalf.
          //
          // Gated on !sawAgentFinalize: a run that already called
          // `slopcode_client ... finalize` has a legitimate graded result —
          // a trailing reasoning-only message after that (e.g. the agent
          // musing post-finalize) must not demote a real completion to error
          // and drop it from scored aggregates.
          const detail =
            "terminal degenerate response: final assistant message has no text and no tool call (reasoning-only stop)";
          log(`[${label}] ${detail}`);
          finish("error", detail);
        } else {
          finish("completed");
        }
      }
    };

    const onExit = ({ code, signal }) => {
      if (settled) return;
      // pi died on its own. If it exited 0 treat as completed, else error.
      if (code === 0) finish("completed");
      else finish("error", `pi exited code=${code} signal=${signal}`);
    };

    const ticker = setInterval(() => {
      const now = Date.now();
      if (now >= deadline) {
        log(`[${label}] wall-clock cap hit (${spec.caps.minutes} min)`);
        finish("aborted-time", `wall-clock >= ${spec.caps.minutes} min`);
        return;
      }
      if (now - lastEventAt >= stallMs) {
        log(`[${label}] stall: no events for ${Math.round((now - lastEventAt) / 1000)}s`);
        finish("aborted-stall", `no events for ${Math.round((now - lastEventAt) / 1000)}s`);
        return;
      }
      void maybePollCost();
    }, 5_000);

    pi.on("event", onEvent);
    pi.on("exit", onExit);
  });
}

/**
 * True iff `message` is a reasoning-only (or empty) terminal assistant
 * response: no `toolCall` content block, and no `text` content block whose
 * text is non-whitespace. A plain-string `content` counts as text — degenerate
 * only when that string is itself whitespace-only. A falsy `message` (no
 * assistant message was ever observed for this run) is NOT degenerate, so a
 * bare `agent_end` with no prior message_end still resolves "completed".
 * Exported as the unit-testable seam for driveUntilDone's terminal check.
 * @param {unknown} message
 * @returns {boolean}
 */
export function isDegenerateAssistantMessage(message) {
  if (!message || typeof message !== "object") return false;
  const content = message.content;
  if (typeof content === "string") return content.trim().length === 0;
  if (!Array.isArray(content)) return true;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "toolCall") return false;
    if (block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0) return false;
  }
  return true;
}

/**
 * True iff a tool call's arguments look like the agent invoking the SlopCode
 * client's `finalize` command (case-insensitive substring match over the
 * serialized args) — e.g. a bash tool call running
 * `python slopcode_client.py finalize`. Used to distinguish an agent-issued
 * finalize from the runner's own post-run `finalizeStaleAgent` sweep.
 * @param {unknown} args  tool_execution_start's `.args`
 * @returns {boolean}
 */
export function looksLikeAgentFinalizeCall(args) {
  if (args === undefined) return false;
  let s;
  try {
    s = JSON.stringify(args);
  } catch {
    return false;
  }
  if (typeof s !== "string") return false;
  s = s.toLowerCase();
  return s.includes("slopcode_client") && s.includes("finalize");
}

/**
 * Append an "agent never invoked platform finalize" note to statusDetail when
 * a run reports completed but no agent-issued finalize tool call was
 * observed. The wording depends on what the post-run sweep (finalizeStaleAgent)
 * actually achieved: on "finalized" it correctly claims the sweep closed the
 * game; any other result ("no-session" | "failed" | "grade-pending-gave-up" |
 * null) means the sweep did NOT finalize either, so the note must not
 * overclaim — it instead reports the sweep's own result string. Follows the
 * same append pattern as the post-harvest guard (join with "; "). Exported as
 * the unit-testable seam for executeRun's record-assembly step.
 * @param {import("../types.ts").RunStatus} status
 * @param {string|undefined} statusDetail
 * @param {boolean} sawAgentFinalize
 * @param {string|null} sweepFinalize  finalizeStaleAgent's return value
 * @returns {string|undefined}
 */
export function appendAgentFinalizeNote(status, statusDetail, sawAgentFinalize, sweepFinalize) {
  if (status !== "completed" || sawAgentFinalize) return statusDetail;
  const note =
    sweepFinalize === "finalized"
      ? "agent never invoked platform finalize; game finalized by post-run sweep"
      : `agent never invoked platform finalize; sweep result: ${sweepFinalize}`;
  return statusDetail ? `${statusDetail}; ${note}` : note;
}

/**
 * Env overrides for every child process that must see the run's EFFECTIVE
 * accordion repo — spread into `{ ...process.env, ...hostEnv(config) }` at both
 * spawn sites (host, external conductor). When a run pins an accordionRef,
 * config.accordionRepo here is already the pinned-worktree path, so the host's
 * accordion.ts + vite-node.config.ts load the engine/$conductors from the SAME
 * tree the runner provisioned. Always set (harmless when equal to the default)
 * so a child never silently disagrees with the runner about which repo.
 * Exported as the unit-testable seam for the executeRun -> effConfig ->
 * BELLOWS_ACCORDION_REPO wiring.
 * @param {import("../types.ts").BenchConfig} config  effective config for this run
 * @returns {{BELLOWS_ACCORDION_REPO: string}}
 */
export function hostEnv(config) {
  return { BELLOWS_ACCORDION_REPO: config.accordionRepo };
}

/**
 * Issue #14 integrity guard: true when a real conductor was requested (arm !== "none")
 * but its telemetry shows it never attached (0 attach / 0 sync) while surfacing at least
 * one error — i.e. the conductor under test never ran, so a "completed" status would
 * misrepresent the run. Exported as the unit-testable seam for executeRun's finalization
 * guard.
 * @param {string} arm  raw arms[].conductor string (for "none"/telemetry)
 * @param {import("../types.ts").ConductorTelemetry | null} conductor
 * @param {import("../types.ts").RunStatus} status
 * @returns {boolean}
 */
export function conductorNeverAttached(arm, conductor, status) {
  return (
    arm !== "none" &&
    !!conductor &&
    conductor.attachCount === 0 &&
    conductor.syncs === 0 &&
    conductor.errors.length > 0 &&
    status === "completed"
  );
}

/**
 * Spawn the headless host child pointing at the shared accordion home.
 * @param {object} args
 * @param {import("../types.ts").BenchConfig} args.config
 * @param {string} args.arm                   raw arms[].conductor string (for "none"/telemetry)
 * @param {{type:"in-process"|"external", id:string}} [args.armDispatch]  parsed dispatch (defaults to in-process(arm))
 * @param {string|null} [args.conductorUrl]    ws:// URL of a spawned external conductor
 * @param {import("../types.ts").TrialSpec} args.spec
 * @param {string} args.accordionHome
 * @param {string|null} args.hostTelemetryFile
 * @param {string} args.runDir
 * @param {(m:string)=>void} args.log
 */
export function spawnHost({ config, arm, armDispatch, conductorUrl, spec, accordionHome, hostTelemetryFile, runDir, log }) {
  const dispatch = armDispatch || { type: "in-process", id: arm };
  // Invoke vite-node's entry directly with node.exe — no npx/.cmd shim, so
  // Windows paths with spaces never pass through cmd.exe quote handling.
  const hostArgs = [
    path.join(BELLOWS_ROOT, "node_modules", "vite-node", "vite-node.mjs"),
    "--config",
    "vite-node.config.ts",
    hostEntryForAccordion(config.accordionRepo),
    "--",
    "--accordion-home",
    accordionHome,
  ];
  if (dispatch.type === "external") {
    if (!conductorUrl) throw new Error(`spawnHost: external conductor "${dispatch.id}" has no conductorUrl`);
    hostArgs.push("--conductor-url", conductorUrl, "--conductor-id", dispatch.id);
  } else {
    hostArgs.push("--conductor", dispatch.id);
  }
  hostArgs.push(
    "--budget",
    String(spec.budget),
    "--protect",
    String(spec.protectTokens),
    "--telemetry-out",
    hostTelemetryFile,
    // Keep the host available for reconnects across the WHOLE run, not the host's
    // 30-min default — otherwise a long run loses its conductor after 30 min.
    "--timeout-min",
    String(spec.caps.minutes + 5),
  );
  const hostLog = fs.createWriteStream(path.join(runDir, "host-stderr.log"), { flags: "a" });
  const child = spawnSafe(process.execPath, hostArgs, {
    cwd: BELLOWS_ROOT,
    env: { ...process.env, ...hostEnv(config) },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => hostLog.write(d));
  child.stderr.on("data", (d) => hostLog.write(d));
  child.on("error", (e) => log(`[host] spawn error: ${e.message}`));
  return child;
}

/** Select the protocol-v15 controller for truth-in-extension checkouts. */
export function hostEntryForAccordion(accordionRepo) {
  return typeof accordionRepo === "string" && fs.existsSync(path.join(accordionRepo, "core", "protocol.ts"))
    ? "src/host/main-v15.ts"
    : "src/host/main.ts";
}

/**
 * Locate an external conductor's launch.json under `<accordionRepo>/conductors/<id>/`.
 * @param {string} accordionRepo
 * @param {string} conductorId
 * @returns {{dir:string, launch: {id?:string, label?:string, command:string, args?:string[], portEnv?:string}}}
 */
export function loadConductorLaunchSpec(accordionRepo, conductorId) {
  const dir = path.join(accordionRepo, "conductors", conductorId);
  const launchPath = path.join(dir, "launch.json");
  if (!fs.existsSync(launchPath)) {
    throw new Error(
      `external conductor "${conductorId}": no launch.json found at ${launchPath}. ` +
        `External conductors are launched from <accordionRepo>/conductors/<id>/launch.json ` +
        `(e.g. {"id":"thermocline","command":"node","args":["thermocline.mjs"]}).`,
    );
  }
  let launch;
  try {
    launch = JSON.parse(fs.readFileSync(launchPath, "utf8"));
  } catch (e) {
    throw new Error(`external conductor "${conductorId}": failed to parse ${launchPath}: ${e.message}`);
  }
  if (!launch || typeof launch.command !== "string" || !launch.command.trim()) {
    throw new Error(`external conductor "${conductorId}": ${launchPath} must have a "command" string`);
  }
  return { dir, launch };
}

/**
 * Bind to port 0, read back the OS-assigned free port, then close.
 *
 * m5 (adversarial review): this has an inherent TOCTOU race — the port is free
 * at the instant we close our probe socket, but nothing reserves it between
 * that close and the conductor process's own bind a moment later. Another
 * process (or a concurrent `parallel: N` run on this machine) can grab it
 * first. We accept the race rather than engineering around it: a lost race
 * surfaces cleanly as `waitForConductorHeartbeat`'s timeout (M2 now guarantees
 * that failure kills the spawned process rather than leaking it), not a silent
 * hang or a crash. See TUTORIAL.md's external-conductors section for the
 * user-facing note.
 */
export function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

/**
 * Spawn an external conductor process (its own WS server) for this run and wait
 * for its discovery heartbeat to appear under `<accordionHome>/.accordion/conductors/<id>.json`.
 *
 * @param {object} args
 * @param {import("../types.ts").BenchConfig} args.config
 * @param {string} args.conductorId
 * @param {string} args.accordionHome     this run's ACCORDION_HOME (heartbeat + isolation)
 * @param {string} args.runDir
 * @param {(m:string)=>void} args.log
 * @param {string} args.label
 * @returns {Promise<{child: import("node:child_process").ChildProcess, url: string, conductorLog: import("node:fs").WriteStream}>}
 */
export async function spawnExternalConductor({ config, conductorId, accordionHome, runDir, log, label }) {
  const { dir, launch } = loadConductorLaunchSpec(config.accordionRepo, conductorId);

  const env = { ...process.env, ...hostEnv(config), ACCORDION_HOME: accordionHome };
  if (launch.portEnv) {
    const port = await getFreePort();
    env[launch.portEnv] = String(port);
  } else {
    log(
      `[${label}] WARN: conductor "${conductorId}" launch.json has no "portEnv" — it will bind its ` +
        `default port, so this conductor CANNOT run in parallel arms/runs on this machine.`,
    );
  }

  const args = Array.isArray(launch.args) ? launch.args : [];
  const conductorLog = fs.createWriteStream(path.join(runDir, `conductor-${conductorId}.log`), { flags: "a" });
  const child = spawnSafe(launch.command, args, {
    cwd: dir,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d) => conductorLog.write(d));
  child.stderr?.on("data", (d) => conductorLog.write(d));
  let spawnErr = null;
  child.on("error", (e) => {
    spawnErr = e;
    log(`[${label}] conductor "${conductorId}" spawn error: ${e.message}`);
  });

  const heartbeatPath = path.join(accordionHome, ".accordion", "conductors", `${conductorId}.json`);
  try {
    const url = await waitForConductorHeartbeat({
      heartbeatPath,
      conductorId,
      child,
      getSpawnErr: () => spawnErr,
    });
    log(`[${label}] external conductor "${conductorId}" ready at ${url}`);
    // Success: the conductor keeps running for the rest of the trial, so the log
    // stream must stay open — hand it back so the caller can close it exactly
    // once, alongside the process kill, when the run actually tears down (n9).
    return { child, url, conductorLog };
  } catch (e) {
    // M2 (adversarial review): a heartbeat that never appears must not leave the
    // spawned process orphaned — executeRun's finally block only tears down
    // `externalConductor`, which is still null here because we haven't returned
    // yet (the caller never got a handle to kill). Kill it ourselves before
    // rethrowing so a conductor that hangs/crashes before advertising a heartbeat
    // doesn't leak a process (and, on win32, its whole subtree — see killTree).
    const pid = child.pid;
    killTree(child, "SIGTERM");
    await waitProc(child, 5_000);
    if (child.exitCode === null) killTree(child, "SIGKILL");
    // n9: this is the ONLY path where spawnExternalConductor itself owns
    // teardown end to end, so close the log stream here before rethrowing.
    await new Promise((resolve) => conductorLog.end(resolve));
    // Expose the pid + exit state on the error so a caller/test can verify the
    // process actually died rather than assuming it from a nonexistent handle.
    e.killedPid = pid;
    e.killedExitCode = child.exitCode;
    throw e;
  }
}

/** Poll a conductor's heartbeat JSON until it appears fresh, or throw on timeout/crash. */
function waitForConductorHeartbeat({ heartbeatPath, conductorId, child, getSpawnErr }) {
  const deadline = Date.now() + CONDUCTOR_HEARTBEAT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const spawnErr = getSpawnErr();
      if (spawnErr) {
        reject(new Error(`external conductor "${conductorId}" failed to spawn: ${spawnErr.message}`));
        return;
      }
      if (child.exitCode !== null) {
        reject(
          new Error(
            `external conductor "${conductorId}" exited (code=${child.exitCode}) before advertising a heartbeat`,
          ),
        );
        return;
      }
      if (fs.existsSync(heartbeatPath)) {
        try {
          const entry = JSON.parse(fs.readFileSync(heartbeatPath, "utf8"));
          const fresh = typeof entry.heartbeatAt === "number" && Date.now() - entry.heartbeatAt <= CONDUCTOR_HEARTBEAT_STALE_MS;
          if (fresh && typeof entry.url === "string" && entry.url) {
            resolve(entry.url);
            return;
          }
        } catch {
          /* half-written file — keep polling */
        }
      }
      if (Date.now() >= deadline) {
        reject(
          new Error(
            `external conductor "${conductorId}" did not advertise a fresh heartbeat at ${heartbeatPath} ` +
              `within ${CONDUCTOR_HEARTBEAT_TIMEOUT_MS}ms`,
          ),
        );
        return;
      }
      setTimeout(tick, 250);
    };
    tick();
  });
}

// --- helpers -----------------------------------------------------------------

/**
 * A UNIQUE-per-run platform agent name: "<trial>-<arm>-s<seed>". The public
 * leaderboard partitions by LOWER(agent_name) and keeps only the best run per
 * name, so uniqueness is required or sibling runs vanish. Kept ASCII-safe and
 * bounded so it is a valid, stable join name (the briefing uses this exact
 * string).
 */
export function platformAgentName(trial, armName, seed) {
  return `${trial}-${armName}-s${seed}`.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80);
}

const META_FIELD_MAX = 120;

/** Truncate a string to the platform's 120-char field cap (never throws). */
function clampMetaField(s) {
  return String(s).slice(0, META_FIELD_MAX);
}

/**
 * Shorten a "provider:modelId" (or bare modelId) string for display: strips a
 * leading "token-router:" provider prefix, then takes the last "/"-separated
 * path segment. E.g. "token-router:deepseek/deepseek-v4-flash" -> "deepseek-v4-flash".
 * @param {string} model
 */
export function modelShortName(model) {
  const noProvider = model.startsWith("token-router:") ? model.slice("token-router:".length) : model;
  const parts = noProvider.split("/");
  return parts[parts.length - 1];
}

/**
 * Build the optional join-meta object surfaced on the leaderboard (see the
 * platform's POST /rooms/<id>/register `meta` field). Every string field is
 * capped at 120 chars; this never throws.
 * @param {object} args
 * @param {string} args.armName
 * @param {string} args.model     full "provider:modelId" string
 * @param {string} args.conductor arm string as used elsewhere (e.g. "external:thermocline")
 * @param {string} args.trial
 * @param {number} args.seed
 * @returns {{display_name:string, model:string, conductor:string, trial:string, seed:number}}
 */
export function buildJoinMeta({ armName, model, conductor, trial, seed }) {
  const displayName = `${armName} · ${modelShortName(model)} · s${seed}`;
  return {
    display_name: clampMetaField(displayName),
    model: clampMetaField(model),
    conductor: clampMetaField(conductor),
    trial: clampMetaField(trial),
    seed: Math.trunc(seed),
  };
}

function waitProc(child, ms) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    costUsd: 0,
    assistantTurns: 0,
    toolCalls: 0,
  };
}

function logRunSummary(record, log) {
  const p = record.platform;
  const ck = p ? `${p.checkpointsSolved}/${p.checkpointsAttempted}` : "-";
  const score = p && p.runScore != null ? p.runScore.toFixed(3) : "-";
  log(
    `[done] ${record.label}  status=${record.status}  ` +
      `cost=$${record.usage.costUsd.toFixed(4)}  tokens=${record.usage.totalTokens}  ` +
      `turns=${record.usage.assistantTurns}  ckpts=${ck}  score=${score}` +
      (record.statusDetail ? `  (${record.statusDetail})` : ""),
  );
}
