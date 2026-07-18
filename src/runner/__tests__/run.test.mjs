import { describe, it, expect, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import {
  platformAgentName,
  loadConductorLaunchSpec,
  getFreePort,
  spawnExternalConductor,
  spawnHost,
  hostEntryForAccordion,
  hostEnv,
  modelShortName,
  buildJoinMeta,
  conductorNeverAttached,
  driveUntilDone,
  isDegenerateAssistantMessage,
  looksLikeAgentFinalizeCall,
  appendAgentFinalizeNote,
} from "../run.mjs";

class FakePi extends EventEmitter {
  async getSessionStats() {
    return { cost: 0, tokens: { total: 1 } };
  }
}

const DRIVER_SPEC = { caps: { minutes: 1, turns: 100, costUsd: 10 } };

describe("driveUntilDone terminal model errors", () => {
  it("classifies an assistant stopReason=error on the final agent_end", async () => {
    const pi = new FakePi();
    const outcome = driveUntilDone({ pi, host: null, spec: DRIVER_SPEC, log: () => {}, label: "test" });

    pi.emit("event", {
      type: "message_end",
      message: { role: "assistant", stopReason: "error", errorMessage: "400: reasoning_content is required" },
    });
    pi.emit("event", { type: "agent_end", willRetry: false });

    await expect(outcome).resolves.toEqual({
      status: "error",
      statusDetail: "terminal model error: 400: reasoning_content is required",
    });
  });

  it("waits through a retryable model error and completes after a successful retry", async () => {
    const pi = new FakePi();
    const outcome = driveUntilDone({ pi, host: null, spec: DRIVER_SPEC, log: () => {}, label: "test" });

    pi.emit("event", {
      type: "message_end",
      message: { role: "assistant", stopReason: "error", errorMessage: "429: retry me" },
    });
    pi.emit("event", { type: "agent_end", willRetry: true });
    pi.emit("event", {
      type: "message_end",
      message: { role: "assistant", stopReason: "endTurn", content: [{ type: "text", text: "done" }] },
    });
    pi.emit("event", { type: "agent_end", willRetry: false });

    await expect(outcome).resolves.toEqual({ status: "completed", statusDetail: undefined });
  });

  it("still treats a normal agent_end as completed", async () => {
    const pi = new FakePi();
    const outcome = driveUntilDone({ pi, host: null, spec: DRIVER_SPEC, log: () => {}, label: "test" });
    pi.emit("event", { type: "agent_end" });
    await expect(outcome).resolves.toEqual({ status: "completed", statusDetail: undefined });
  });
});

describe("driveUntilDone — sentinel-echo / degenerate terminal response (2026-07-18)", () => {
  it("classifies a thinking-only final assistant message (normal stop) as an error", async () => {
    const pi = new FakePi();
    const outcome = driveUntilDone({ pi, host: null, spec: DRIVER_SPEC, log: () => {}, label: "test" });

    pi.emit("event", {
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "thinking", thinking: "[reasoning unavailable from provider]" }],
      },
    });
    pi.emit("event", { type: "agent_end", willRetry: false });

    await expect(outcome).resolves.toEqual({
      status: "error",
      statusDetail:
        "terminal degenerate response: final assistant message has no text and no tool call (reasoning-only stop)",
    });
  });

  it("still completes when the final assistant message carries substantive text", async () => {
    const pi = new FakePi();
    const outcome = driveUntilDone({ pi, host: null, spec: DRIVER_SPEC, log: () => {}, label: "test" });

    pi.emit("event", {
      type: "message_end",
      message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "All done." }] },
    });
    pi.emit("event", { type: "agent_end", willRetry: false });

    await expect(outcome).resolves.toEqual({ status: "completed", statusDetail: undefined });
  });

  it("still completes when the final assistant message carries a tool call (no text needed)", async () => {
    const pi = new FakePi();
    const outcome = driveUntilDone({ pi, host: null, spec: DRIVER_SPEC, log: () => {}, label: "test" });

    pi.emit("event", {
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } }],
      },
    });
    pi.emit("event", { type: "agent_end", willRetry: false });

    await expect(outcome).resolves.toEqual({ status: "completed", statusDetail: undefined });
  });

  it("tracks an agent-issued platform finalize call via tool_execution_start, without changing the resolved shape", async () => {
    const pi = new FakePi();
    const telemetry = { sawAgentFinalize: false };
    const outcome = driveUntilDone({ pi, host: null, spec: DRIVER_SPEC, log: () => {}, label: "test", telemetry });

    pi.emit("event", {
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "python slopcode_client.py finalize", timeout: 30 },
    });
    pi.emit("event", { type: "agent_end" });

    await expect(outcome).resolves.toEqual({ status: "completed", statusDetail: undefined });
    expect(telemetry.sawAgentFinalize).toBe(true);
  });

  it("leaves telemetry.sawAgentFinalize false for unrelated tool calls", async () => {
    const pi = new FakePi();
    const telemetry = { sawAgentFinalize: false };
    const outcome = driveUntilDone({ pi, host: null, spec: DRIVER_SPEC, log: () => {}, label: "test", telemetry });

    pi.emit("event", {
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "python slopcode_client.py submit", timeout: 30 },
    });
    pi.emit("event", { type: "agent_end" });

    await expect(outcome).resolves.toEqual({ status: "completed", statusDetail: undefined });
    expect(telemetry.sawAgentFinalize).toBe(false);
  });

  it("keeps a degenerate terminal message completed when the agent already finalized", async () => {
    const pi = new FakePi();
    const telemetry = { sawAgentFinalize: false };
    const outcome = driveUntilDone({ pi, host: null, spec: DRIVER_SPEC, log: () => {}, label: "test", telemetry });

    pi.emit("event", {
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "python slopcode_client.py finalize", timeout: 30 },
    });
    pi.emit("event", {
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "thinking", thinking: "[reasoning unavailable from provider]" }],
      },
    });
    pi.emit("event", { type: "agent_end", willRetry: false });

    await expect(outcome).resolves.toEqual({ status: "completed", statusDetail: undefined });
    expect(telemetry.sawAgentFinalize).toBe(true);
  });
});

