import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, writeFile, rm, readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import generateReport from "./index.mjs";
import { aggregateGroup, isAborted, scorelessKind } from "./aggregate.mjs";

const SHARED_FP = {
  model: "token-router:deepseek/deepseek-v4-flash",
  thinkingLevel: "medium",
  budget: 40000,
  protectTokens: 20000,
  problems: "easy-1",
  workspaceTemplateHash: "wsHASHabc",
  kickoffPromptHash: "kickoffHASH123",
  piVersion: "1.2.3",
  accordionCommit: "deadbeef",
  bellowsVersion: "0.1.0",
};

function makeRun({
  id,
  conductorId,
  seed,
  status = "completed",
  statusDetail,
  platform = { gameId: "slopcode", roomId: "room1", agentName: "agent1", runScore: 10, checkpointsSolved: 3, checkpointsAttempted: 5, raw: {} },
  fingerprintOverrides = {},
  costUsd = 0.42,
  totalTokens = 12345,
  wallClockS = 300,
}) {
  return {
    id,
    label: id,
    status,
    statusDetail,
    fingerprint: { ...SHARED_FP, conductorId, ...fingerprintOverrides },
    timing: { startedAt: "2026-07-01T00:00:00.000Z", endedAt: "2026-07-01T00:05:00.000Z", wallClockS },
    usage: {
      input: 1000,
      output: 500,
      cacheRead: 8000,
      cacheWrite: 400,
      totalTokens,
      costUsd,
      assistantTurns: 4,
      toolCalls: 6,
    },
    turns: [
      { turnIndex: 0, timestamp: 1000, input: 100, output: 50, cacheRead: 0, cacheWrite: 0, costUsd: 0.01, stopReason: "tool_use", wireTokens: 500 },
      { turnIndex: 1, timestamp: 2000, input: 200, output: 80, cacheRead: 4000, cacheWrite: 0, costUsd: 0.15, stopReason: "tool_use", wireTokens: 4800 },
      { turnIndex: 2, timestamp: 3000, input: 150, output: 60, cacheRead: 4000, cacheWrite: 400, costUsd: 0.26, stopReason: "end_turn", wireTokens: 8600 },
    ],
    conductor:
      conductorId === "none"
        ? null
        : {
            conductorId,
            syncs: 12,
            plansSent: 5,
            totalFoldOps: 9,
            budgetSeries: [
              [1000, 1000, 40000],
              [2000, 15000, 40000],
              [3000, 32000, 40000],
            ],
            conductLatencyMs: { p50: 12, max: 40 },
            heldPlanReplies: 1,
            completeCostUsd: 0.02,
            errors: [],
          },
    platform,
    artifacts: {
      piSessionFile: `runs/example/${id}/pi-session.jsonl`,
      hostTelemetryFile: conductorId === "none" ? null : `runs/example/${id}/host-telemetry.jsonl`,
      workspaceDir: `runs/example/${id}/workspace`,
      agentDir: `runs/example/${id}/agent`,
    },
  };
}

