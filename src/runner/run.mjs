/**
 * Single-run driver: provision dirs, spawn pi (+ host), send kickoff, enforce
 * caps, tear down, collect artifacts into a RunRecord.
 * Conforms to src/types.ts (RunRecord, RunStatus).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSafe } from "./proc.mjs";

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

const STALL_TIMEOUT_MS = 10 * 60 * 1000; // 10 min without any event
const STATS_POLL_MIN_INTERVAL_MS = 5_000; // don't hammer get_session_stats

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
 * @returns {Promise<import("../types.ts").RunRecord>}
 */
export async function executeRun(args) {
  const { spec, config, arm, armName, seed, roomId, apiKey, runDir, sharedFp, log } = args;
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

  const fingerprint = { ...sharedFp, conductorId: arm };
  let workspaceDir = path.join(runDir, "workspace");
  let agentDir = path.join(runDir, "agent");
  let accordionHome = path.join(runDir, "accordion-home");

  /** @type {PiRpc | null} */
  let pi = null;
  /** @type {import("node:child_process").ChildProcess | null} */
  let host = null;

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
    pi = new PiRpc({ piCommand: "pi", cwd: workspaceDir, env: piEnv }).start();

    const piLog = fs.createWriteStream(path.join(runDir, "pi-rpc.log"), { flags: "a" });
    pi.on("stderr", (s) => piLog.write(s));
    pi.on("line", (o) => piLog.write("<< " + JSON.stringify(o) + "\n"));

    // Spawn the host child (unless raw baseline).
    if (arm !== "none") {
      host = spawnHost({ config, arm, spec, accordionHome, hostTelemetryFile, runDir, log });
    }

    // Kick off the agent.
    pi.send({ type: "prompt", message: KICKOFF_PROMPT });

    const outcome = await driveUntilDone({ pi, spec, log, label });
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
 * @returns {Promise<{status:import("../types.ts").RunStatus, statusDetail?:string}>}
 */
function driveUntilDone({ pi, spec, log, label }) {
  return new Promise((resolve) => {
    const deadline = Date.now() + spec.caps.minutes * 60 * 1000;
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
      resolve({ status, statusDetail });
    };

    const maybePollCost = async () => {
      if (statsInFlight) return;
      const now = Date.now();
      if (now - lastStatsAt < STATS_POLL_MIN_INTERVAL_MS) return;
      lastStatsAt = now;
      statsInFlight = true;
      const stats = await pi.getSessionStats();
      statsInFlight = false;
      if (settled) return;
      if (stats && typeof stats.cost === "number" && stats.cost >= spec.caps.costUsd) {
        log(`[${label}] cost cap hit: $${stats.cost.toFixed(4)} >= $${spec.caps.costUsd}`);
        finish("aborted-cost", `cost $${stats.cost.toFixed(4)} >= cap $${spec.caps.costUsd}`);
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
      if (now - lastEventAt >= STALL_TIMEOUT_MS) {
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

/** Spawn the headless host child pointing at the shared accordion home. */
export function spawnHost({ config, arm, spec, accordionHome, hostTelemetryFile, runDir, log }) {
  const hostArgs = [
    "vite-node",
    "--config",
    "vite-node.config.ts",
    "src/host/main.ts",
    "--",
    "--accordion-home",
    accordionHome,
    "--conductor",
    arm,
    "--budget",
    String(spec.budget),
    "--protect",
    String(spec.protectTokens),
    "--telemetry-out",
    hostTelemetryFile,
  ];
  const hostLog = fs.createWriteStream(path.join(runDir, "host-stderr.log"), { flags: "a" });
  const child = spawnSafe("npx", hostArgs, {
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