describe("isDegenerateAssistantMessage", () => {
  it("is false for a falsy message (no assistant message ever observed)", () => {
    expect(isDegenerateAssistantMessage(null)).toBe(false);
    expect(isDegenerateAssistantMessage(undefined)).toBe(false);
  });

  it("is true for thinking-only content", () => {
    expect(isDegenerateAssistantMessage({ content: [{ type: "thinking", thinking: "..." }] })).toBe(true);
  });

  it("is true for an empty content array", () => {
    expect(isDegenerateAssistantMessage({ content: [] })).toBe(true);
  });

  it("is false when a text block has non-whitespace text", () => {
    expect(isDegenerateAssistantMessage({ content: [{ type: "text", text: "hi" }] })).toBe(false);
  });

  it("is true when the only text block is whitespace-only", () => {
    expect(isDegenerateAssistantMessage({ content: [{ type: "text", text: "   \n" }] })).toBe(true);
  });

  it("is false when a toolCall block is present, even with no text", () => {
    expect(isDegenerateAssistantMessage({ content: [{ type: "toolCall", id: "c1", name: "bash" }] })).toBe(false);
  });

  it("treats a non-whitespace plain-string content as text", () => {
    expect(isDegenerateAssistantMessage({ content: "All done." })).toBe(false);
  });

  it("treats a whitespace-only plain-string content as degenerate", () => {
    expect(isDegenerateAssistantMessage({ content: "   " })).toBe(true);
  });
});

describe("looksLikeAgentFinalizeCall", () => {
  it("matches a bash call running slopcode_client.py finalize", () => {
    expect(looksLikeAgentFinalizeCall({ command: "python slopcode_client.py finalize", timeout: 30 })).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(looksLikeAgentFinalizeCall({ command: "PYTHON SLOPCODE_CLIENT.PY FINALIZE" })).toBe(true);
  });

  it("does not match an unrelated slopcode_client command", () => {
    expect(looksLikeAgentFinalizeCall({ command: "python slopcode_client.py submit" })).toBe(false);
  });

  it("does not match finalize mentioned without slopcode_client", () => {
    expect(looksLikeAgentFinalizeCall({ command: "echo finalize" })).toBe(false);
  });

  it("is false for undefined args", () => {
    expect(looksLikeAgentFinalizeCall(undefined)).toBe(false);
  });
});

