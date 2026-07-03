import { describe, it, expect } from "vitest";
import { pickLeaderboardRow, normalizeLabel } from "../platform.mjs";

// Fixture rows mirror the real GET /games/slopcode/leaderboard shape.
const ROW = (over = {}) => ({
  agent_name: "keel_s1",
  attempted: 1,
  checkpoints_attempted: 6,
  checkpoints_solved: 5,
  core_run_score: 0.8333,
  final: true,
  game_id: "g-1",
  label: "t/keel/1",
  room_id: "room-1",
  run_score: 0.75,
  total_problems: 25,
  ts: "Sun, 21 Jun 2026 17:58:34 GMT",
  wall_seconds: 5333,
  ...over,
});

describe("pickLeaderboardRow", () => {
  it("returns null for an empty set", () => {
    expect(pickLeaderboardRow([])).toBeNull();
    expect(pickLeaderboardRow(undefined)).toBeNull();
  });

  it("maps a finalized row to PlatformResult", () => {
    const r = pickLeaderboardRow([ROW()]);
    expect(r).toMatchObject({
      gameId: "g-1",
      roomId: "room-1",
      agentName: "keel_s1",
      runScore: 0.75,
      checkpointsSolved: 5,
      checkpointsAttempted: 6,
    });
    expect(r.raw).toBeTruthy();
  });

  it("prefers a finalized row over a non-final higher score", () => {
    const nonFinalHigh = ROW({ final: false, run_score: 0.99, game_id: "g-nf" });
    const finalLow = ROW({ final: true, run_score: 0.5, game_id: "g-f" });
    const r = pickLeaderboardRow([nonFinalHigh, finalLow]);
    expect(r.gameId).toBe("g-f");
  });

  it("among finalized rows, picks the highest score", () => {
    const a = ROW({ final: true, run_score: 0.4, game_id: "a" });
    const b = ROW({ final: true, run_score: 0.6, game_id: "b" });
    expect(pickLeaderboardRow([a, b]).gameId).toBe("b");
  });

  it("falls back to non-final rows when none finalized", () => {
    const a = ROW({ final: false, run_score: 0.3, game_id: "a" });
    const b = ROW({ final: false, run_score: 0.7, game_id: "b" });
    expect(pickLeaderboardRow([a, b]).gameId).toBe("b");
  });

  it("tolerates a null run_score", () => {
    const r = pickLeaderboardRow([ROW({ run_score: null })]);
    expect(r.runScore).toBeNull();
  });

  it("preserves the full raw row (self_reported, wall_seconds, final, ...)", () => {
    const raw = ROW({ self_reported: { cost_usd: 1.2, turns: 9 }, wall_seconds: 42, problem_set: null, final: false });
    const r = pickLeaderboardRow([raw]);
    expect(r.raw.self_reported).toEqual({ cost_usd: 1.2, turns: 9 });
    expect(r.raw.wall_seconds).toBe(42);
    expect(r.raw.final).toBe(false);
  });
});

describe("normalizeLabel", () => {
  it("trims whitespace", () => {
    expect(normalizeLabel("  t/keel/1  ")).toBe("t/keel/1");
  });
  it("clamps to 64 chars", () => {
    const long = "x".repeat(100);
    expect(normalizeLabel(long).length).toBe(64);
  });
  it("returns empty string for nullish input", () => {
    expect(normalizeLabel(undefined)).toBe("");
    expect(normalizeLabel(null)).toBe("");
  });
});
