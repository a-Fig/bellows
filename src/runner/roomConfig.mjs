/**
 * Derives the slopcode room config (game_type + problem_set/problems) from a
 * trial's `spec.problems`. Pure and dependency-free so it is unit-testable
 * without touching the network.
 *
 * The platform buckets its leaderboard by the room's `problem_set` key; a room
 * created with only `{ game_type: "slopcode" }` lands on the generic "Full
 * Bench" bucket regardless of what the trial actually asks the agent to solve.
 * This derives the right room-config shape so the leaderboard bucket matches
 * the trial's `problems`.
 *
 * Every shape also carries `auto_archive: true` — bench-created rooms are
 * disposable (one per run), so the platform archives them at game finalize
 * instead of letting them accumulate against the 20-room casual cap.
 * Leaderboard history is unaffected; only the room's live/casual-cap presence
 * changes. Older platform builds that don't recognize the key simply ignore
 * it, so this is deploy-order safe against the server-side PR that adds
 * support for it.
 */

/** Canonical problem-set preset keys the platform recognizes (case-insensitive). */
const PRESET_KEYS = ["all", "easy", "medium", "hard", "easy-1", "easy-l1", "easy-l2", "easy-l3", "easy-l4"];
const PRESET_SET = new Set(PRESET_KEYS);

/**
 * @param {string | string[] | undefined | null} problems  spec.problems
 * @returns {{ game_type: "slopcode", auto_archive: true, problem_set?: string, problems?: string[] }}
 */
export function slopcodeRoomConfig(problems) {
  if (Array.isArray(problems)) {
    // An ARRAY is always a list of problem NAMES, never presets: `problems:
    // ["easy-1"]` asks the platform for a problem literally named "easy-1"
    // (room create 400s on unknown names). To target a preset bucket, use the
    // bare string form: `problems: easy-1`.
    return { game_type: "slopcode", auto_archive: true, problems: cleanProblemList(problems) };
  }

  const raw = problems == null ? "" : String(problems).trim();
  if (!raw || raw.toLowerCase() === "all") {
    return { game_type: "slopcode", auto_archive: true };
  }

  const lower = raw.toLowerCase();
  if (PRESET_SET.has(lower)) {
    return { game_type: "slopcode", auto_archive: true, problem_set: lower };
  }

  // Not a preset — treat the string as a single problem name.
  return { game_type: "slopcode", auto_archive: true, problems: [raw] };
}

/** Dedupe (exact match), drop empty/whitespace-only entries, throw if nothing's left. */
function cleanProblemList(list) {
  const seen = new Set();
  const cleaned = [];
  for (const entry of list) {
    const s = entry == null ? "" : String(entry).trim();
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    cleaned.push(s);
  }
  if (cleaned.length === 0) {
    throw new Error("slopcodeRoomConfig: problems array is empty after removing blanks/duplicates");
  }
  return cleaned;
}
