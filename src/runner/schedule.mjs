/**
 * Trial scheduler: expand seeds×arms into runs, assign platform rooms, execute
 * with a concurrency limit. One in-flight run per room (pool round-robin).
 */
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./config.mjs";
import { sharedFingerprint } from "./fingerprint.mjs";
import { TEMPLATE_DIR, KICKOFF_PROMPT, renderBriefing } from "./provision.mjs";
import { executeRun, platformAgentName } from "./run.mjs";
import { createRoom, probeRoomJoinable, sleep } from "./platform.mjs";
import { slopcodeRoomConfig } from "./roomConfig.mjs";

/**
 * Expand a spec into the flat list of runs (arm × seed).
 * @param {import("../types.ts").TrialSpec} spec
 * @returns {{arm:string, armName:string, seed:number, runDir:string, label:string}[]}
 */
export function expandRuns(spec, runsRoot) {
  const runs = [];
  const trialDir = path.join(runsRoot, spec.trial);
  for (const arm of spec.arms) {
    const armName = arm.name || arm.conductor;
    // The ":" in external:<id> arm names is illegal in Windows paths — sanitize
    // for the directory only; armName/label keep the real id everywhere else.
    const armDirName = armName.replace(/[<>:"/\\|?*]/g, "-");
    for (let seed = 1; seed <= (spec.seeds || 1); seed++) {
      runs.push({
        arm: arm.conductor,
        armName,
        seed,
        runDir: path.join(trialDir, `${armDirName}-${seed}`),
        label: `${spec.trial}/${armName}/${seed}`,
      });
    }
  }
  return runs;
}

/** Resolve runsDir relative to the repo root if not absolute. */
export function resolveRunsRoot(config) {
  const rd = config.runsDir || "./runs";
  return path.isAbsolute(rd) ? rd : path.resolve(REPO_ROOT, rd);
}

/**
 * Build the shared fingerprint + kickoff for a trial (once).
 * @returns {{ sharedFp: Omit<import("../types.ts").Fingerprint,"conductorId">, kickoff:string }}
 */
export function buildSharedContext(spec, config) {
  const kickoff = KICKOFF_PROMPT;
  const sharedFp = sharedFingerprint({
    spec,
    config,
    workspaceTemplateDir: TEMPLATE_DIR,
    kickoffPrompt: kickoff,
  });
  return { sharedFp, kickoff };
}

/**
 * A simple room pool with lease/return semantics. Rooms are reusable after a
 * run returns them (single concurrent run per room).
 */
export class RoomPool {
  /**
   * @param {object} args
   * @param {string[]} args.pool
   * @param {boolean} args.create
   * @param {string} args.base
   * @param {string} args.apiKey
   * @param {string | string[]} [args.problems]  spec.problems — derives the room's
   *   problem_set/problems bucket (see roomConfig.mjs); omitted => full bench.
   * @param {(m:string)=>void} args.log
   */
  constructor({ pool, create, base, apiKey, problems, log }) {
    this.available = [...pool];
    this.create = create;
    this.base = base;
    this.apiKey = apiKey;
    this.problems = problems;
    this.log = log;
    this._waiters = [];
  }

  /** Lease a room id. Creates one if configured and none are free. */
  async lease() {
    if (this.available.length) return this.available.shift();
    if (this.create) {
      // Deployed shape (agent-trials PR #98): game_type required; name
      // auto-generated when omitted. Default auto-reset stays on so created
      // rooms recycle instead of accumulating against the per-account cap
      // (scores are harvested from the leaderboard, never live room state).
      const roomConfig = slopcodeRoomConfig(this.problems);
      this.log(`[rooms] leaderboard bucket for this trial: ${describeRoomConfig(roomConfig)}`);
      const id = await createRoom({
        base: this.base,
        apiKey: this.apiKey,
        roomConfig,
      });
      this.log(`[rooms] created room ${id}`);
      return id;
    }
    // Wait for a returned room.
    return new Promise((resolve) => this._waiters.push(resolve));
  }

  /** Return a room to the pool (after its auto-reset window, verify joinable). */
  async release(roomId) {
    // Best-effort: give the room its ~30s auto-reset, then verify it re-accepts
    // agents before handing it to the next run. Backoff a few times.
    const waiter = this._waiters.shift();
    if (!waiter) {
      this.available.push(roomId);
      return;
    }
    // A run is waiting — verify reset with backoff, then hand it over.
    let ok = false;
    for (let i = 0; i < 4 && !ok; i++) {
      await sleep(i === 0 ? 30_000 : 15_000);
      ok = await probeRoomJoinable({
        base: this.base,
        apiKey: this.apiKey,
        roomId,
        probeName: `bellows_probe_${Date.now()}`,
      });
      if (!ok) this.log(`[rooms] ${roomId} not yet joinable (attempt ${i + 1})`);
    }
    waiter(roomId);
  }
}

/**
 * Run all runs of a trial with concurrency limit. Returns the RunRecords.
 * @param {object} args
 * @param {import("../types.ts").TrialSpec} args.spec
 * @param {import("../types.ts").BenchConfig} args.config
 * @param {string} args.apiKey
 * @param {(m:string)=>void} args.log
 * @returns {Promise<import("../types.ts").RunRecord[]>}
 */
export async function runTrial({ spec, config, apiKey, log }) {
  const runsRoot = resolveRunsRoot(config);
  const runs = expandRuns(spec, runsRoot);
  const { sharedFp } = buildSharedContext(spec, config);
  const base = spec.room.base || config.platformBase;

  const pool = new RoomPool({
    pool: spec.room.pool || [],
    create: spec.room.create === true,
    base,
    apiKey,
    problems: spec.problems,
    log,
  });

  const longestLabel = runs.reduce((m, r) => Math.max(m, r.label.length), 0);
  if (longestLabel > 64)
    log(
      `[trial] WARNING: longest run label is ${longestLabel} chars > 64; the platform clamps ` +
        `labels to 64 chars and sibling runs may collide. Shorten the trial name.`,
    );

  const parallel = Math.max(1, Math.min(spec.parallel || 1, runs.length));
  log(
    `[trial] ${spec.trial}: ${runs.length} runs (${spec.arms.length} arms × ${spec.seeds || 1} seeds), ` +
      `parallel=${parallel}, rooms=${(spec.room.pool || []).length || (spec.room.create ? "create" : 0)}`,
  );

  const results = new Array(runs.length);
  let next = 0;

  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= runs.length) return;
      const run = runs[i];
      let roomId;
      try {
        roomId = await pool.lease();
      } catch (e) {
        log(`[${run.label}] could not obtain room: ${e.message}`);
        results[i] = errorRecord(run, spec, { ...sharedFp, conductorId: run.arm }, `no room: ${e.message}`);
        continue;
      }
      log(`[${run.label}] -> room ${roomId}`);
      try {
        results[i] = await executeRun({
          spec,
          config,
          arm: run.arm,
          armName: run.armName,
          seed: run.seed,
          roomId,
          apiKey,
          runDir: run.runDir,
          sharedFp,
          log,
        });
      } catch (e) {
        results[i] = errorRecord(run, spec, { ...sharedFp, conductorId: run.arm }, `executeRun threw: ${e.message}`);
        log(`[${run.label}] executeRun threw: ${e.message}`);
      } finally {
        await pool.release(roomId);
      }
    }
  };

  await Promise.all(Array.from({ length: parallel }, () => worker()));
  return results;
}

