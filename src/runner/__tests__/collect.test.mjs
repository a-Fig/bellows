import { describe, it, expect } from "vitest";
import { parseSession, foldHostTelemetry, enrichTurnsWithWire, computePlanRtt } from "../collect.mjs";

// Fixture mirrors the real pi session JSONL schema verified from
// ~/.pi/agent/sessions: message records with message.role, message.usage
// (incl. cost.total), message.stopReason, message.timestamp (ms), and content
// blocks whose type is "toolCall".
const SESSION_FIXTURE = [
  JSON.stringify({ type: "session", version: 3, id: "abc", timestamp: "2026-07-03T09:08:12.809Z", cwd: "/w" }),
  JSON.stringify({ type: "model_change", id: "m1", provider: "token-router", modelId: "deepseek/deepseek-v4-flash" }),
  // user turn (must be ignored by usage/turn accounting)
  JSON.stringify({
    type: "message",
    id: "u1",
    message: { role: "user", content: [{ type: "text", text: "go" }], timestamp: 1000 },
  }),
  // assistant #1: two tool calls
  JSON.stringify({
    type: "message",
    id: "a1",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", text: "..." },
        { type: "toolCall", name: "bash" },
        { type: "toolCall", name: "read" },
      ],
      usage: {
        input: 100,
        output: 20,
        cacheRead: 5,
        cacheWrite: 2,
        totalTokens: 120,
        cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
      },
      stopReason: "toolUse",
      timestamp: 2000,
    },
  }),
  // assistant #2: one tool call
  JSON.stringify({
    type: "message",
    id: "a2",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", name: "write" }],
      usage: {
        input: 200,
        output: 40,
        cacheRead: 10,
        cacheWrite: 0,
        totalTokens: 240,
        cost: { input: 0.002, output: 0.004, cacheRead: 0, cacheWrite: 0, total: 0.006 },
      },
      stopReason: "toolUse",
      timestamp: 3000,
    },
  }),
  // assistant #3: final answer, no tools
  JSON.stringify({
    type: "message",
    id: "a3",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      usage: {
        input: 300,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 310,
        cost: { input: 0.003, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.004 },
      },
      stopReason: "endTurn",
      timestamp: 4000,
    },
  }),
  "", // trailing blank line
  "{ not json", // garbage line — must be skipped
].join("\n");

describe("parseSession", () => {
  const { usage, turns } = parseSession(SESSION_FIXTURE);

  it("counts exactly the assistant turns", () => {
    expect(usage.assistantTurns).toBe(3);
    expect(turns.length).toBe(3);
  });

  it("sums token usage across assistant messages", () => {
    expect(usage.input).toBe(600);
    expect(usage.output).toBe(70);
    expect(usage.cacheRead).toBe(15);
    expect(usage.cacheWrite).toBe(2);
    expect(usage.totalTokens).toBe(670);
  });

  it("sums cost.total across turns", () => {
    expect(usage.costUsd).toBeCloseTo(0.013, 9);
  });

  it("counts tool calls from content blocks", () => {
    expect(usage.toolCalls).toBe(3);
  });

  it("captures per-turn metrics with stopReason + timestamp", () => {
    expect(turns[0]).toMatchObject({ turnIndex: 0, timestamp: 2000, input: 100, output: 20, costUsd: 0.003, stopReason: "toolUse" });
    expect(turns[2].stopReason).toBe("endTurn");
  });

  it("skips user messages and garbage lines", () => {
    // 3 assistant only, not 4 (user) not counting the garbage line
    expect(turns.every((t) => typeof t.timestamp === "number")).toBe(true);
  });

  it("leaves rttMs absent when the session predates Accordion issue #58", () => {
    expect(turns.every((t) => !("rttMs" in t))).toBe(true);
  });

  it("computePlanRtt is null when no turn carries rttMs", () => {
    expect(computePlanRtt(turns)).toBeNull();
  });
});

// Accordion issue #58: the extension stamps message.usage.rttMs (plan
// round-trip ms) on assistant messages when the attached host declares
// itself armed (see src/host/main.ts).
const RTT_SESSION_FIXTURE = [
  JSON.stringify({
    type: "message",
    id: "b1",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "..." }],
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0.001 }, rttMs: 120 },
      stopReason: "toolUse",
      timestamp: 1000,
    },
  }),
  // Present but non-numeric — must not poison the average as a 0.
  JSON.stringify({
    type: "message",
    id: "b2",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "..." }],
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0.001 }, rttMs: "not-a-number" },
      stopReason: "toolUse",
      timestamp: 2000,
    },
  }),
  // No usage.rttMs at all (e.g. steering off mid-session).
  JSON.stringify({
    type: "message",
    id: "b3",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0.001 } },
      stopReason: "endTurn",
      timestamp: 3000,
    },
  }),
  JSON.stringify({
    type: "message",
    id: "b4",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "..." }],
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0.001 }, rttMs: 380 },
      stopReason: "endTurn",
      timestamp: 4000,
    },
  }),
  // Negative rttMs (clock skew / bad stamp) — must be rejected like a
  // non-numeric value, not admitted as a valid (if odd) sample.
  JSON.stringify({
    type: "message",
    id: "b5",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "..." }],
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0.001 }, rttMs: -5 },
      stopReason: "endTurn",
      timestamp: 5000,
    },
  }),
].join("\n");