describe("generateReport", () => {
  let dir;
  let runsDir;
  let outFile;
  let html;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "bellows-report-test-"));
    runsDir = path.join(dir, "runs");
    outFile = path.join(dir, "out", "report.html");
    await mkdir(path.join(runsDir, "example"), { recursive: true });

    // Two conductors x 2 seeds, sharing a fingerprint (same group).
    const groupRuns = [
      makeRun({ id: "example/builtin/1", conductorId: "builtin", seed: 1, platform: { gameId: "slopcode", roomId: "r1", agentName: "a", runScore: 10, checkpointsSolved: 3, checkpointsAttempted: 5, raw: {} }, costUsd: 0.5 }),
      makeRun({ id: "example/builtin/2", conductorId: "builtin", seed: 2, platform: { gameId: "slopcode", roomId: "r2", agentName: "a", runScore: 12, checkpointsSolved: 4, checkpointsAttempted: 5, raw: {} }, costUsd: 0.6 }),
      makeRun({ id: "example/keel/1", conductorId: "keel", seed: 1, platform: { gameId: "slopcode", roomId: "r3", agentName: "a", runScore: 14, checkpointsSolved: 5, checkpointsAttempted: 5, raw: {} }, costUsd: 0.3 }),
      makeRun({ id: "example/keel/2", conductorId: "keel", seed: 2, platform: { gameId: "slopcode", roomId: "r4", agentName: "a", runScore: 13, checkpointsSolved: 4, checkpointsAttempted: 5, raw: {} }, costUsd: 0.35 }),
    ];

    // Mismatched run: differs from the shared fingerprint on exactly one
    // hard field (budget) so it must NOT join the group above, and must
    // show up as a near-miss with "budget" named as the differing field.
    const mismatchedRun = makeRun({
      id: "example/builtin-bigbudget/1",
      conductorId: "builtin",
      seed: 1,
      fingerprintOverrides: { budget: 80000 },
      platform: { gameId: "slopcode", roomId: "r5", agentName: "a", runScore: 9, checkpointsSolved: 2, checkpointsAttempted: 5, raw: {} },
    });

    // Aborted run: platform: null -> harness telemetry only, excluded from
    // score aggregates but included in cost/token aggregates.
    const abortedRun = makeRun({
      id: "example/builtin/3",
      conductorId: "builtin",
      seed: 3,
      status: "aborted-cost",
      statusDetail: "hit $2.00 cost cap",
      platform: null,
      costUsd: 2.0,
    });

    // Errored run WITH a platform row (issue #14): the conductor never
    // attached but the agent still played unmanaged and finalized, so a
    // harvested leaderboard row exists. It must be excluded from score
    // aggregates and labeled, not silently counted under "keel".
    const erroredRun = makeRun({
      id: "example/keel/3",
      conductorId: "keel",
      seed: 3,
      status: "error",
      statusDetail: 'conductor "keel" never attached (0 attach / 0 sync; unknown conductor "keel")',
      platform: { gameId: "slopcode", roomId: "r6", agentName: "a", runScore: 20, checkpointsSolved: 5, checkpointsAttempted: 5, raw: {} },
    });

    for (const run of [...groupRuns, mismatchedRun, abortedRun, erroredRun]) {
      const safeName = run.id.replace(/\//g, "_");
      await writeFile(path.join(runsDir, "example", `${safeName}.json`), JSON.stringify(run, null, 2), "utf8");
    }

    // Junk files the loader must tolerate.
    await writeFile(path.join(runsDir, "example", "not-json.json"), "{ this is not valid json", "utf8");
    await writeFile(path.join(runsDir, "example", "empty.json"), "", "utf8");
    await writeFile(path.join(runsDir, "example", "unrelated.json"), JSON.stringify({ hello: "world" }), "utf8");
    await writeFile(path.join(runsDir, "example", "readme.txt"), "not a json file, ignored by extension", "utf8");

    await generateReport(runsDir, outFile);
    html = await readFile(outFile, "utf8");
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes an html file", () => {
    expect(html.length).toBeGreaterThan(0);
    expect(html.startsWith("<!doctype html>")).toBe(true);
  });

  it("contains the group comparison table with both conductors", () => {
    expect(html).toContain("Comparison group 1");
    expect(html).toContain("builtin");
    expect(html).toContain("keel");
    // aggregate table headers
    expect(html).toContain("median checkpoints solved");
    expect(html).toContain("median cost");
  });

  it("names the differing field in the mismatch warning", () => {
    expect(html).toContain("Fingerprint mismatch guard");
    expect(html).toContain("budget");
    // Should not claim zero mismatches when we planted one.
    expect(html).not.toContain("No near-miss groups detected");
  });

  it("does not place the mismatched run's group in the same group as the main group", () => {
    // There should be 2 groups: the shared-fingerprint group (4 runs) and
    // the mismatched budget=80000 group (1 run) containing the aborted run
    // separately would be a 3rd, but aborted run shares the main fingerprint
    // so it belongs to group 1. So we expect at least 2 groups total.
    const groupHeadingMatches = html.match(/Comparison group \d+/g) ?? [];
    expect(groupHeadingMatches.length).toBeGreaterThanOrEqual(2);
  });

  it("flags the aborted run as harness telemetry only and excludes it from score data", () => {
    expect(html).toContain("harness telemetry only");
    expect(html).toContain("no platform score");
    expect(html).toContain("example/builtin/3");
    expect(html).toContain("aborted-cost");
  });

  it("labels the errored run's withheld platform row instead of scoring it (issue #14)", () => {
    expect(html).toContain("example/keel/3");
    expect(html).toContain("errored — excluded from score aggregates");
    expect(html).toContain("withheld platform row");
  });

  it("reports skipped junk files without throwing", () => {
    expect(html).toContain("skipped while loading runs");
  });

  it("produces well-balanced top-level structure (open-check)", () => {
    const tagStack = [];
    const voidTags = new Set(["meta", "br", "hr", "img", "input", "link"]);
    const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/?)>/g;
    let match;
    let bodyOpen = 0;
    let htmlOpen = 0;
    while ((match = tagRe.exec(html))) {
      const [, closing, tagName, selfClosing] = match;
      const tag = tagName.toLowerCase();
      if (tag === "!doctype") continue;
      if (selfClosing || voidTags.has(tag)) continue;
      if (tag === "html") {
        htmlOpen += closing ? -1 : 1;
        continue;
      }
      if (tag === "body") {
        bodyOpen += closing ? -1 : 1;
        continue;
      }
      if (!closing) {
        tagStack.push(tag);
      } else {
        // pop back to the matching tag (tolerant of minor irregularities,
        // but the stack must fully resolve by the end)
        let idx = tagStack.length - 1;
        while (idx >= 0 && tagStack[idx] !== tag) idx--;
        expect(idx).toBeGreaterThanOrEqual(0);
        tagStack.length = idx;
      }
    }
    expect(tagStack).toEqual([]);
    expect(htmlOpen).toBe(0);
    expect(bodyOpen).toBe(0);
  });

  it("contains no external network references (script/link src/href to http)", () => {
    expect(html).not.toMatch(/<script[^>]+src=["']https?:/i);
    expect(html).not.toMatch(/<link[^>]+href=["']https?:/i);
    expect(html).not.toMatch(/@import\s+url\(["']?https?:/i);
  });

  it("handles a missing runs directory without throwing", async () => {
    const goneDir = path.join(dir, "does-not-exist");
    const outFile2 = path.join(dir, "out2", "report.html");
    await expect(generateReport(goneDir, outFile2)).resolves.toBeUndefined();
    const html2 = await readFile(outFile2, "utf8");
    expect(html2).toContain("No comparable runs found");
  });
});

// Issue #14 follow-through: forcing status="error" in the runner is only half
// the fix — the aggregator must actually treat errored runs as scoreless, even
// when they carry a harvested platform row (agent played unmanaged and
// finalized before the integrity guard fired).
describe("score exclusion of errored runs (issue #14)", () => {
  const platformRow = { gameId: "slopcode", roomId: "r9", agentName: "a", runScore: 20, checkpointsSolved: 5, checkpointsAttempted: 5, raw: {} };

  it("isAborted treats an errored run as scoreless even with a platform row", () => {
    expect(isAborted({ platform: platformRow, status: "error" })).toBe(true);
    expect(isAborted({ platform: platformRow, status: "completed" })).toBe(false);
    expect(isAborted({ platform: null, status: "aborted-cost" })).toBe(true);
  });

  it("scorelessKind distinguishes errored / harvest-failed / aborted / scored", () => {
    expect(scorelessKind({ platform: platformRow, status: "error" })).toBe("errored");
    expect(scorelessKind({ platform: null, status: "error" })).toBe("errored");
    expect(scorelessKind({ platform: null, status: "completed" })).toBe("harvest-failed");
    expect(scorelessKind({ platform: null, status: "aborted-cost" })).toBe("aborted");
    expect(scorelessKind({ platform: platformRow, status: "completed" })).toBe(null);
  });

  it("aggregateGroup keeps an errored run's platform row out of checkpoint medians", () => {
    const runs = [
      makeRun({ id: "x/keel/1", conductorId: "keel", seed: 1, platform: { ...platformRow, checkpointsSolved: 3 } }),
      makeRun({ id: "x/keel/2", conductorId: "keel", seed: 2, platform: { ...platformRow, checkpointsSolved: 4 } }),
      makeRun({ id: "x/keel/3", conductorId: "keel", seed: 3, status: "error", platform: { ...platformRow, checkpointsSolved: 5 } }),
    ];
    const [row] = aggregateGroup({ runs });
    expect(row.scoredCount).toBe(2);
    expect(row.abortedCount).toBe(1);
    // Median of [3, 4] — 3.5. Were the errored run's row counted, this would be 4.
    expect(row.checkpointsSolved).toBe(3.5);
  });
});