/** Synthesize an error RunRecord for a run that never got off the ground. */
function errorRecord(run, spec, fingerprint, detail) {
  const now = new Date().toISOString();
  return {
    id: run.label,
    label: run.label,
    status: "error",
    statusDetail: detail,
    fingerprint,
    timing: { startedAt: now, endedAt: now, wallClockS: 0 },
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costUsd: 0, assistantTurns: 0, toolCalls: 0 },
    turns: [],
    conductor: null,
    platform: null,
    artifacts: { piSessionFile: "", hostTelemetryFile: null, workspaceDir: run.runDir, agentDir: run.runDir },
  };
}

// --- dry run -----------------------------------------------------------------

/**
 * Produce the dry-run plan (no spawning, no network). Renders settings.json with
 * key values redacted and shows the room assignment + directories.
 * @param {import("../types.ts").TrialSpec} spec
 * @param {import("../types.ts").BenchConfig} config
 * @returns {string} a human-readable plan
 */
export function planDryRun(spec, config) {
  const runsRoot = resolveRunsRoot(config);
  const runs = expandRuns(spec, runsRoot);
  const { sharedFp } = buildSharedContext(spec, config);
  const base = spec.room.base || config.platformBase;

  const lines = [];
  lines.push("=== bellows dry run ===");
  lines.push(`trial:      ${spec.trial}`);
  lines.push(`model:      ${spec.model}   thinking=${spec.thinkingLevel}`);
  lines.push(`budget:     ${spec.budget}   protect=${spec.protectTokens}`);
  lines.push(`problems:   ${normalizeProblemsDisplay(spec.problems)}`);
  lines.push(`caps:       cost=$${spec.caps.costUsd}  turns=${spec.caps.turns}  minutes=${spec.caps.minutes}`);
  lines.push(`parallel:   ${spec.parallel || 1}`);
  lines.push(`platform:   ${base}  (apiKeyEnv=${config.platformApiKeyEnv})`);
  const poolStr = (spec.room.pool || []).length ? (spec.room.pool || []).join(", ") : spec.room.create ? "(create on demand)" : "(NONE)";
  lines.push(`rooms:      ${poolStr}  create=${spec.room.create === true}`);
  const longestLabel = runs.reduce((m, r) => Math.max(m, r.label.length), 0);
  if (longestLabel > 64)
    lines.push(`WARNING:    longest run label is ${longestLabel} chars > 64 — the platform clamps ` +
      `labels to 64 chars, which can make sibling runs collide. Shorten the trial name.`);
  lines.push("");
  lines.push("--- shared fingerprint ---");
  lines.push(`  piVersion:             ${sharedFp.piVersion}`);
  lines.push(`  accordionCommit:       ${sharedFp.accordionCommit}`);
  lines.push(`  workspaceTemplateHash: ${sharedFp.workspaceTemplateHash}`);
  lines.push(`  kickoffPromptHash:     ${sharedFp.kickoffPromptHash}`);
  lines.push(`  bellowsVersion:        ${sharedFp.bellowsVersion}`);
  lines.push("");
  lines.push(`--- ${runs.length} runs ---`);

  // Simulate round-robin room assignment for display.
  const pool = (spec.room.pool || []).slice();
  runs.forEach((run, idx) => {
    const room = pool.length ? pool[idx % pool.length] : spec.room.create ? "<created>" : "<none>";
    const agentName = platformAgentName(spec.trial, run.armName, run.seed);
    lines.push(`  [${idx + 1}] ${run.label}`);
    lines.push(`      arm=${run.arm}  seed=${run.seed}  room=${room}  agentName=${agentName}`);
    lines.push(`      runDir=${run.runDir}`);
    lines.push(`      host=${run.arm === "none" ? "(none — raw baseline, no host spawned)" : "spawned"}`);
  });

  // settings.json (redacted) — same for every run of this trial.
  const { provider, modelId } = splitModelSafe(spec.model);
  const settings = {
    defaultProvider: provider,
    defaultModel: modelId,
    defaultThinkingLevel: spec.thinkingLevel,
    compaction: { enabled: false },
    extensions: [path.join(config.accordionRepo, "extension", "accordion.ts").split(path.sep).join("/")],
  };
  lines.push("");
  lines.push("--- agent/settings.json (per run) ---");
  lines.push(indent(JSON.stringify(settings, null, 2), "  "));
  lines.push("");
  lines.push("--- credentials copied into agent/ (values REDACTED) ---");
  lines.push(`  auth.json    <- ${path.join(config.piAgentDir, "auth.json")}   [REDACTED]`);
  lines.push(`  models.json  <- ${path.join(config.piAgentDir, "models.json")} [REDACTED]`);
  lines.push("");
  lines.push("--- workspace client injection (per run) ---");
  lines.push(`  __PLATFORM_BASE__ -> ${base}`);
  lines.push(`  __API_KEY__       -> [REDACTED from $${config.platformApiKeyEnv}]`);
  lines.push("");

  // Example rendered briefing for run 1 (shows label/room wiring).
  if (runs.length) {
    const r0 = runs[0];
    const briefing = renderBriefing({
      roomId: pool.length ? pool[0] : "<ROOM_ID>",
      agentName: platformAgentName(spec.trial, r0.armName, r0.seed),
      runLabel: r0.label,
      problemsText: Array.isArray(spec.problems) ? spec.problems.join(", ") : String(spec.problems),
    });
    lines.push("--- example rendered AGENT_BRIEFING.md (run 1, first ~24 lines) ---");
    lines.push(indent(briefing.split("\n").slice(0, 24).join("\n"), "  "));
  }
  lines.push("");
  lines.push(`kickoff prompt (RPC): ${JSON.stringify(KICKOFF_PROMPT)}`);
  lines.push(`host CLI (per non-"none" arm):`);
  lines.push(
    `  npx vite-node --config vite-node.config.ts src/host/main.ts -- ` +
      `--accordion-home <runDir>/accordion-home --conductor <arm> ` +
      `--budget ${spec.budget} --protect ${spec.protectTokens} --telemetry-out <runDir>/host.jsonl`,
  );
  return lines.join("\n");
}

function normalizeProblemsDisplay(p) {
  return Array.isArray(p) ? p.join(", ") : String(p);
}
/** Human-readable summary of a derived roomConfig, for log lines. */
function describeRoomConfig(roomConfig) {
  if (roomConfig.problem_set) return `problem_set=${roomConfig.problem_set}`;
  if (roomConfig.problems) return `problems=[${roomConfig.problems.join(", ")}]`;
  return "full bench (no problem_set)";
}
function splitModelSafe(model) {
  const idx = model.indexOf(":");
  return idx === -1 ? { provider: model, modelId: "" } : { provider: model.slice(0, idx), modelId: model.slice(idx + 1) };
}
function indent(s, pad) {
  return s
    .split("\n")
    .map((l) => pad + l)
    .join("\n");
}
