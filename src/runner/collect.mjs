/**
 * Collector — turns raw artifacts into the typed pieces of a RunRecord.
 *
 * Pi session JSONL schema (verified from real sessions under ~/.pi/agent/sessions):
 *   { type:"session", version, id, timestamp, cwd }
 *   { type:"model_change", ... }
 *   { type:"message", id, parentId, timestamp, message:{ role, content, ... } }
 * Assistant messages carry:
 *   message.usage = { input, output, cacheRead, cacheWrite, totalTokens,
 *                     cost:{ input, output, cacheRead, cacheWrite, total },
 *                     rttMs }
 *   rttMs (Accordion issue #58) is the plan round-trip time in ms, stamped by
 *   the accordion extension when the attached host declares itself armed (see
 *   src/host/main.ts). Absent on old sessions / non-accordion runs — never
 *   defaulted to 0, since that would poison the planRtt average with fake
 *   zero-latency turns.
 *   message.stopReason = "toolUse" | "endTurn" | "error" | ...
 *   message.timestamp  = ms epoch
 *   message.content = [ {type:"text"|"thinking"|"toolCall"|...}, ... ]
 *
 * Conforms to src/types.ts (UsageTotals, TurnMetric, ConductorTelemetry, HostEvent).
 */
import fs from "node:fs";
import path from "node:path";

/** Iterate JSON records from a JSONL string, skipping blank/garbage lines. */
export function* parseJsonl(text) {
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      yield JSON.parse(s);
    } catch {
      /* skip malformed line */
    }
  }
}

/**
 * Find the newest pi session .jsonl under an agent dir. pi stores sessions in
 * PI_CODING_AGENT_DIR/sessions/<project-slug>/<ts>_<uuid>.jsonl. We take the
 * most-recently-modified top-level session file (ignores nested task/run subdirs
 * that also end in .jsonl by preferring the shallowest, newest match).
 * @param {string} agentDir  PI_CODING_AGENT_DIR
 * @returns {string | null}
 */
export function findNewestSessionFile(agentDir) {
  const sessRoot = path.join(agentDir, "sessions");
  if (!fs.existsSync(sessRoot)) return null;
  /** @type {{file:string, mtime:number, depth:number}[]} */
  const found = [];
  const walk = (dir, depth) => {
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full, depth + 1);
      else if (ent.isFile() && ent.name.endsWith(".jsonl")) {
        try {
          found.push({ file: full, mtime: fs.statSync(full).mtimeMs, depth });
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(sessRoot, 0);
  if (!found.length) return null;
  // Prefer the newest; if mtimes tie, prefer the shallower path (the root session).
  found.sort((a, b) => b.mtime - a.mtime || a.depth - b.depth);
  return found[0].file;
}

/**
 * Parse a pi session JSONL into UsageTotals + TurnMetric[].
 * @param {string} text  raw JSONL
 * @returns {{ usage: import("../types.ts").UsageTotals, turns: import("../types.ts").TurnMetric[] }}
 */
export function parseSession(text) {
  /** @type {import("../types.ts").TurnMetric[]} */
  const turns = [];
  const totals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    costUsd: 0,
    assistantTurns: 0,
    toolCalls: 0,
  };
  let turnIndex = 0;
  for (const rec of parseJsonl(text)) {
    if (!rec || rec.type !== "message") continue;
    const m = rec.message;
    if (!m || m.role !== "assistant") continue;
    const u = m.usage || {};
    const cost = (u.cost && typeof u.cost === "object" ? u.cost.total : u.cost) || 0;
    const input = n(u.input);
    const output = n(u.output);
    const cacheRead = n(u.cacheRead);
    const cacheWrite = n(u.cacheWrite);
    const costUsd = n(cost);
    const ts = typeof m.timestamp === "number" ? m.timestamp : Date.parse(rec.timestamp) || 0;
    const toolCalls = Array.isArray(m.content)
      ? m.content.filter((c) => c && (c.type === "toolCall" || c.type === "tool_use" || c.type === "tool_call")).length
      : 0;
    // Only present when the accordion extension stamped it (the attached host
    // declared itself armed — see src/host/main.ts) — left out entirely rather
    // than defaulted, so old/non-accordion sessions don't poison the planRtt
    // average with fake 0ms turns. Negative values (clock skew / bad stamps)
    // are also rejected here so they never reach a TurnMetric and drag the
    // aggregate negative.
    const rttMs = isValidRtt(u.rttMs) ? u.rttMs : undefined;

    turns.push({
      turnIndex: turnIndex++,
      timestamp: ts,
      input,
      output,
      cacheRead,
      cacheWrite,
      costUsd,
      stopReason: typeof m.stopReason === "string" ? m.stopReason : "",
      ...(rttMs !== undefined ? { rttMs } : {}),
    });

    totals.input += input;
    totals.output += output;
    totals.cacheRead += cacheRead;
    totals.cacheWrite += cacheWrite;
    totals.totalTokens += n(u.totalTokens) || input + output;
    totals.costUsd += costUsd;
    totals.assistantTurns += 1;
    totals.toolCalls += toolCalls;
  }
  // round cost to avoid fp noise in reports
  totals.costUsd = round6(totals.costUsd);
  return { usage: totals, turns };
}

/** Convenience: read + parse a session file. Returns empty result if missing. */
export function collectSession(sessionFile) {
  if (!sessionFile || !fs.existsSync(sessionFile)) {
    return {
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        costUsd: 0,
        assistantTurns: 0,
        toolCalls: 0,
      },
      turns: [],
    };
  }
  return parseSession(fs.readFileSync(sessionFile, "utf8"));
}

