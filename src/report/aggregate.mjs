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
 * Stable, order-independent string key for an arm's env overrides
 * (fingerprint.env). Two arms sharing a conductorId but differing on env are
 * a real, deliberate A/B condition (e.g. `compaction-naive` vs a
 * `compaction-naive` arm with `ACCORDION_SUMMARY_TRIGGER: "0.75"`) — this key
 * is what lets aggregateGroup tell them apart instead of pooling their runs
 * into one row (2026-09-29 Fable review, bellows #37 blocking follow-up).
 * Built with JSON.stringify over the sorted [key, value] entries rather than
 * a hand-joined string (bellows #39 follow-up, 2026-09-30 Fable re-review of
 * #44): a "\u0001"-joined string was ambiguous if a value ever legitimately
 * CONTAINED a literal "\u0001" — validateArmEnv (config.mjs) only checks env
 * value type/length, not its character set, so a platform-submitted value
 * with that byte in it could alias two genuinely different arms into the
 * same bucket. JSON.stringify of a [key, value] pair array has no such
 * collision (each entry is individually length-prefixed by JSON's own
 * quoting/escaping), whatever bytes the value contains.
 * Empty/absent env -> "" so the common no-overrides case is a stable key.
 */
export function envKeyOf(run) {
  const env = run.fingerprint?.env;
  const keys = env && typeof env === "object" ? Object.keys(env) : [];
  if (keys.length === 0) return "";
  return JSON.stringify(keys.sort().map((k) => [k, env[k]]));
}

/** Human-readable rendering of an arm's env overrides, e.g. "FOO=1, BAR=2". Empty string when there are none. */
export function envLabelOf(run) {
  const env = run.fingerprint?.env;
  if (!env || typeof env !== "object") return "";
  return Object.keys(env)
    .sort()
    .map((k) => `${k}=${env[k]}`)
    .join(", ");
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
  // Bucket by conductorId AND env together (not conductorId alone): two arms
  // that dispatch the same conductor with different env overrides are a
  // deliberate A/B comparison, not the same condition (bellows #37 blocking
  // follow-up — see envKeyOf).
  const byConductor = new Map();
  for (const run of group.runs) {
    const cid = conductorOf(run);
    const armKey = `${cid}\u0000${envKeyOf(run)}`;
    if (!byConductor.has(armKey)) byConductor.set(armKey, { armKey, conductorId: cid, runs: [] });
    byConductor.get(armKey).runs.push(run);
  }

  const rows = [];
  for (const { armKey, conductorId, runs } of byConductor.values()) {
    const envLabel = envLabelOf(runs[0]);
    const scored = runs.filter((r) => !isAborted(r));
    const completed = runs.filter((r) => r.status === "completed");

    const checkpointsSolved = median(scored.map((r) => r.platform.checkpointsSolved));
    const checkpointsAttempted = median(scored.map((r) => r.platform.checkpointsAttempted));
    const costUsd = median(runs.map((r) => r.usage?.costUsd));
    // Conductor (compaction/summary) spend, separate from the agent spend above
    // — previously absent from aggregates entirely (2026-09-29 Fable review,
    // bellows #38 follow-up item 2: "agent $0.276 + conductor $0.162 -> report
    // understates the arm by ~37%"). null for runs with no conductor at all
    // (arm "none"), so it's excluded from the median rather than counted as 0 —
    // same "don't let absence look like zero" reasoning as planRttMs below.
    const conductorCostUsd = median(runs.map((r) => (r.conductor ? r.conductor.completeCostUsd : null)));
    // Combined agent+conductor spend, computed PER RUN then medianed — not
    // median(agent) + median(conductor), which would silently mismatch on an
    // uneven runs-with-conductor-data split. Falls back to just the agent cost
    // for a run with no conductor telemetry (arm "none", or a run that
    // predates conductor cost collection) rather than dropping it from the
    // median entirely, since the agent portion is still real spend.
    //
    // r.conductor.completeCostUsd must be type-guarded, not just truthiness-
    // checked on r.conductor (bellows #39 follow-up, 2026-09-30 Fable
    // re-review of #44): a pre-#38 RunRecord can have a truthy `r.conductor`
    // whose completeCostUsd is `undefined` (the field didn't exist yet), and
    // `0 + undefined === NaN`. median() silently drops non-finite entries, so
    // that run's combined-cost contribution vanished from the aggregate
    // entirely instead of falling back to its agent-only cost like every
    // other conductor-less/pre-#38 run does.
    const combinedCostUsd = median(
      runs.map((r) => {
        const agent = typeof r.usage?.costUsd === "number" ? r.usage.costUsd : 0;
        const conductor = typeof r.conductor?.completeCostUsd === "number" ? r.conductor.completeCostUsd : 0;
        return agent + conductor;
      }),
    );
    // How many runs in this bucket had at least one conductor completion whose
    // price came back unknown (null) rather than a real number — the report
    // flags this so a conductorCostUsd of e.g. $0.00 isn't misread as "this
    // conductor is free" when it's really "some of its provider's completions
    // aren't priced" (bellows #38 follow-up item 3).
    const conductorCostUnknownRuns = runs.filter((r) => (r.conductor?.completeCostUnknownCount ?? 0) > 0).length;
    const conductorCostUnknownProviders = [...new Set(runs.flatMap((r) => r.conductor?.completeCostUnknownProviders ?? []))].sort();
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
      armKey,
      conductorId,
      envLabel,
      runsCount: runs.length,
      scoredCount: scored.length,
      abortedCount: runs.length - scored.length,
      completionRate: runs.length > 0 ? completed.length / runs.length : null,
      checkpointsSolved,
      checkpointsAttempted,
      costUsd,
      conductorCostUsd,
      combinedCostUsd,
      conductorCostUnknownRuns,
      conductorCostUnknownProviders,
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
