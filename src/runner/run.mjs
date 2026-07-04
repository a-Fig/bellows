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
import { parseConductorArm } from "./config.mjs";

/** Bellows repo root — the host's vite-node config and bench.config.json live here. */
const BELLOWS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
import { provisionRun, KICKOFF_PROMPT } from "./provision.mjs";
import { PiRpc } from "./rpc.mjs";
import {
  findNewestSessionFile,
  collectSession,
  collectHostTelemetry,
  enrichTurnsWithWire,
} from "./collect.mjs";
import { harvestLeaderboard, normalizeLabel } from "./platform.mjs";

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
  const problemsText = Array.isArray(spec.problems) ? spec.problems.join(", ") : String(spec.problems);
  const startedAt = new Date();

  /** @type {import("../types.ts").RunStatus} */
  let status = "error";
  let statusDetail;

  fs.mkdirSync(runDir, { recursive: true });
  const hostTelemetryFile = arm === "none" ? null : path.join(runDir, "host.jsonl");

  // Resolve up front so a bad "external:<id>" fails before anything is spawned.
  // config.mjs's trial validation already calls parseConductorArm on load, but a
  // caller may construct/execute a run without going through that path (e.g. tests).
  const armDispatch = arm === "none" ? { type: "in-process", id: "none" } : parseConductorArm(arm);

  const fingerprint = { ...sharedFp, conductorId: arm };
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
      config,
      roomId,
      agentName,
      runLabel: label,
      problemsText,
      apiKey,
    });
    workspaceDir = prov.workspaceDir;
    agentDir = prov.agentDir;
    accordionHome = prov.accordionHome;

    // Spawn pi in RPC mode with an isolated agent dir + shared accordion home.
    const piEnv = {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      ACCORDION_HOME: accordionHome,
    };
    // A parent-shell PI_CODING_AGENT_SESSION_DIR would redirect the session
    // JSONL outside agentDir and blind the collector — force the default layout.
    delete piEnv.PI_CODING_AGENT_SESSION_DIR;
    pi = new PiRpc({ piCommand: "pi", cwd: workspaceDir, env: piEnv }).start();

    const piLog = fs.createWriteStream(path.join(runDir, "pi-rpc.log"), { flags: "a" });
    pi.on("stderr", (s) => piLog.write(s));
    pi.on("line", (o) => piLog.write("<< " + JSON.stringify(o) + "\n"));

    // Spawn the host child (unless raw baseline).
    let conductorUrl = null;
    if (armDispatch.type === "external") {
      const spawned = await spawnExternalConductor({
        config,
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
        config,
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

    const outcome = await driveUntilDone({ pi, spec, log, label, abortSignal });
    status = outcome.status;
    statusDetail = outcome.statusDetail;
  } catch (e) {
    status = "error";
    statusDetail = `run driver failed: ${e && e.stack ? e.stack.split("\n")[0] : String(e)}`;
    log(`[${label}] ERROR: ${statusDetail}`);
  } finally {
    // Teardown: pi first (abort + close), then host.
    try {
      if (pi && !pi.exited) {
        await pi.abort();
        await pi.close();
      }
    } catch (e) {
      log(`[${label}] pi teardown error: ${e.message}`);
    }
    try {
      if (host && host.exitCode === null && !host.killed) {
        host.kill("SIGTERM");
        await waitProc(host, 5_000);
        if (host.exitCode === null) host.kill("SIGKILL");
      }
    } catch (e) {
      log(`[${label}] host teardown error: ${e.message}`);
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
  try {
    sessionFile = findNewestSessionFile(agentDir) || "";
    const s = collectSession(sessionFile);
    usage = s.usage;
    turns = s.turns;
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

  let conductor = null;
  try {
    conductor = collectHostTelemetry(hostTelemetryFile, arm === "none" ? "" : arm);
    turns = enrichTurnsWithWire(turns, conductor);
  } catch (e) {
    log(`[${label}] host telemetry collect error: ${e.message}`);
  }

  let platform = null;
  try {
    // Always harvest — even a capped/aborted run leaves a non-final leaderboard
    // snapshot for each graded submission. Grading is platform-throttled, so the
    // window is generous (~5 min).
    platform = await harvestLeaderboard({
      base: spec.room.base || config.platformBase,
      label,
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
    turns,
    conductor,
    platform,
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
 * @param {AbortSignal} [abortSignal]  external cancellation (see executeRun's jsdoc)
 * @returns {Promise<{status:import("../types.ts").RunStatus, statusDetail?:string}>}
 */
function driveUntilDone({ pi, spec, log, label, abortSignal }) {
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

    const finish = (status, statusDetail) => {
      if (settled) return;
      settled = true;
      clearInterval(ticker);
      pi.off("event", onEvent);
      pi.off("exit", onExit);
      abortSignal?.removeEventListener("abort", onAbort);
      resolve({ status, statusDetail });
    };

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
        void maybePollCost();
        if (assistantTurns >= spec.caps.turns) {
          log(`[${label}] turn cap hit: ${assistantTurns} >= ${spec.caps.turns}`);
          finish("aborted-turns", `${assistantTurns} assistant turns >= cap ${spec.caps.turns}`);
        }
      } else if (type === "agent_end") {
        // Agent loop finished for this prompt. Without a follow-up, the agent has
        // stopped — mark completed. The leaderboard harvest is the score of record.
        void maybePollCost();
        finish("completed");
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
    "src/host/main.ts",
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
    env: { ...process.env },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => hostLog.write(d));
  child.stderr.on("data", (d) => hostLog.write(d));
  child.on("error", (e) => log(`[host] spawn error: ${e.message}`));
  return child;
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

  const env = { ...process.env, ACCORDION_HOME: accordionHome };
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
