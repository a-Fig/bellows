import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { runWorkerLoop, _timing, _resetTiming, sanitizeForPath } from "../loop.mjs";
import { StubPlatform } from "./stubPlatform.mjs";

// m9 (adversarial review): mock gitPull's maybePullAccordion so tests control
// whether a "pull" reports HEAD as moved, without needing a real git repo.
// conductorAdvertise is partially mocked — advertisedConductors keeps its real
// (cheap, no-accordionRepo-touching in these tests since caps/conductors isn't
// asserted here) behavior via importOriginal, but clearConductorCache is a spy
// so we can assert it was (or wasn't) called.
vi.mock("../gitPull.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, maybePullAccordion: vi.fn() };
});
vi.mock("../conductorAdvertise.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, clearConductorCache: vi.fn(actual.clearConductorCache) };
});
import { maybePullAccordion } from "../gitPull.mjs";
import { clearConductorCache } from "../conductorAdvertise.mjs";

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
      // autoUpdate defaults to true; these tests aren't about self-update and
      // don't inject a maybeSelfUpdateFn, so leaving it enabled would run the
      // REAL maybeSelfUpdate against THIS repo's own checkout (REPO_ROOT) on
      // every iteration of every test in this file. Disabled here; the
      // dedicated "self-update wiring" describe block below re-enables it
      // per-test alongside an injected fake.
      autoUpdate: false,
    },
  };
}

describe("sanitizeForPath (M2, adversarial review)", () => {
  it("replaces every Windows-reserved path character with a dash", () => {
    // The colon in "external:<id>" arm names is the concrete crash this fixes
    // (ENOENT/EINVAL from fs.mkdirSync on win32), but sanitize all of
    // <>:"/\|?* per the same regex the main bellows checkout uses (827a914).
    expect(sanitizeForPath("external:thermocline")).toBe("external-thermocline");
    expect(sanitizeForPath('a<b>c:d"e/f\\g|h?i*j')).toBe("a-b-c-d-e-f-g-h-i-j");
  });

  it("leaves an ordinary in-process conductor id untouched", () => {
    expect(sanitizeForPath("keel")).toBe("keel");
  });
});