describe("parseSession — plan RTT (Accordion issue #58)", () => {
  const { turns } = parseSession(RTT_SESSION_FIXTURE);

  it("populates rttMs only on turns with a numeric usage.rttMs", () => {
    expect(turns[0].rttMs).toBe(120);
    expect(turns[1]).not.toHaveProperty("rttMs");
    expect(turns[2]).not.toHaveProperty("rttMs");
    expect(turns[3].rttMs).toBe(380);
  });

  it("rejects a negative rttMs — never admitted onto the TurnMetric", () => {
    expect(turns[4]).not.toHaveProperty("rttMs");
  });

  it("computePlanRtt averages only turns with rttMs, ignoring missing/invalid/negative ones", () => {
    const plan = computePlanRtt(turns);
    expect(plan).toEqual({ avgMs: 250, maxMs: 380, turns: 2 });
  });

  it("computePlanRtt's own filter rejects a negative rttMs even if one reached a TurnMetric directly", () => {
    // Exercises computePlanRtt in isolation (not routed through parseSession),
    // so its own predicate — not just parseSession's — is under test.
    const plan = computePlanRtt([{ rttMs: 100 }, { rttMs: -5 }, { rttMs: 200 }]);
    expect(plan).toEqual({ avgMs: 150, maxMs: 200, turns: 2 });
  });
});

const HOST_FIXTURE = [
  { t: "attach", at: 100, sessionId: "s", conductor: "keel", budget: 70000, protectTokens: 20000 },
  { t: "sync", at: 200, rev: 1, blocks: 10, liveTokens: 50000, foldedBlocks: 0 },
  { t: "conduct", at: 210, rev: 1, latencyMs: 12, commands: 3, heldLastPlan: false },
  { t: "plan", at: 220, rev: 1, ops: 4, groups: 1 },
  { t: "sync", at: 300, rev: 2, blocks: 12, liveTokens: 65000, foldedBlocks: 2 },
  { t: "conduct", at: 305, rev: 2, latencyMs: 40, commands: 2, heldLastPlan: true },
  { t: "plan", at: 310, rev: 2, ops: 2, groups: 0 },
  { t: "complete", at: 320, costUsd: 0.05, latencyMs: 900 },
  { t: "error", at: 330, message: "flaky ws" },
]
  .map((e) => JSON.stringify(e))
  .join("\n");

describe("foldHostTelemetry", () => {
  const tel = foldHostTelemetry(HOST_FIXTURE, "fallback");

  it("takes conductorId from the attach event", () => {
    expect(tel.conductorId).toBe("keel");
  });
  it("counts syncs, plans, fold ops", () => {
    expect(tel.syncs).toBe(2);
    expect(tel.plansSent).toBe(2);
    expect(tel.totalFoldOps).toBe(6);
  });
  it("counts attach events", () => {
    expect(tel.attachCount).toBe(1);
  });
  it("builds a budget series from sync events", () => {
    expect(tel.budgetSeries).toEqual([
      [200, 50000, 70000],
      [300, 65000, 70000],
    ]);
  });
  it("computes conduct latency p50/max", () => {
    expect(tel.conductLatencyMs.max).toBe(40);
    expect(tel.conductLatencyMs.p50).toBeGreaterThan(0);
  });
  it("counts held-plan replies and complete cost + errors", () => {
    expect(tel.heldPlanReplies).toBe(1);
    expect(tel.completeCostUsd).toBeCloseTo(0.05, 9);
    expect(tel.errors).toEqual(["flaky ws"]);
  });
  it("falls back to the supplied conductor id when no attach event", () => {
    const t2 = foldHostTelemetry(JSON.stringify({ t: "sync", at: 1, liveTokens: 1, budget: 2 }), "cold-score");
    expect(t2.conductorId).toBe("cold-score");
  });
});

// Issue #14: a host that dies during attach (e.g. "unknown conductor") writes only an
// error event — never attach/sync. foldHostTelemetry must surface that as attachCount:0,
// syncs:0, with the error preserved, so the runner's integrity guard can detect it.
const UNKNOWN_CONDUCTOR_FIXTURE = [{ t: "error", at: 50, message: 'unknown conductor "zzz" (available: builtin, keel)' }]
  .map((e) => JSON.stringify(e))
  .join("\n");

describe("foldHostTelemetry — conductor never attached (issue #14)", () => {
  const tel = foldHostTelemetry(UNKNOWN_CONDUCTOR_FIXTURE, "zzz");

  it("reports zero attach and zero sync events", () => {
    expect(tel.attachCount).toBe(0);
    expect(tel.syncs).toBe(0);
  });
  it("preserves the single error", () => {
    expect(tel.errors.length).toBe(1);
    expect(tel.errors[0]).toMatch(/unknown conductor/);
  });
  it("falls back to the supplied conductor id since no attach event set it", () => {
    expect(tel.conductorId).toBe("zzz");
  });
});

describe("enrichTurnsWithWire", () => {
  it("attaches nearest preceding budget sample as wireTokens", () => {
    // Turns at ts=2500 and ts=3500; samples at 2000 (50k) and 3000 (65k).
    const turns = [
      { turnIndex: 0, timestamp: 2500, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, stopReason: "" },
      { turnIndex: 1, timestamp: 3500, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, stopReason: "" },
    ];
    const tel = {
      budgetSeries: [
        [2000, 50000, 70000],
        [3000, 65000, 70000],
      ],
    };
    const enriched = enrichTurnsWithWire(turns, tel);
    expect(enriched[0].wireTokens).toBe(50000); // ts=2500 -> sample at 2000
    expect(enriched[1].wireTokens).toBe(65000); // ts=3500 -> sample at 3000
  });
  it("no-ops without telemetry", () => {
    const { turns } = parseSession(SESSION_FIXTURE);
    expect(enrichTurnsWithWire(turns, null)).toBe(turns);
  });
});
