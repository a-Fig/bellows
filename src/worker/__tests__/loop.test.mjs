import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { runWorkerLoop, _timing, _resetTiming } from "../loop.mjs";
import { StubPlatform } from "./stubPlatform.mjs";

const SECRET = "at_super_secret_key_do_not_leak";

function claimedRunFixture(overrides = {}) {
  return {
    id: "run-1",
    trial: "t1",
    name: "keel-1",
    config: {
      trial: "t1",
      problems: "xjq",
      model: "token-router:deepseek/deepseek-v4-flash",
      thinkingLevel: "medium",
      budget: 10000,
      protectTokens: 2000,
      arms: [{ conductor: "keel" }],
      seeds: 1,
      caps: { costUsd: 1, turns: 10, minutes: 5 },
      parallel: 1,
      room: { pool: ["room-1"] },
    },
    arm: { conductor: "keel", name: "keel" },
    seed: 1,
    ...overrides,
  };
}

function baseConfig(runsDir, platformUrl) {
  return {
    accordionRepo: process.cwd(), // not a real accordion checkout; not touched unless pullBeforeClaim
    platformBase: platformUrl,
    platformApiKeyEnv: "AGENT_TRIALS_API_KEY",
    runsDir,
    worker: {
      platformUrl,
      name: "test-worker",
      caps: ["in-process"],
      pullBeforeClaim: false,
      parallel: 1,
    },
  };
}