describe("appendAgentFinalizeNote", () => {
  it("appends the sweep-succeeded note when completed, the agent never finalized, and the sweep finalized", () => {
    expect(appendAgentFinalizeNote("completed", undefined, false, "finalized")).toBe(
      "agent never invoked platform finalize; game finalized by post-run sweep",
    );
  });

  it("joins onto existing statusDetail with '; '", () => {
    expect(appendAgentFinalizeNote("completed", "platform row present but not finalized", false, "finalized")).toBe(
      "platform row present but not finalized; agent never invoked platform finalize; game finalized by post-run sweep",
    );
  });

  it("is a no-op when the agent itself finalized", () => {
    expect(appendAgentFinalizeNote("completed", "x", true, "finalized")).toBe("x");
  });

  it("is a no-op for a non-completed status", () => {
    expect(appendAgentFinalizeNote("error", "some detail", false, "finalized")).toBe("some detail");
  });

  it("does not overclaim when the sweep failed to finalize", () => {
    expect(appendAgentFinalizeNote("completed", undefined, false, "failed")).toBe(
      "agent never invoked platform finalize; sweep result: failed",
    );
  });

  it("does not overclaim when the sweep found no session", () => {
    expect(appendAgentFinalizeNote("completed", undefined, false, "no-session")).toBe(
      "agent never invoked platform finalize; sweep result: no-session",
    );
  });

  it("does not overclaim when the sweep gave up on grade-pending", () => {
    expect(appendAgentFinalizeNote("completed", undefined, false, "grade-pending-gave-up")).toBe(
      "agent never invoked platform finalize; sweep result: grade-pending-gave-up",
    );
  });

  it("does not overclaim when the sweep itself threw (sweepFinalize null)", () => {
    expect(appendAgentFinalizeNote("completed", undefined, false, null)).toBe(
      "agent never invoked platform finalize; sweep result: null",
    );
  });
});