describe("runWorkerLoop", { timeout: 20_000 }, () => {
  // 20s default for every test in this suite (vitest's default is 5s): every
  // test here that reaches executeClaimedRun (or even just polls once) goes
  // through the real advertisedConductors() -> a real vite-node subprocess
  // spawn (not mocked; only clearConductorCache is a spy). That's normally a
  // few hundred ms but can take several seconds under load — bump the ceiling
  // rather than mocking away a dependency this suite doesn't otherwise stub.
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
    maybePullAccordion.mockReset();
    clearConductorCache.mockClear();
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

  it("heartbeats omit room_id before it's resolved, then include it on every beat after", async () => {
    platform.onClaim = () => ({ status: 200, body: { run: claimedRunFixture() } });
    platform.onComplete = () => ({ status: 200, body: { ok: true } });
    platform.onHeartbeat = () => ({ status: 200, body: { cancel: false } });

    const fakeExecutor = vi.fn(async ({ runDir, onRoomResolved }) => {
      fs.mkdirSync(runDir, { recursive: true });
      // Simulate resolveWorkerRoom: room isn't known immediately — give the
      // heartbeat timer (30ms in this suite) a chance to fire at least once
      // before the room resolves, then fire a couple more times after.
      await new Promise((r) => setTimeout(r, 80));
      onRoomResolved("room-live-42");
      await new Promise((r) => setTimeout(r, 80));
      return {
        id: "run-1",
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

    const summary = await runWorkerLoop({ config: baseConfig(runsDir, platform.url), apiKey: SECRET, log, once: true, executeRunFn: fakeExecutor });
    expect(summary).toEqual({ claimed: 1, completed: 1, failed: 0 });

    const heartbeatReqs = platform.requests.filter((r) => r.url === "/api/bench/runs/run-1/heartbeat");
    expect(heartbeatReqs.length).toBeGreaterThanOrEqual(2);
    expect(heartbeatReqs[0].body).not.toHaveProperty("room_id");
    expect(heartbeatReqs[heartbeatReqs.length - 1].body.room_id).toBe("room-live-42");

    // complete() is the AUTHORITATIVE room_id report — the platform's
    // db.complete_bench_run persists room_id unconditionally from this body,
    // so once the room is known it must be carried here too (omitting it would
    // wipe the value the heartbeat already persisted mid-run).
    const completeReq = platform.requests.find((r) => r.url === "/api/bench/runs/run-1/complete");
    expect(completeReq.body.room_id).toBe("room-live-42");
  });

  it("M2: an external:<id> arm name (literal colon) does not crash runDir provisioning", async () => {
    // Before the fix, runDir was built straight from claimed.arm.name ("external:thermocline"),
    // and fs.mkdirSync on win32 throws (colon is a reserved path character) — the run would
    // never even reach the executor. Assert the claim actually gets executed and completed.
    platform.onClaim = () =>
      ({ status: 200, body: { run: claimedRunFixture({ arm: { conductor: "external:thermocline", name: "external:thermocline" } }) } });
    platform.onComplete = () => ({ status: 200, body: { ok: true } });

    let capturedRunDir = null;
    const fakeExecutor = vi.fn(async ({ runDir }) => {
      capturedRunDir = runDir;
      fs.mkdirSync(runDir, { recursive: true }); // this is the line that used to throw
      return {
        id: "run-1",
        label: "t1/external:thermocline/1",
        status: "completed",
        fingerprint: { conductorId: "external:thermocline" },
        timing: { startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:01:00.000Z", wallClockS: 60 },
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, costUsd: 0, assistantTurns: 1, toolCalls: 0 },
        turns: [],
        conductor: null,
        platform: null,
        artifacts: { piSessionFile: "", hostTelemetryFile: null, workspaceDir: runDir, agentDir: runDir },
      };
    });

    const summary = await runWorkerLoop({ config: baseConfig(runsDir, platform.url), apiKey: SECRET, log, once: true, executeRunFn: fakeExecutor });

    expect(summary).toEqual({ claimed: 1, completed: 1, failed: 0 });
    expect(capturedRunDir).toBeTruthy();
    expect(capturedRunDir).not.toContain(":thermocline"); // the raw colon must be gone
    expect(path.basename(capturedRunDir)).toBe("external-thermocline-1");
    expect(fs.existsSync(capturedRunDir)).toBe(true);
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

  it("m5: the reaped early-return still drains the EventBatcher (no leftover flush timer)", async () => {
    // Before the fix, executeClaimedRun's `if (reaped) return false` skipped
    // events.drain() entirely, leaking the batcher's setInterval flush timer
    // (unref'd, so it wouldn't itself hang the process, but a leaked interval
    // handle is still a bug, and any queued-but-unflushed events silently
    // vanished uncounted). Assert no EventBatcher-shaped Timeout survives.
    platform.onClaim = () => ({ status: 200, body: { run: claimedRunFixture({ id: "run-reaped" }) } });
    platform.onHeartbeat = () => ({ status: 409, body: { error: "reaped" } });

    const fakeExecutor = vi.fn(({ abortSignal, runDir }) => {
      fs.mkdirSync(runDir, { recursive: true });
      return new Promise((resolve) => {
        abortSignal.addEventListener("abort", () =>
          resolve({
            id: "run-reaped",
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

    const before = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    const summary = await runWorkerLoop({ config: baseConfig(runsDir, platform.url), apiKey: SECRET, log, once: true, executeRunFn: fakeExecutor });
    expect(summary.failed).toBe(1);
    const after = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    // Not asserting an exact count (the runtime/test harness may hold its own
    // unrelated Timeouts) — asserting the reaped path didn't ADD one that
    // survives past runWorkerLoop returning.
    expect(after).toBeLessThanOrEqual(before);
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
    // The executor threw before onRoomResolved ever fired — the room was never
    // known, so complete() must omit room_id entirely (not send null).
    expect(completeReq.body).not.toHaveProperty("room_id");
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

  describe("m9: clearConductorCache after a pull that moves HEAD", () => {
    function pullConfig() {
      const cfg = baseConfig(runsDir, platform.url);
      cfg.worker.pullBeforeClaim = true;
      return cfg;
    }

    it("clears the conductor cache when maybePullAccordion reports HEAD moved", async () => {
      maybePullAccordion.mockReturnValue(true);
      platform.onClaim = () => ({ status: 204 });
      await runWorkerLoop({ config: pullConfig(), apiKey: SECRET, log, once: true, executeRunFn: vi.fn() });
      expect(maybePullAccordion).toHaveBeenCalledTimes(1);
      expect(clearConductorCache).toHaveBeenCalledTimes(1);
    });

    it("does NOT clear the conductor cache when the pull was a no-op / throttled / failed", async () => {
      maybePullAccordion.mockReturnValue(false);
      platform.onClaim = () => ({ status: 204 });
      await runWorkerLoop({ config: pullConfig(), apiKey: SECRET, log, once: true, executeRunFn: vi.fn() });
      expect(maybePullAccordion).toHaveBeenCalledTimes(1);
      expect(clearConductorCache).not.toHaveBeenCalled();
    });

    it("never calls maybePullAccordion at all when pullBeforeClaim is false", async () => {
      platform.onClaim = () => ({ status: 204 });
      await runWorkerLoop({ config: baseConfig(runsDir, platform.url), apiKey: SECRET, log, once: true, executeRunFn: vi.fn() });
      expect(maybePullAccordion).not.toHaveBeenCalled();
      expect(clearConductorCache).not.toHaveBeenCalled();
    }, 20_000);
  });

  it("claim body carries a `version` field (this worker's own short HEAD sha) alongside caps/conductors", async () => {
    // currentHeadShort runs for real here (read-only `git rev-parse`, no
    // side effects either way) — assert it's either a well-formed short sha
    // or omitted entirely (best-effort: git may be unavailable in some CI
    // sandboxes), never anything else.
    platform.onClaim = () => ({ status: 204 });
    await runWorkerLoop({ config: baseConfig(runsDir, platform.url), apiKey: SECRET, log, once: true, executeRunFn: vi.fn() });
    const claimReq = platform.requests.find((r) => r.url === "/api/bench/workers/claim");
    expect(claimReq).toBeTruthy();
    if ("version" in claimReq.body) {
      expect(claimReq.body.version).toMatch(/^[0-9a-f]{12}$/);
    }
  });

  describe("self-update wiring", () => {
    function selfUpdateConfig({ autoUpdate = true } = {}) {
      const cfg = baseConfig(runsDir, platform.url);
      cfg.worker.autoUpdate = autoUpdate;
      return cfg;
    }

    afterEach(() => {
      delete process.env.BELLOWS_NO_SELF_UPDATE;
    });

    it("startup check: an 'updated' result exits BEFORE the very first claim ever happens", async () => {
      let claims = 0;
      platform.onClaim = () => {
        claims++;
        return { status: 204 };
      };
      const fakeSelfUpdate = vi.fn(async () => ({ action: "updated", from: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", to: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }));

      const summary = await runWorkerLoop({
        config: selfUpdateConfig(),
        apiKey: SECRET,
        log,
        executeRunFn: vi.fn(),
        maybeSelfUpdateFn: fakeSelfUpdate,
      });

      expect(claims).toBe(0); // never claimed — self-update exited first
      expect(summary).toEqual({ claimed: 0, completed: 0, failed: 0 });
      expect(fakeSelfUpdate).toHaveBeenCalledTimes(1);
      expect(logs.join("\n")).toMatch(/self-update: aaaaaaaaaaaa→bbbbbbbbbbbb — exiting for supervisor relaunch/);
    });

    it("after-run checkpoint: an 'updated' result following a completed run exits before the NEXT claim", async () => {
      _timing.selfUpdateThrottleMs = 0; // never throttled — deterministic re-fire at the after-run checkpoint
      let claims = 0;
      platform.onClaim = () => {
        claims++;
        if (claims === 1) return { status: 200, body: { run: claimedRunFixture() } };
        return { status: 204 }; // must never be reached
      };
      platform.onComplete = () => ({ status: 200, body: { ok: true } });

      let selfUpdateCalls = 0;
      const fakeSelfUpdate = vi.fn(async () => {
        selfUpdateCalls++;
        if (selfUpdateCalls === 1) return { action: "current" }; // the startup check
        return { action: "updated", from: "a".repeat(40), to: "b".repeat(40) }; // the after-run check
      });

      const fakeExecutor = vi.fn(async ({ runDir }) => {
        fs.mkdirSync(runDir, { recursive: true });
        return {
          id: "run-1",
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

      const summary = await runWorkerLoop({
        config: selfUpdateConfig(),
        apiKey: SECRET,
        log,
        executeRunFn: fakeExecutor,
        maybeSelfUpdateFn: fakeSelfUpdate,
        maxIterations: 5,
      });

      expect(claims).toBe(1); // the second (204) claim never happened
      expect(summary).toEqual({ claimed: 1, completed: 1, failed: 0 });
      expect(fakeSelfUpdate).toHaveBeenCalledTimes(2);
    });

    it("a 'skipped' result never blocks the loop from claiming normally", async () => {
      platform.onClaim = () => ({ status: 200, body: { run: claimedRunFixture() } });
      platform.onComplete = () => ({ status: 200, body: { ok: true } });
      const fakeSelfUpdate = vi.fn(async () => ({ action: "skipped", reason: "dirty working tree" }));
      const fakeExecutor = vi.fn(async ({ runDir }) => {
        fs.mkdirSync(runDir, { recursive: true });
        return {
          id: "run-1",
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

      const summary = await runWorkerLoop({ config: selfUpdateConfig(), apiKey: SECRET, log, once: true, executeRunFn: fakeExecutor, maybeSelfUpdateFn: fakeSelfUpdate });
      expect(summary).toEqual({ claimed: 1, completed: 1, failed: 0 });
      expect(fakeSelfUpdate).toHaveBeenCalledTimes(1); // the startup check only — `once` returns before the after-run checkpoint
      // m2 (adversarial review): skips log at WARN level — a permanently-skipping
      // worker is silently pinned to old code, exactly the drift this feature exists to stop.
      expect(logs.join("\n")).toMatch(/WARN: self-update skipped \(dirty working tree\) — this worker will not auto-update/);
    });

    it("throttles repeat checks: back-to-back idle 204 polls only re-check once the throttle window has elapsed", async () => {
      _timing.idleBaseMs = 5;
      _timing.idleJitterMs = 0;
      _timing.selfUpdateThrottleMs = 10_000; // long — should NOT re-fire across a handful of fast idle polls
      platform.onClaim = () => ({ status: 204 });
      const fakeSelfUpdate = vi.fn(async () => ({ action: "current" }));

      const summary = await runWorkerLoop({
        config: selfUpdateConfig(),
        apiKey: SECRET,
        log,
        executeRunFn: vi.fn(),
        maybeSelfUpdateFn: fakeSelfUpdate,
        maxIterations: 5,
      });

      expect(summary).toEqual({ claimed: 0, completed: 0, failed: 0 });
      expect(fakeSelfUpdate).toHaveBeenCalledTimes(1); // startup only — the throttle held for every idle-poll checkpoint after it
    });

    it("config autoUpdate:false disables the check entirely (never even called)", async () => {
      platform.onClaim = () => ({ status: 204 });
      const fakeSelfUpdate = vi.fn(async () => ({ action: "updated", from: "a".repeat(40), to: "b".repeat(40) }));
      const summary = await runWorkerLoop({ config: selfUpdateConfig({ autoUpdate: false }), apiKey: SECRET, log, once: true, executeRunFn: vi.fn(), maybeSelfUpdateFn: fakeSelfUpdate });
      expect(fakeSelfUpdate).not.toHaveBeenCalled();
      expect(summary).toEqual({ claimed: 0, completed: 0, failed: 0 }); // proves it actually reached (and 204'd) the claim, not an early self-update exit
    });

    it("BELLOWS_NO_SELF_UPDATE=1 force-disables even when config.worker.autoUpdate is true (kill switch)", async () => {
      process.env.BELLOWS_NO_SELF_UPDATE = "1";
      platform.onClaim = () => ({ status: 204 });
      const fakeSelfUpdate = vi.fn(async () => ({ action: "updated", from: "a".repeat(40), to: "b".repeat(40) }));
      const summary = await runWorkerLoop({ config: selfUpdateConfig({ autoUpdate: true }), apiKey: SECRET, log, once: true, executeRunFn: vi.fn(), maybeSelfUpdateFn: fakeSelfUpdate });
      expect(fakeSelfUpdate).not.toHaveBeenCalled();
      expect(summary).toEqual({ claimed: 0, completed: 0, failed: 0 });
    });

    it("autoUpdate defaults to enabled when the config field is entirely absent (not just when explicitly true)", async () => {
      const cfg = baseConfig(runsDir, platform.url);
      delete cfg.worker.autoUpdate; // simulate a config object that never set the field at all
      platform.onClaim = () => ({ status: 204 });
      const fakeSelfUpdate = vi.fn(async () => ({ action: "current" }));
      await runWorkerLoop({ config: cfg, apiKey: SECRET, log, once: true, executeRunFn: vi.fn(), maybeSelfUpdateFn: fakeSelfUpdate });
      expect(fakeSelfUpdate).toHaveBeenCalledTimes(1);
    });

    it("a self-update check that throws is logged and does not crash or block the loop", async () => {
      platform.onClaim = () => ({ status: 204 });
      const throwingSelfUpdate = vi.fn(async () => {
        throw new Error("git blew up");
      });
      const summary = await runWorkerLoop({ config: selfUpdateConfig(), apiKey: SECRET, log, once: true, executeRunFn: vi.fn(), maybeSelfUpdateFn: throwingSelfUpdate });
      expect(summary).toEqual({ claimed: 0, completed: 0, failed: 0 });
      expect(logs.join("\n")).toMatch(/self-update check threw: git blew up/);
    });

    it("a 'rolled-back' result is logged loudly (WARN) and the loop keeps polling normally", async () => {
      platform.onClaim = () => ({ status: 204 });
      const fakeSelfUpdate = vi.fn(async () => ({ action: "rolled-back", reason: "npm ci failed: boom" }));
      const summary = await runWorkerLoop({ config: selfUpdateConfig(), apiKey: SECRET, log, once: true, executeRunFn: vi.fn(), maybeSelfUpdateFn: fakeSelfUpdate });
      expect(summary).toEqual({ claimed: 0, completed: 0, failed: 0 });
      expect(logs.join("\n")).toMatch(/WARN: self-update rolled back \(npm ci failed: boom\)/);
    });

    it("M1: no self-update check starts once shutdown has been requested (after-run checkpoint suppressed)", async () => {
      // SIGTERM arrives mid-run: the loop's `stopped` flag is set while the run
      // is in flight. Without the guard, the after-run checkpoint would still
      // launch a fetch (and possibly minutes of npm ci) on a process that
      // should be exiting within ~10s — assert it never even starts.
      _timing.selfUpdateThrottleMs = 0; // unthrottled: the after-run check WOULD fire if not suppressed
      platform.onClaim = () => ({ status: 200, body: { run: claimedRunFixture() } });
      platform.onComplete = () => ({ status: 200, body: { ok: true } });

      const controller = new AbortController();
      let selfUpdateCalls = 0;
      const fakeSelfUpdate = vi.fn(async () => {
        selfUpdateCalls++;
        return { action: "current" };
      });

      const fakeExecutor = vi.fn(async ({ runDir }) => {
        fs.mkdirSync(runDir, { recursive: true });
        controller.abort(); // shutdown requested while the run is in flight
        return {
          id: "run-1",
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

      const summary = await runWorkerLoop({
        config: selfUpdateConfig(),
        apiKey: SECRET,
        log,
        signal: controller.signal,
        executeRunFn: fakeExecutor,
        maybeSelfUpdateFn: fakeSelfUpdate,
        maxIterations: 5,
      });

      expect(summary.claimed).toBe(1);
      // Only the startup check ran; the after-run checkpoint was suppressed by
      // the shutdown guard even though the throttle would have allowed it.
      expect(selfUpdateCalls).toBe(1);
    });
  });
});