describe("runWorkerLoop", () => {
  /** @type {StubPlatform} */
  let platform;
  let runsDir;
  let logs;

  beforeEach(async () => {
    platform = new StubPlatform();
    await platform.listen();
    runsDir = fs.mkdtempSync(path.join(tmpdir(), "bellows-worker-test-"));
    logs = [];
    _timing.heartbeatMs = 30; // fast heartbeat for tests
    _timing.idleBaseMs = 10;
    _timing.idleJitterMs = 5;
  });

  afterEach(async () => {
    await platform.close();
    fs.rmSync(runsDir, { recursive: true, force: true });
    _resetTiming();
  });

  function log(m) {
    logs.push(m);
  }

  it("claim -> execute -> events -> complete happy path", async () => {
    platform.onClaim = () => ({ status: 200, body: { run: claimedRunFixture() } });
    platform.onComplete = () => ({ status: 200, body: { ok: true } });

    const fakeExecutor = vi.fn(async ({ runDir }) => {
      fs.mkdirSync(runDir, { recursive: true });
      return {
        id: "run-1",
        label: "t1/keel/1",
        status: "completed",
        fingerprint: { conductorId: "keel" },
        timing: { startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:01:00.000Z", wallClockS: 60 },
        usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, costUsd: 0.01, assistantTurns: 3, toolCalls: 1 },
        turns: [],
        conductor: null,
        platform: null,
        artifacts: { piSessionFile: "", hostTelemetryFile: null, workspaceDir: runDir, agentDir: runDir },
      };
    });

    const summary = await runWorkerLoop({ config: baseConfig(runsDir, platform.url), apiKey: SECRET, log, once: true, executeRunFn: fakeExecutor });

    expect(summary).toEqual({ claimed: 1, completed: 1, failed: 0 });
    expect(fakeExecutor).toHaveBeenCalledTimes(1);
    expect(fakeExecutor.mock.calls[0][0].claimed.id).toBe("run-1");

    const claimReq = platform.requests.find((r) => r.url === "/api/bench/workers/claim");
    expect(claimReq.body.worker).toBe("test-worker");
    expect(claimReq.headers["x-api-key"]).toBe(SECRET);

    const completeReq = platform.requests.find((r) => r.url === "/api/bench/runs/run-1/complete");
    expect(completeReq).toBeTruthy();
    expect(completeReq.body.status).toBe("done");
    expect(completeReq.body.record.id).toBe("run-1");

    const eventsReqs = platform.requests.filter((r) => r.url === "/api/bench/runs/run-1/events");
    expect(eventsReqs.length).toBeGreaterThan(0);
    const allEvents = eventsReqs.flatMap((r) => r.body.events);
    expect(allEvents.some((e) => e.type === "run-start")).toBe(true);
    expect(allEvents.some((e) => e.type === "status-change" && e.data.status === "done")).toBe(true);

    expect(logs.join("\n")).not.toContain(SECRET);
  });

  it("204 idle loop: polls without executing, returns immediately with --once", async () => {
    platform.onClaim = () => ({ status: 204 });
    const fakeExecutor = vi.fn();
    const summary = await runWorkerLoop({ config: baseConfig(runsDir, platform.url), apiKey: SECRET, log, once: true, executeRunFn: fakeExecutor });
    expect(summary).toEqual({ claimed: 0, completed: 0, failed: 0 });
    expect(fakeExecutor).not.toHaveBeenCalled();
  });

  it("204 idle loop polls repeatedly, then stops on abort signal (no --once)", async () => {
    let claimCalls = 0;
    platform.onClaim = () => {
      claimCalls++;
      return { status: 204 };
    };
    const controller = new AbortController();
    const runPromise = runWorkerLoop({ config: baseConfig(runsDir, platform.url), apiKey: SECRET, log, signal: controller.signal, executeRunFn: vi.fn() });
    await vi.waitFor(() => expect(claimCalls).toBeGreaterThanOrEqual(2), { timeout: 2000 });
    controller.abort();
    const summary = await runPromise;
    expect(summary.claimed).toBe(0);
    expect(claimCalls).toBeGreaterThanOrEqual(2);
  });

  it("cancel mid-run: heartbeat returns cancel:true, executor's abort signal fires, complete reports failed", async () => {
    platform.onClaim = () => ({ status: 200, body: { run: claimedRunFixture() } });
    let heartbeats = 0;
    platform.onHeartbeat = () => {
      heartbeats++;
      return { status: 200, body: { cancel: heartbeats >= 1 } };
    };

    let abortHookCalled = false;
    const fakeExecutor = vi.fn(({ abortSignal, runDir }) => {
      fs.mkdirSync(runDir, { recursive: true });
      return new Promise((resolve) => {
        abortSignal.addEventListener("abort", () => {
          abortHookCalled = true;
          resolve({
            id: "run-1",
            label: "t1/keel/1",
            status: "error",
            statusDetail: "cancelled by platform",
            fingerprint: { conductorId: "keel" },
            timing: { startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:00:05.000Z", wallClockS: 5 },
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costUsd: 0, assistantTurns: 0, toolCalls: 0 },
            turns: [],
            conductor: null,
            platform: null,
            artifacts: { piSessionFile: "", hostTelemetryFile: null, workspaceDir: runDir, agentDir: runDir },
          });
        });
        // never resolves on its own — only the abort hook resolves it (proves the
        // executor was actually asked to stop, not just raced against a timeout)
      });
    });

    const summary = await runWorkerLoop({ config: baseConfig(runsDir, platform.url), apiKey: SECRET, log, once: true, executeRunFn: fakeExecutor });

    expect(abortHookCalled).toBe(true);
    expect(summary).toEqual({ claimed: 1, completed: 0, failed: 1 });
    const completeReq = platform.requests.find((r) => r.url === "/api/bench/runs/run-1/complete");
    expect(completeReq.body.status).toBe("failed");
    expect(completeReq.body.error).toMatch(/cancelled by platform/);
  });

  it("409 on heartbeat: stops driving via abort and does not throw", async () => {
    platform.onClaim = () => ({ status: 200, body: { run: claimedRunFixture() } });
    platform.onHeartbeat = () => ({ status: 409, body: { error: "reaped" } });

    const fakeExecutor = vi.fn(({ abortSignal, runDir }) => {
      fs.mkdirSync(runDir, { recursive: true });
      return new Promise((resolve) => {
        abortSignal.addEventListener("abort", () =>
          resolve({
            id: "run-1",
            label: "t1/keel/1",
            status: "error",
            statusDetail: "run reaped",
            fingerprint: { conductorId: "keel" },
            timing: { startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:00:01.000Z", wallClockS: 1 },
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costUsd: 0, assistantTurns: 0, toolCalls: 0 },
            turns: [],
            conductor: null,
            platform: null,
            artifacts: { piSessionFile: "", hostTelemetryFile: null, workspaceDir: runDir, agentDir: runDir },
          }),
        );
      });
    });

    const summary = await runWorkerLoop({ config: baseConfig(runsDir, platform.url), apiKey: SECRET, log, once: true, executeRunFn: fakeExecutor });
    expect(summary.failed).toBe(1);
    // complete() must NOT be called after a 409 reaping — the server already
    // considers the run gone and would just 409 again.
    const completeReq = platform.requests.find((r) => r.url === "/api/bench/runs/run-1/complete");
    expect(completeReq).toBeUndefined();
  });

  it("an executor throw is caught, folded into a failed complete(), and the loop keeps going", async () => {
    let claims = 0;
    platform.onClaim = () => {
      claims++;
      if (claims === 1) return { status: 200, body: { run: claimedRunFixture({ id: "run-throw" }) } };
      return { status: 204 };
    };
    const fakeExecutor = vi.fn(async ({ runDir }) => {
      fs.mkdirSync(runDir, { recursive: true });
      throw new Error("boom: pi crashed");
    });

    const summary = await runWorkerLoop({ config: baseConfig(runsDir, platform.url), apiKey: SECRET, log, executeRunFn: fakeExecutor, maxIterations: 2 });
    expect(summary).toEqual({ claimed: 1, completed: 0, failed: 1 });
    const completeReq = platform.requests.find((r) => r.url === "/api/bench/runs/run-throw/complete");
    expect(completeReq.body.status).toBe("failed");
    expect(completeReq.body.error).toMatch(/boom: pi crashed/);
  });

  it("never logs the API key across the whole claim/execute/complete lifecycle", async () => {
    platform.onClaim = () => ({ status: 200, body: { run: claimedRunFixture({ id: "run-secret" }) } });
    const fakeExecutor = vi.fn(async ({ runDir }) => {
      fs.mkdirSync(runDir, { recursive: true });
      return {
        id: "run-secret",
        label: "t1/keel/1",
        status: "completed",
        fingerprint: { conductorId: "keel" },
        timing: { startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:01:00.000Z", wallClockS: 60 },
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, costUsd: 0, assistantTurns: 1, toolCalls: 0 },
        turns: [],
        conductor: null,
        platform: null,
        artifacts: { piSessionFile: "", hostTelemetryFile: null, workspaceDir: runDir, agentDir: runDir },
      };
    });
    await runWorkerLoop({ config: baseConfig(runsDir, platform.url), apiKey: SECRET, log, once: true, executeRunFn: fakeExecutor });
    expect(logs.join("\n")).not.toContain(SECRET);
    // Also assert the header carried it (so we know the key really was used, not just absent everywhere)
    const anyReqWithKey = platform.requests.some((r) => r.headers["x-api-key"] === SECRET);
    expect(anyReqWithKey).toBe(true);
  });
});