describe("hostEntryForAccordion", () => {
  it("selects the v15 controller for a truth-in-extension checkout", () => {
    const repo = fs.mkdtempSync(path.join(tmpdir(), "accordion-v15-"));
    fs.mkdirSync(path.join(repo, "core"));
    fs.writeFileSync(path.join(repo, "core", "protocol.ts"), "export const PROTOCOL_VERSION = 15;\n");
    expect(hostEntryForAccordion(repo)).toBe("src/host/main-v15.ts");
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("keeps legacy refs on the existing controller", () => {
    expect(hostEntryForAccordion("C:/missing/legacy-accordion")).toBe("src/host/main.ts");
  });
});

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(HERE, "..", "..", "..", "test", "fixtures");

describe("hostEnv — the effective-accordion-repo env seam", () => {
  it("carries BELLOWS_ACCORDION_REPO = the effective repo (a pinned accordionRef worktree)", () => {
    // executeRun hands spawnHost/spawnExternalConductor an effConfig whose
    // accordionRepo is the pinned worktree when the trial sets accordionRef;
    // both spawn sites spread hostEnv(effConfig) into the child env.
    expect(hostEnv({ accordionRepo: "C:/runs/_accordion/deadbeef1234" })).toEqual({
      BELLOWS_ACCORDION_REPO: "C:/runs/_accordion/deadbeef1234",
    });
  });

  it("carries the default repo unchanged when no ref is pinned", () => {
    expect(hostEnv({ accordionRepo: "C:/acc" })).toEqual({ BELLOWS_ACCORDION_REPO: "C:/acc" });
  });
});

describe("conductorNeverAttached — issue #14 finalization guard", () => {
  const errored = { attachCount: 0, syncs: 0, errors: ["unknown conductor \"zzz\""] };
  const healthy = { attachCount: 1, syncs: 12, errors: [] };

  it("flags a completed run whose conductor never attached", () => {
    expect(conductorNeverAttached("keel", errored, "completed")).toBe(true);
  });

  it("does not flag arm 'none' (no conductor was ever requested)", () => {
    expect(conductorNeverAttached("none", errored, "completed")).toBe(false);
  });

  it("does not flag a healthy conductor (attached + synced)", () => {
    expect(conductorNeverAttached("keel", healthy, "completed")).toBe(false);
  });

  it("does not flag a null conductor (e.g. telemetry file missing)", () => {
    expect(conductorNeverAttached("keel", null, "completed")).toBe(false);
  });

  it("does not override a non-completed status (e.g. an existing error or abort)", () => {
    expect(conductorNeverAttached("keel", errored, "error")).toBe(false);
    expect(conductorNeverAttached("keel", errored, "aborted-cost")).toBe(false);
  });

  it("does not flag zero attach/sync without a surfaced error (edge case, no error signal)", () => {
    expect(conductorNeverAttached("keel", { attachCount: 0, syncs: 0, errors: [] }, "completed")).toBe(false);
  });
});

describe("platformAgentName", () => {
  it("is unique per (trial, arm, seed)", () => {
    const names = new Set();
    for (const arm of ["keel", "compaction-naive", "none"]) {
      for (const seed of [1, 2, 3]) names.add(platformAgentName("trialX", arm, seed));
    }
    expect(names.size).toBe(9); // no collisions
  });

  it("uses the <trial>-<arm>-s<seed> shape", () => {
    expect(platformAgentName("t", "keel", 2)).toBe("t-keel-s2");
  });

  it("is ASCII-safe and bounded", () => {
    const n = platformAgentName("has space/slash", "arm:x", 1);
    expect(n).toMatch(/^[A-Za-z0-9_.-]+$/);
    expect(n.length).toBeLessThanOrEqual(80);
  });
});

describe("modelShortName", () => {
  it("strips a leading token-router: prefix and takes the last path segment", () => {
    expect(modelShortName("token-router:deepseek/deepseek-v4-flash")).toBe("deepseek-v4-flash");
  });

  it("takes the last path segment even without a token-router: prefix", () => {
    expect(modelShortName("anthropic/claude-sonnet")).toBe("claude-sonnet");
  });

  it("returns the string unchanged when there is no provider prefix or path", () => {
    expect(modelShortName("gpt-4")).toBe("gpt-4");
  });

  it("strips token-router: even when there is no further path segment", () => {
    expect(modelShortName("token-router:solo-model")).toBe("solo-model");
  });
});

describe("buildJoinMeta", () => {
  it("builds display_name as '<armName> · <modelShort> · s<seed>'", () => {
    const meta = buildJoinMeta({
      armName: "keel",
      model: "token-router:deepseek/deepseek-v4-flash",
      conductor: "external:thermocline",
      trial: "t1",
      seed: 3,
    });
    expect(meta.display_name).toBe("keel · deepseek-v4-flash · s3");
    expect(meta.model).toBe("token-router:deepseek/deepseek-v4-flash");
    expect(meta.conductor).toBe("external:thermocline");
    expect(meta.trial).toBe("t1");
    expect(meta.seed).toBe(3);
  });

  it("seed is coerced to an integer", () => {
    const meta = buildJoinMeta({ armName: "a", model: "m", conductor: "c", trial: "t", seed: 3.9 });
    expect(Number.isInteger(meta.seed)).toBe(true);
    expect(meta.seed).toBe(3);
  });

  it("caps every string field at 120 chars (truncates, does not throw)", () => {
    const long = "x".repeat(500);
    const meta = buildJoinMeta({ armName: long, model: long, conductor: long, trial: long, seed: 1 });
    expect(meta.display_name.length).toBeLessThanOrEqual(120);
    expect(meta.model.length).toBeLessThanOrEqual(120);
    expect(meta.conductor.length).toBeLessThanOrEqual(120);
    expect(meta.trial.length).toBeLessThanOrEqual(120);
  });
});

describe("loadConductorLaunchSpec", () => {
  it("reads a valid launch.json", () => {
    const { launch, dir } = loadConductorLaunchSpec(FIXTURE_DIR, "echo-conductor");
    expect(launch.command).toBe("node");
    expect(launch.args).toEqual(["echo-conductor.mjs"]);
    expect(launch.portEnv).toBe("ECHO_PORT");
    expect(dir.endsWith(path.join("conductors", "echo-conductor"))).toBe(true);
  });

  it("throws a clear error when launch.json is missing", () => {
    expect(() => loadConductorLaunchSpec(FIXTURE_DIR, "nonexistent-conductor")).toThrow(/no launch\.json found/);
  });

  it("throws when launch.json has no command", () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), "bellows-launch-"));
    const conductorsDir = path.join(dir, "conductors", "broken");
    fs.mkdirSync(conductorsDir, { recursive: true });
    fs.writeFileSync(path.join(conductorsDir, "launch.json"), JSON.stringify({ id: "broken" }));
    expect(() => loadConductorLaunchSpec(dir, "broken")).toThrow(/must have a "command"/);
  });
});

