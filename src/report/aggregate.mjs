/**
 * Aggregation of runs within a comparison group, bucketed per conductor.
 */

export function median(nums) {
  const xs = nums.filter((n) => typeof n === "number" && Number.isFinite(n)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 === 0 ? (xs[mid - 1] + xs[mid]) / 2 : xs[mid];
}

/** Conductor id a run belongs to — from fingerprint.conductorId. */
export function conductorOf(run) {
  return run.fingerprint?.conductorId ?? "unknown";
}

/**
 * A run that can't contribute score data. Two ways in: no platform row at all
 * (cap-aborted runs, or completed runs whose leaderboard harvest failed —
 * platform outage), or status "error" — per RunStatus semantics an errored run
 * produced nothing gradeable, so any platform row it carries must not be
 * attributed to the conductor. The latter matters for issue #14: a run whose
 * conductor never attached can still hold a finalized platform row (the agent
 * played unmanaged), and that row must not enter this conductor's aggregates.
 * Render labels the cases via `scorelessKind`; all are excluded from
 * checkpoint aggregates.
 */
export const isAborted = (run) => run.platform === null || run.status === "error";

/** Why a run has no score: "errored" | "aborted" | "harvest-failed" | null (has a score). */
export const scorelessKind = (run) => {
  if (run.status === "error") return "errored";
  if (run.platform !== null) return null;
  return run.status === "completed" ? "harvest-failed" : "aborted";
};

/**
 * Aggregate a group's runs into one row per conductor.
 * Score aggregates (checkpoints solved/attempted) only consider runs with
 * a non-null platform result; cost/token/wallclock aggregates include all
 * runs, including aborted ones ("harness telemetry only").
 */
export function aggregateGroup(group) {
  const byConductor = new Map();
  for (const run of group.runs) {
    const cid = conductorOf(run);
    if (!byConductor.has(cid)) byConductor.set(cid, []);
    byConductor.get(cid).push(run);
  }

  const rows = [];
  for (const [conductorId, runs] of byConductor) {
    const scored = runs.filter((r) => !isAborted(r));
    const completed = runs.filter((r) => r.status === "completed");

    const checkpointsSolved = median(scored.map((r) => r.platform.checkpointsSolved));
    const checkpointsAttempted = median(scored.map((r) => r.platform.checkpointsAttempted));
    const costUsd = median(runs.map((r) => r.usage?.costUsd));
    const totalTokens = median(runs.map((r) => r.usage?.totalTokens));
    const wallClockS = median(runs.map((r) => r.timing?.wallClockS));
    // Accordion issue #58: null on runs/groups predating plan-RTT collection —
    // median() already drops non-numeric entries, so this is null only when
    // no run in the group has planRtt.
    const planRttMs = median(runs.map((r) => r.planRtt?.avgMs));

    const cacheShares = runs
      .map((r) => {
        const u = r.usage;
        if (!u) return null;
        const denom = u.input + u.cacheRead + u.cacheWrite;
        return denom > 0 ? u.cacheRead / denom : null;
      })
      .filter((v) => v !== null);
    const cacheReadShare = median(cacheShares);

    rows.push({
      conductorId,
      runsCount: runs.length,
      scoredCount: scored.length,
      abortedCount: runs.length - scored.length,
      completionRate: runs.length > 0 ? completed.length / runs.length : null,
      checkpointsSolved,
      checkpointsAttempted,
      costUsd,
      totalTokens,
      wallClockS,
      cacheReadShare,
      planRttMs,
      runs,
    });
  }

  // Winner-ish ordering: checkpoints solved desc, then cost asc (nulls last).
  rows.sort((a, b) => {
    const as = a.checkpointsSolved ?? -Infinity;
    const bs = b.checkpointsSolved ?? -Infinity;
    if (bs !== as) return bs - as;
    const ac = a.costUsd ?? Infinity;
    const bc = b.costUsd ?? Infinity;
    return ac - bc;
  });

  return rows;
}
