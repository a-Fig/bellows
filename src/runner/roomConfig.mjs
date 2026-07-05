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
 */

/** Canonical problem-set preset keys the platform recognizes (case-insensitive). */
const PRESET_KEYS = ["all", "easy", "medium", "hard", "easy-1", "easy-l1", "easy-l2", "easy-l3", "easy-l4"];
const PRESET_SET = new Set(PRESET_KEYS);

/**
 * @param {string | string[] | undefined | null} problems  spec.problems
 * @returns {{ game_type: "slopcode", problem_set?: string, problems?: string[] }}
 */
export function slopcodeRoomConfig(problems) {
  if (Array.isArray(problems)) {
    return { game_type: "slopcode", problems: cleanProblemList(problems) };
  }

  const raw = problems == null ? "" : String(problems).trim();
  if (!raw || raw.toLowerCase() === "all") {
    return { game_type: "slopcode" };
  }

  const lower = raw.toLowerCase();
  if (PRESET_SET.has(lower)) {
    return { game_type: "slopcode", problem_set: lower };
  }

  // Not a preset — treat the string as a single problem name.
  return { game_type: "slopcode", problems: [raw] };
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