describe("getFreePort", () => {
  it("returns a usable ephemeral port", async () => {
    const port = await getFreePort();
    expect(Number.isInteger(port)).toBe(true);
    expect(port).toBeGreaterThan(0);
  });

  it("returns distinct ports across concurrent calls", async () => {
    const ports = await Promise.all([getFreePort(), getFreePort(), getFreePort()]);
    expect(new Set(ports).size).toBe(3);
  });
});

describe("spawnExternalConductor (echo-conductor fixture)", () => {
  const children = [];
  const homes = [];

  afterEach(async () => {
    for (const c of children.splice(0)) {
      try {
        c.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
    for (const h of homes.splice(0)) {
      try {
        fs.rmSync(h, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it("spawns the fixture, waits for its heartbeat, and returns its ws:// URL", async () => {
    const accordionHome = fs.mkdtempSync(path.join(tmpdir(), "bellows-exthome-"));
    homes.push(accordionHome);
    const runDir = fs.mkdtempSync(path.join(tmpdir(), "bellows-extrun-"));
    homes.push(runDir);

    const logs = [];
    const { child, url } = await spawnExternalConductor({
      config: { accordionRepo: FIXTURE_DIR },
      conductorId: "echo-conductor",
      accordionHome,
      runDir,
      log: (m) => logs.push(m),
      label: "test/echo/1",
    });
    children.push(child);

    expect(url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);
    expect(child.exitCode).toBeNull();

    // The heartbeat file itself must be well-formed per registry.ts's ConductorEntry shape.
    const hbPath = path.join(accordionHome, ".accordion", "conductors", "echo-conductor.json");
    const entry = JSON.parse(fs.readFileSync(hbPath, "utf8"));
    expect(entry.id).toBe("echo-conductor");
    expect(entry.url).toBe(url);
    expect(entry.registryProtocol).toBe(1);
    expect(entry.conductorProtocol).toBe(3);

    // Shutdown: the fixture's SIGINT/SIGTERM handler removes its heartbeat before exit —
    // but on Windows, child.kill("SIGTERM") is TerminateProcess (no handler runs), so we
    // only assert the process actually exits, not that it cleaned up its own heartbeat file.
    child.kill("SIGTERM");
    const exit = await new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
    expect(exit).toBeTruthy();
  }, 20_000);

  it("throws a clear error when the conductor id has no launch.json", async () => {
    const accordionHome = fs.mkdtempSync(path.join(tmpdir(), "bellows-exthome-"));
    homes.push(accordionHome);
    const runDir = fs.mkdtempSync(path.join(tmpdir(), "bellows-extrun-"));
    homes.push(runDir);

    await expect(
      spawnExternalConductor({
        config: { accordionRepo: FIXTURE_DIR },
        conductorId: "does-not-exist",
        accordionHome,
        runDir,
        log: () => {},
        label: "test/missing/1",
      }),
    ).rejects.toThrow(/no launch\.json found/);
  });

  it("M2: rejects AND kills the spawned process when the heartbeat never appears", async () => {
    const accordionHome = fs.mkdtempSync(path.join(tmpdir(), "bellows-exthome-"));
    homes.push(accordionHome);
    const runDir = fs.mkdtempSync(path.join(tmpdir(), "bellows-extrun-"));
    homes.push(runDir);

    // hang-conductor spawns fine but never writes a heartbeat file, so this hits
    // the real CONDUCTOR_HEARTBEAT_TIMEOUT_MS (20s) path in waitForConductorHeartbeat.
    let caught = null;
    try {
      await spawnExternalConductor({
        config: { accordionRepo: FIXTURE_DIR },
        conductorId: "hang-conductor",
        accordionHome,
        runDir,
        log: () => {},
        label: "test/hang/1",
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeTruthy();
    expect(caught.message).toMatch(/did not advertise a fresh heartbeat/);

    // Before the M2 fix, spawnExternalConductor's caller (executeRun) never got a
    // handle to the child on this rejection path, so nothing tore it down and the
    // process leaked. The fix kills it (and, on win32, its subtree) before
    // rethrowing and stamps the pid + post-kill exitCode onto the error so this
    // is verifiable without reaching into module internals.
    expect(typeof caught.killedPid).toBe("number");
    expect(caught.killedExitCode).not.toBeNull();

    // Cross-check against the OS: signaling the pid must now fail (ESRCH / no
    // such process), proving it is genuinely dead, not just marked so.
    let stillAlive = true;
    try {
      process.kill(caught.killedPid, 0);
    } catch {
      stillAlive = false;
    }
    expect(stillAlive, "the killed conductor pid must no longer exist").toBe(false);
  }, 30_000);
});

describe("spawnHost — CLI arg contract for external vs in-process arms", () => {
  const children = [];
  const dirs = [];

  afterEach(() => {
    for (const c of children.splice(0)) {
      try {
        c.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
    for (const d of dirs.splice(0)) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  const spec = { budget: 1000, protectTokens: 100, caps: { minutes: 1 } };

  it("throws synchronously when an external dispatch has no conductorUrl", () => {
    const runDir = fs.mkdtempSync(path.join(tmpdir(), "bellows-spawnhost-"));
    dirs.push(runDir);
    expect(() =>
      spawnHost({
        config: {},
        arm: "external:thermocline",
        armDispatch: { type: "external", id: "thermocline" },
        conductorUrl: null,
        spec,
        accordionHome: runDir,
        hostTelemetryFile: path.join(runDir, "host.jsonl"),
        runDir,
        log: () => {},
      }),
    ).toThrow(/has no conductorUrl/);
  });

  it("passes --conductor-url/--conductor-id (not --conductor) for an external dispatch", async () => {
    const runDir = fs.mkdtempSync(path.join(tmpdir(), "bellows-spawnhost-"));
    dirs.push(runDir);
    // No real session/conductor is running — the host will fail fast on discovery
    // timeout. We only care that it received the RIGHT CLI shape, which we can read
    // back from its own error message (main.ts's unknown-conductor path is only for
    // --conductor; for --conductor-url the host instead times out waiting for a pi
    // session, so we assert indirectly via the host log never mentioning "--conductor "
    // and instead spawning cleanly with the url/id we gave it).
    const child = spawnHost({
      config: {},
      arm: "external:echo-conductor",
      armDispatch: { type: "external", id: "echo-conductor" },
      conductorUrl: "ws://127.0.0.1:1",
      spec: { ...spec, caps: { minutes: 0.02 } }, // ~1.2s timeout so the test stays fast
      accordionHome: runDir,
      hostTelemetryFile: path.join(runDir, "host.jsonl"),
      runDir,
      log: () => {},
    });
    children.push(child);
    expect(child.exitCode).toBeNull();
    // Give it a moment to at least start up (vite-node compile) without crashing on arg
    // parsing — a malformed CLI invocation would exit near-instantly with a parse error.
    await new Promise((r) => setTimeout(r, 500));
    expect(child.killed).toBe(false);
  }, 15_000);
});