/**
 * Fold a host telemetry JSONL (one HostEvent per line) into ConductorTelemetry.
 * @param {string} text  raw JSONL of HostEvent lines
 * @param {string} fallbackConductorId  used if no attach event is present
 * @returns {import("../types.ts").ConductorTelemetry}
 */
export function foldHostTelemetry(text, fallbackConductorId = "") {
  /** @type {import("../types.ts").HostEvent[]} */
  const events = [];
  for (const rec of parseJsonl(text)) if (rec && typeof rec.t === "string") events.push(rec);

  let conductorId = fallbackConductorId;
  let budget = 0; // established by the attach event; sync events don't carry it
  let syncs = 0;
  let attachCount = 0;
  let plansSent = 0;
  let totalFoldOps = 0;
  let heldPlanReplies = 0;
  let completeCostUsd = 0;
  const latencies = [];
  /** @type {Array<[number,number,number]>} */
  const budgetSeries = [];
  const errors = [];
  const infos = [];

  for (const e of events) {
    switch (e.t) {
      case "attach":
        attachCount++;
        if (e.conductor) conductorId = e.conductor;
        if (Number.isFinite(e.budget)) budget = e.budget;
        break;
      case "sync":
        syncs++;
        // sync events carry liveTokens but not budget; budget comes from attach.
        budgetSeries.push([n(e.at), n(e.liveTokens), budget]);
        break;
      case "conduct":
        if (Number.isFinite(e.latencyMs)) latencies.push(e.latencyMs);
        if (e.heldLastPlan) heldPlanReplies++;
        break;
      case "plan":
        plansSent++;
        totalFoldOps += n(e.ops);
        break;
      case "complete":
        if (typeof e.costUsd === "number") completeCostUsd += e.costUsd;
        break;
      case "error":
        if (e.message) errors.push(String(e.message));
        break;
      case "armed_unacked":
        // Unlike "info", this IS a real degradation (silent 250ms-window fallback) —
        // fold it into errors[] so the report surfaces it exactly like any other
        // integrity failure, not as benign chatter.
        if (e.message) errors.push(String(e.message));
        break;
      case "info":
        // M3: healthy chatty events (greet/status/disconnect) — recorded, but never
        // folded into errors[], so a healthy remote conductor doesn't read as error-laden.
        if (e.message) infos.push(String(e.message));
        break;
      default:
        break;
    }
  }

  return {
    conductorId,
    syncs,
    attachCount,
    plansSent,
    totalFoldOps,
    budgetSeries,
    conductLatencyMs: { p50: percentile(latencies, 50), max: latencies.length ? Math.max(...latencies) : 0 },
    heldPlanReplies,
    completeCostUsd: round6(completeCostUsd),
    errors,
    infos,
  };
}

/** Read + fold host telemetry file. Returns null if absent (conductor "none"). */
export function collectHostTelemetry(hostFile, fallbackConductorId = "") {
  if (!hostFile || !fs.existsSync(hostFile)) return null;
  return foldHostTelemetry(fs.readFileSync(hostFile, "utf8"), fallbackConductorId);
}

/** Attach wireTokens onto turns by matching each turn's timestamp to the
 *  nearest preceding budget-series sample (best-effort enrichment). */
export function enrichTurnsWithWire(turns, telemetry) {
  if (!telemetry || !telemetry.budgetSeries?.length) return turns;
  const series = telemetry.budgetSeries.slice().sort((a, b) => a[0] - b[0]);
  return turns.map((t) => {
    let wire;
    for (const [at, live] of series) {
      if (at <= t.timestamp) wire = live;
      else break;
    }
    return wire === undefined ? t : { ...t, wireTokens: wire };
  });
}

/**
 * Aggregate per-turn plan RTT (Accordion issue #58) into a run-level summary.
 * @param {import("../types.ts").TurnMetric[]} turns
 * @returns {import("../types.ts").PlanRttSummary | null}  null when no turn has rttMs
 */
export function computePlanRtt(turns) {
  const samples = turns.map((t) => t.rttMs).filter(isValidRtt);
  if (!samples.length) return null;
  const avgMs = samples.reduce((a, b) => a + b, 0) / samples.length;
  return {
    avgMs: Math.round(avgMs * 100) / 100,
    maxMs: Math.max(...samples),
    turns: samples.length,
  };
}

// --- numeric helpers ---------------------------------------------------------
function n(v) {
  return Number.isFinite(v) ? v : 0;
}
/** A usable plan-RTT sample: finite and non-negative. Negative rttMs (clock
 *  skew / bad stamps) must never enter a TurnMetric or the planRtt aggregate,
 *  or a single bad sample would silently drag avgMs negative. */
function isValidRtt(v) {
  return Number.isFinite(v) && v >= 0;
}
function round6(v) {
  return Math.round(v * 1e6) / 1e6;
}
export function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = arr.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}
