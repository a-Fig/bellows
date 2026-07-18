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
  const { usage, turns, terminalError } = parseSession(SESSION_FIXTURE);

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

  it("does not report a terminal error after a normal final assistant message", () => {
    expect(terminalError).toBeUndefined();
  });

  it("returns the error message when the last assistant response failed", () => {
    const failed = [
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: [], stopReason: "error", errorMessage: "400: bad history" },
      }),
    ].join("\n");
    expect(parseSession(failed).terminalError).toBe("400: bad history");
  });

  it("clears an earlier retryable error when a later assistant response succeeds", () => {
    const recovered = [
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: [], stopReason: "error", errorMessage: "temporary" },
      }),
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "endTurn" },
      }),
    ].join("\n");
    expect(parseSession(recovered).terminalError).toBeUndefined();
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
  it("planOutcomes is null when no passthrough/meta_snapshot events were ever recorded", () => {
    expect(tel.planOutcomes).toBeNull();
  });
});

// Accordion issue #60/#22 (ADR 0020): plan-outcome observability. foldHostTelemetry folds
// two independent sources — the WS `passthrough` ack tally and the `/__accordion/meta`
// start/end snapshot diff — into one canonical `planOutcomes`, preferring the meta diff.
describe("foldHostTelemetry — planOutcomes (Accordion issue #60/#22, ADR 0020)", () => {
  it("uses the WS ack tally when no meta snapshot was ever taken", () => {
    const fixture = [
      { t: "attach", at: 100, sessionId: "s", conductor: "keel", budget: 70000, protectTokens: 20000 },
      { t: "passthrough", at: 200, reqId: 1, cause: "applied", ops: 4, groups: 1, recalls: 0 },
      { t: "passthrough", at: 300, reqId: 2, cause: "applied", ops: 2, groups: 0, recalls: 0 },
      { t: "passthrough", at: 400, reqId: 3, cause: "empty-plan", ops: 0, groups: 0, recalls: 0 },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n");
    const tel = foldHostTelemetry(fixture, "keel");
    expect(tel.planOutcomes).toEqual({ applied: 2, "empty-plan": 1, total: 3 });
  });

  it("prefers the /__accordion/meta start/end snapshot diff when both are present and non-negative", () => {
    const fixture = [
      { t: "attach", at: 100, sessionId: "s", conductor: "keel", budget: 70000, protectTokens: 20000 },
      {
        t: "meta_snapshot",
        at: 105,
        when: "start",
        planOutcomes: { applied: 10, "empty-plan": 2, "timeout-stale": 0, "timeout-raw": 0, "no-gui": 5, "epoch-mismatch": 0, unsent: 0, total: 17 },
      },
      { t: "passthrough", at: 200, reqId: 1, cause: "applied", ops: 4, groups: 1, recalls: 0 },
      {
        t: "meta_snapshot",
        at: 500,
        when: "end",
        planOutcomes: { applied: 11, "empty-plan": 2, "timeout-stale": 0, "timeout-raw": 0, "no-gui": 7, "epoch-mismatch": 0, unsent: 0, total: 20 },
      },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n");
    const tel = foldHostTelemetry(fixture, "keel");
    // Diff: applied +1, no-gui +2 (never acked over WS — only observable via meta), total +3.
    expect(tel.planOutcomes).toEqual({ applied: 1, "empty-plan": 0, "timeout-stale": 0, "timeout-raw": 0, "no-gui": 2, "epoch-mismatch": 0, unsent: 0, total: 3 });
    // No mismatch note: the WS tally (applied:1) and the meta diff (applied:1) agree on every
    // ackable cause, so infos must stay empty.
    expect(tel.infos).toEqual([]);
  });

  it("appends a mismatch note when the WS tally and meta diff disagree on an ackable cause, but still uses the meta diff", () => {
    const fixture = [
      { t: "attach", at: 100, sessionId: "s", conductor: "keel", budget: 70000, protectTokens: 20000 },
      {
        t: "meta_snapshot",
        at: 105,
        when: "start",
        planOutcomes: { applied: 0, "empty-plan": 0, "timeout-stale": 0, "timeout-raw": 0, "no-gui": 0, "epoch-mismatch": 0, unsent: 0, total: 0 },
      },
      // Only ONE passthrough ack rode the WS (e.g. a dropped ack), but the extension's own
      // lifetime counters show TWO applied outcomes actually happened.
      { t: "passthrough", at: 200, reqId: 1, cause: "applied", ops: 4, groups: 1, recalls: 0 },
      {
        t: "meta_snapshot",
        at: 500,
        when: "end",
        planOutcomes: { applied: 2, "empty-plan": 0, "timeout-stale": 0, "timeout-raw": 0, "no-gui": 0, "epoch-mismatch": 0, unsent: 0, total: 2 },
      },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n");
    const tel = foldHostTelemetry(fixture, "keel");
    // The meta diff still wins even though it disagrees with the WS tally.
    expect(tel.planOutcomes.applied).toBe(2);
    expect(tel.planOutcomes.total).toBe(2);
    expect(tel.infos.length).toBe(1);
    expect(tel.infos[0]).toMatch(/mismatch/);
    expect(tel.infos[0]).toMatch(/applied/);
  });

  it("falls back to the WS tally when the meta diff has a negative value (extension restarted mid-run)", () => {
    const fixture = [
      { t: "attach", at: 100, sessionId: "s", conductor: "keel", budget: 70000, protectTokens: 20000 },
      {
        t: "meta_snapshot",
        at: 105,
        when: "start",
        planOutcomes: { applied: 50, "empty-plan": 0, "timeout-stale": 0, "timeout-raw": 0, "no-gui": 0, "epoch-mismatch": 0, unsent: 0, total: 50 },
      },
      { t: "passthrough", at: 200, reqId: 1, cause: "applied", ops: 1, groups: 0, recalls: 0 },
      // Extension restarted: its lifetime counters reset lower than the start snapshot.
      {
        t: "meta_snapshot",
        at: 500,
        when: "end",
        planOutcomes: { applied: 1, "empty-plan": 0, "timeout-stale": 0, "timeout-raw": 0, "no-gui": 0, "epoch-mismatch": 0, unsent: 0, total: 1 },
      },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n");
    const tel = foldHostTelemetry(fixture, "keel");
    expect(tel.planOutcomes).toEqual({ applied: 1, total: 1 });
    expect(tel.infos.some((m) => /negative/.test(m))).toBe(true);
  });

  it("is null when neither a passthrough ack nor a meta snapshot ever arrived", () => {
    const fixture = [{ t: "attach", at: 100, sessionId: "s", conductor: "keel", budget: 70000, protectTokens: 20000 }]
      .map((e) => JSON.stringify(e))
      .join("\n");
    const tel = foldHostTelemetry(fixture, "keel");
    expect(tel.planOutcomes).toBeNull();
  });

  it("falls back to the WS tally when only ONE of the two meta snapshots exists", () => {
    const fixture = [
      { t: "attach", at: 100, sessionId: "s", conductor: "keel", budget: 70000, protectTokens: 20000 },
      {
        t: "meta_snapshot",
        at: 105,
        when: "start",
        planOutcomes: { applied: 5, "empty-plan": 0, "timeout-stale": 0, "timeout-raw": 0, "no-gui": 0, "epoch-mismatch": 0, unsent: 0, total: 5 },
      },
      { t: "passthrough", at: 200, reqId: 1, cause: "applied", ops: 1, groups: 0, recalls: 0 },
      // No "end" snapshot — e.g. the extension was unreachable at shutdown.
    ]
      .map((e) => JSON.stringify(e))
      .join("\n");
    const tel = foldHostTelemetry(fixture, "keel");
    expect(tel.planOutcomes).toEqual({ applied: 1, total: 1 });
  });

  it("whitelists diff keys: an unknown key from the untrusted meta endpoint neither leaks nor trips the negative-diff fallback", () => {
    const fixture = [
      { t: "attach", at: 100, sessionId: "s", conductor: "keel", budget: 70000, protectTokens: 20000 },
      {
        t: "meta_snapshot",
        at: 105,
        when: "start",
        // `bogus` decreases end-vs-start (99 -> 0) — without the whitelist that would
        // falsely read as an extension restart and discard a perfectly good diff.
        planOutcomes: { applied: 1, total: 1, bogus: 99 },
      },
      {
        t: "meta_snapshot",
        at: 500,
        when: "end",
        planOutcomes: { applied: 3, total: 3, bogus: 0, alsoBogus: 7 },
      },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n");
    const tel = foldHostTelemetry(fixture, "keel");
    expect(tel.planOutcomes).toEqual({ applied: 2, total: 2 });
    expect(tel.planOutcomes).not.toHaveProperty("bogus");
    expect(tel.planOutcomes).not.toHaveProperty("alsoBogus");
    expect(tel.infos).toEqual([]);
  });

  it("notes 'lacks a usable total' (not a restart claim) when both snapshots exist but carry no total", () => {
    const fixture = [
      { t: "attach", at: 100, sessionId: "s", conductor: "keel", budget: 70000, protectTokens: 20000 },
      { t: "meta_snapshot", at: 105, when: "start", planOutcomes: { applied: 1 } },
      { t: "passthrough", at: 200, reqId: 1, cause: "applied", ops: 1, groups: 0, recalls: 0 },
      { t: "meta_snapshot", at: 500, when: "end", planOutcomes: { applied: 2 } },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n");
    const tel = foldHostTelemetry(fixture, "keel");
    expect(tel.planOutcomes).toEqual({ applied: 1, total: 1 }); // the WS tally
    expect(tel.infos.length).toBe(1);
    expect(tel.infos[0]).toMatch(/usable total/);
    expect(tel.infos[0]).not.toMatch(/restart/);
  });

  it("returns null with NO info note when the meta diff is unusable and there is no WS tally to fall back to", () => {
    const fixture = [
      { t: "attach", at: 100, sessionId: "s", conductor: "keel", budget: 70000, protectTokens: 20000 },
      { t: "meta_snapshot", at: 105, when: "start", planOutcomes: { applied: 5, total: 5 } },
      // Negative diff (restart) — but zero passthrough acks ever arrived, so there is no
      // fallback to note; a restart claim with no reportable outcome would be noise.
      { t: "meta_snapshot", at: 500, when: "end", planOutcomes: { applied: 1, total: 1 } },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n");
    const tel = foldHostTelemetry(fixture, "keel");
    expect(tel.planOutcomes).toBeNull();
    expect(tel.infos).toEqual([]);
  });

  it("filters the WS tally to the 5 ackable causes — a crafted cause like 'total' or 'no-gui' cannot poison it", () => {
    const fixture = [
      { t: "attach", at: 100, sessionId: "s", conductor: "keel", budget: 70000, protectTokens: 20000 },
      { t: "passthrough", at: 200, reqId: 1, cause: "total", ops: 0, groups: 0, recalls: 0 },
      { t: "passthrough", at: 210, reqId: 2, cause: "no-gui", ops: 0, groups: 0, recalls: 0 },
      { t: "passthrough", at: 220, reqId: 3, cause: "applied", ops: 1, groups: 0, recalls: 0 },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n");
    const tel = foldHostTelemetry(fixture, "keel");
    expect(tel.planOutcomes).toEqual({ applied: 1, total: 1 });
  });

  it("WS tally stays null (not {total:0}) when the only passthrough lines carry invalid causes", () => {
    const fixture = [
      { t: "attach", at: 100, sessionId: "s", conductor: "keel", budget: 70000, protectTokens: 20000 },
      { t: "passthrough", at: 200, reqId: 1, cause: "total", ops: 0, groups: 0, recalls: 0 },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n");
    const tel = foldHostTelemetry(fixture, "keel");
    expect(tel.planOutcomes).toBeNull();
  });

  it("uses the LATEST good end snapshot (mid-run refresh) and a null shutdown attempt never clobbers it", () => {
    const fixture = [
      { t: "attach", at: 100, sessionId: "s", conductor: "keel", budget: 70000, protectTokens: 20000 },
      { t: "meta_snapshot", at: 105, when: "start", planOutcomes: { applied: 1, "no-gui": 0, total: 1 } },
      // Two periodic mid-run end-candidates; the later one supersedes the earlier.
      { t: "meta_snapshot", at: 300, when: "end", planOutcomes: { applied: 2, "no-gui": 1, total: 3 } },
      { t: "meta_snapshot", at: 400, when: "end", planOutcomes: { applied: 3, "no-gui": 2, total: 5 } },
      // Shutdown fetch hit a dead extension (fleet teardown order) — planOutcomes null.
      // Must NOT clobber the last good candidate.
      { t: "meta_snapshot", at: 500, when: "end", planOutcomes: null },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n");
    const tel = foldHostTelemetry(fixture, "keel");
    expect(tel.planOutcomes).toEqual({ applied: 2, "no-gui": 2, total: 4 });
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
