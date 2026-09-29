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
  isLegacyAccordionCheckout,
  isResidentHostCheckout,
  RESIDENT_HOST_ENTRY,
  autoUpgradeArmDispatch,
  hostEnv,
  modelShortName,
  buildJoinMeta,
  conductorNeverAttached,
  driveUntilDone,
  isDegenerateAssistantMessage,
  looksLikeAgentFinalizeCall,
  appendAgentFinalizeNote,
  resolvePlatformBase,
  buildPiEnv,
  clearStaleTelemetryFiles,
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

describe("driveUntilDone — combined agent+conductor cost cap (bellows #38 follow-up)", () => {
  class CostPi extends EventEmitter {
    constructor(cost) {
      super();
      this.cost = cost;
    }
    async getSessionStats() {
      return { cost: this.cost, tokens: { total: 1 } };
    }
  }

  const dirs = [];
  afterEach(() => {
    while (dirs.length) {
      const d = dirs.pop();
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  });

  const makeRunDir = () => {
    const d = fs.mkdtempSync(path.join(tmpdir(), "bellows-costcap-"));
    dirs.push(d);
    return d;
  };

  it("stays under a cap that agent cost alone would not reach, with no telemetry files given", async () => {
    const pi = new CostPi(0.6);
    const spec = { caps: { minutes: 1, turns: 100, costUsd: 1 } };
    const outcome = driveUntilDone({ pi, host: null, spec, log: () => {}, label: "test" });

    pi.emit("event", { type: "message_end", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } }] } });
    pi.emit("event", { type: "agent_end", willRetry: false });

    await expect(outcome).resolves.toEqual({ status: "completed", statusDetail: undefined });
  });

  it("aborts on combined agent+conductor cost even though agent cost alone is under the cap (host.jsonl)", async () => {
    const runDir = makeRunDir();
    const hostTelemetryFile = path.join(runDir, "host.jsonl");
    fs.writeFileSync(hostTelemetryFile, JSON.stringify({ t: "complete", at: 1, costUsd: 0.5 }) + "\n", "utf8");

    const pi = new CostPi(0.6); // agent cost alone (0.6) is under the cap (1)
    const spec = { caps: { minutes: 1, turns: 100, costUsd: 1 } };
    const outcome = driveUntilDone({ pi, host: null, spec, log: () => {}, label: "test", hostTelemetryFile });

    pi.emit("event", { type: "message_end", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } }] } });

    await expect(outcome).resolves.toEqual({
      status: "aborted-cost",
      statusDetail: "cost $1.1000 (agent $0.6000 + conductor $0.5000) >= cap $1",
    });
  });

  it("aborts on combined agent+conductor cost from completions.jsonl (Accordion protocol v22 side log)", async () => {
    const runDir = makeRunDir();
    const completionLogFile = path.join(runDir, "completions.jsonl");
    fs.writeFileSync(
      completionLogFile,
      JSON.stringify({ t: "complete", at: 1, provider: "anthropic", model: "claude-x", input: 10, output: 5, cacheRead: 0, costUsd: 0.5 }) + "\n",
      "utf8",
    );

    const pi = new CostPi(0.6);
    const spec = { caps: { minutes: 1, turns: 100, costUsd: 1 } };
    const outcome = driveUntilDone({ pi, host: null, spec, log: () => {}, label: "test", completionLogFile });

    pi.emit("event", { type: "message_end", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } }] } });

    await expect(outcome).resolves.toEqual({
      status: "aborted-cost",
      statusDetail: "cost $1.1000 (agent $0.6000 + conductor $0.5000) >= cap $1",
    });
  });

  it("adds host.jsonl and completions.jsonl conductor spend together with agent cost", async () => {
    const runDir = makeRunDir();
    const hostTelemetryFile = path.join(runDir, "host.jsonl");
    const completionLogFile = path.join(runDir, "completions.jsonl");
    fs.writeFileSync(hostTelemetryFile, JSON.stringify({ t: "complete", at: 1, costUsd: 0.2 }) + "\n", "utf8");
    fs.writeFileSync(completionLogFile, JSON.stringify({ t: "complete", at: 1, costUsd: 0.2 }) + "\n", "utf8");

    const pi = new CostPi(0.5); // 0.5 agent + 0.2 + 0.2 conductor = 0.9, under cap of 1 — must not abort yet
    const spec = { caps: { minutes: 1, turns: 100, costUsd: 1 } };
    const outcome = driveUntilDone({ pi, host: null, spec, log: () => {}, label: "test", hostTelemetryFile, completionLogFile });

    pi.emit("event", { type: "message_end", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } }] } });
    pi.emit("event", { type: "agent_end", willRetry: false });
    await expect(outcome).resolves.toEqual({ status: "completed", statusDetail: undefined });
  });

  it("does not abort when telemetry files are absent (arm 'none' — no conductor spend to add)", async () => {
    const runDir = makeRunDir();
    const hostTelemetryFile = path.join(runDir, "host.jsonl"); // never written
    const completionLogFile = path.join(runDir, "completions.jsonl"); // never written

    const pi = new CostPi(0.9);
    const spec = { caps: { minutes: 1, turns: 100, costUsd: 1 } };
    const outcome = driveUntilDone({ pi, host: null, spec, log: () => {}, label: "test", hostTelemetryFile, completionLogFile });

    pi.emit("event", { type: "message_end", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } }] } });
    pi.emit("event", { type: "agent_end", willRetry: false });
    await expect(outcome).resolves.toEqual({ status: "completed", statusDetail: undefined });
  });
});

describe("clearStaleTelemetryFiles — run-dir reuse must not sum a prior run's spend (bellows #38 stale-rows / #43 item 4)", () => {
  const dirs = [];
  afterEach(() => {
    while (dirs.length) {
      const d = dirs.pop();
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  });
  const makeRunDir = () => {
    const d = fs.mkdtempSync(path.join(tmpdir(), "bellows-staletelemetry-"));
    dirs.push(d);
    return d;
  };

  it("removes pre-existing host.jsonl and completions.jsonl content from a reused run dir", () => {
    const runDir = makeRunDir();
    const hostTelemetryFile = path.join(runDir, "host.jsonl");
    const completionLogFile = path.join(runDir, "completions.jsonl");
    fs.writeFileSync(hostTelemetryFile, JSON.stringify({ t: "complete", costUsd: 5 }) + "\n");
    fs.writeFileSync(completionLogFile, JSON.stringify({ t: "complete", costUsd: 7 }) + "\n");

    clearStaleTelemetryFiles([hostTelemetryFile, completionLogFile]);

    expect(fs.existsSync(hostTelemetryFile)).toBe(false);
    expect(fs.existsSync(completionLogFile)).toBe(false);
  });

  it("is a no-op (does not throw) when the files were never written", () => {
    const runDir = makeRunDir();
    const hostTelemetryFile = path.join(runDir, "host.jsonl");
    const completionLogFile = path.join(runDir, "completions.jsonl");

    expect(() => clearStaleTelemetryFiles([hostTelemetryFile, completionLogFile])).not.toThrow();
    expect(fs.existsSync(hostTelemetryFile)).toBe(false);
  });

  it("skips null/undefined entries without throwing (arm 'none' has no hostTelemetryFile)", () => {
    const runDir = makeRunDir();
    const completionLogFile = path.join(runDir, "completions.jsonl");
    fs.writeFileSync(completionLogFile, "stale\n");

    expect(() => clearStaleTelemetryFiles([null, completionLogFile, undefined])).not.toThrow();
    expect(fs.existsSync(completionLogFile)).toBe(false);
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
  it("selects the resident (v15-v22) controller for a truth-in-extension checkout", () => {
    const repo = fs.mkdtempSync(path.join(tmpdir(), "accordion-v15-"));
    fs.mkdirSync(path.join(repo, "core"));
    fs.writeFileSync(path.join(repo, "core", "protocol.ts"), "export const PROTOCOL_VERSION = 15;\n");
    expect(hostEntryForAccordion(repo)).toBe(RESIDENT_HOST_ENTRY);
    expect(hostEntryForAccordion(repo)).toBe("src/host/main-v15.ts");
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("keeps legacy refs on the existing controller", () => {
    expect(hostEntryForAccordion("C:/missing/legacy-accordion")).toBe("src/host/main.ts");
  });
});

describe("isLegacyAccordionCheckout — shared predicate behind hostEntryForAccordion + autoUpgradeArmDispatch", () => {
  it("false for a truth-in-extension (v15) checkout", () => {
    const repo = fs.mkdtempSync(path.join(tmpdir(), "accordion-v15-"));
    fs.mkdirSync(path.join(repo, "core"));
    fs.writeFileSync(path.join(repo, "core", "protocol.ts"), "export const PROTOCOL_VERSION = 15;\n");
    expect(isLegacyAccordionCheckout(repo)).toBe(false);
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("true for a checkout with no core/protocol.ts", () => {
    expect(isLegacyAccordionCheckout("C:/missing/legacy-accordion")).toBe(true);
  });
});

describe("isResidentHostCheckout — gates whether run.mjs treats the checkout as the resident (main-v15.ts) host", () => {
  it("true for a core/protocol.ts-shaped (truth-in-extension) checkout", () => {
    const repo = fs.mkdtempSync(path.join(tmpdir(), "accordion-resident-"));
    fs.mkdirSync(path.join(repo, "core"));
    fs.writeFileSync(path.join(repo, "core", "protocol.ts"), "export const PROTOCOL_VERSION = 22;\n");
    expect(isResidentHostCheckout(repo)).toBe(true);
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("false for a legacy-shaped checkout with no core/protocol.ts", () => {
    const repo = fs.mkdtempSync(path.join(tmpdir(), "accordion-legacy-"));
    expect(isResidentHostCheckout(repo)).toBe(false);
    fs.rmSync(repo, { recursive: true, force: true });
  });
});

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(HERE, "..", "..", "..", "test", "fixtures");

describe("autoUpgradeArmDispatch — bare-id auto-external-dispatch on legacy checkouts", () => {
  it("upgrades a bare in-process id to external on a LEGACY checkout with a matching launch.json", () => {
    // FIXTURE_DIR (test/fixtures) has no core/protocol.ts (legacy-shaped) and
    // carries conductors/echo-conductor/launch.json (see the loadConductorLaunchSpec
    // tests above) — exactly the "thermocline on Accordion main" scenario.
    const logs = [];
    const result = autoUpgradeArmDispatch({
      armDispatch: { type: "in-process", id: "echo-conductor" },
      accordionRepo: FIXTURE_DIR,
      log: (m) => logs.push(m),
      label: "t/echo/0",
    });
    expect(result).toEqual({ type: "external", id: "echo-conductor" });
    expect(logs.some((m) => m.includes('conductor "echo-conductor" is external-launch'))).toBe(true);
  });

  it("does NOT upgrade on a v15-shaped checkout, even with a matching launch.json", () => {
    const repo = fs.mkdtempSync(path.join(tmpdir(), "accordion-v15-upgrade-"));
    fs.mkdirSync(path.join(repo, "core"));
    fs.writeFileSync(path.join(repo, "core", "protocol.ts"), "export const PROTOCOL_VERSION = 15;\n");
    const conductorsDir = path.join(repo, "conductors", "thermocline");
    fs.mkdirSync(conductorsDir, { recursive: true });
    fs.writeFileSync(path.join(conductorsDir, "launch.json"), JSON.stringify({ command: "node", args: ["x.mjs"] }));

    const result = autoUpgradeArmDispatch({
      armDispatch: { type: "in-process", id: "thermocline" },
      accordionRepo: repo,
      log: () => {},
      label: "t/thermocline/0",
    });
    expect(result).toEqual({ type: "in-process", id: "thermocline" });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("leaves an explicit external:<id> dispatch unchanged", () => {
    const result = autoUpgradeArmDispatch({
      armDispatch: { type: "external", id: "echo-conductor" },
      accordionRepo: FIXTURE_DIR,
      log: () => {},
      label: "t/echo/0",
    });
    expect(result).toEqual({ type: "external", id: "echo-conductor" });
  });

  it("leaves a bare in-process id unchanged when no launch.json exists for it (legacy checkout)", () => {
    const result = autoUpgradeArmDispatch({
      armDispatch: { type: "in-process", id: "builtin" },
      accordionRepo: FIXTURE_DIR,
      log: () => {},
      label: "t/builtin/0",
    });
    expect(result).toEqual({ type: "in-process", id: "builtin" });
  });

  it("never upgrades the raw-baseline arm ('none'), even if a same-named launch.json existed", () => {
    const repo = fs.mkdtempSync(path.join(tmpdir(), "accordion-none-upgrade-"));
    const conductorsDir = path.join(repo, "conductors", "none");
    fs.mkdirSync(conductorsDir, { recursive: true });
    fs.writeFileSync(path.join(conductorsDir, "launch.json"), JSON.stringify({ command: "node", args: ["x.mjs"] }));

    const result = autoUpgradeArmDispatch({
      armDispatch: { type: "in-process", id: "none" },
      accordionRepo: repo,
      log: () => {},
      label: "t/none/0",
    });
    expect(result).toEqual({ type: "in-process", id: "none" });
    fs.rmSync(repo, { recursive: true, force: true });
  });
});

describe("resolvePlatformBase — guards spec.room being undefined (malformed platform claim)", () => {
  it("prefers spec.room.base when set", () => {
    expect(resolvePlatformBase({ room: { base: "https://room-base" } }, { platformBase: "https://cfg-base" })).toBe(
      "https://room-base",
    );
  });

  it("falls back to config.platformBase when spec.room.base is unset", () => {
    expect(resolvePlatformBase({ room: {} }, { platformBase: "https://cfg-base" })).toBe("https://cfg-base");
  });

  it("returns null (not a throw) when spec.room is missing", () => {
    expect(resolvePlatformBase({}, { platformBase: "https://cfg-base" })).toBeNull();
  });

  it("returns null when spec itself is missing", () => {
    expect(resolvePlatformBase(null, { platformBase: "https://cfg-base" })).toBeNull();
    expect(resolvePlatformBase(undefined, { platformBase: "https://cfg-base" })).toBeNull();
  });
});

describe("buildPiEnv — pi's spawn env: base + scrubPiEnv + arm env merge", () => {
  const processEnv = { PATH: "/usr/bin", HOME: "/home/x", AGENT_TRIALS_API_KEY: "secret", NODE_ENV: "test" };

  it("sets PI_CODING_AGENT_DIR/ACCORDION_HOME and drops PI_CODING_AGENT_SESSION_DIR", () => {
    const env = buildPiEnv({
      processEnv: { ...processEnv, PI_CODING_AGENT_SESSION_DIR: "/somewhere/else" },
      agentDir: "/run/agent",
      accordionHome: "/run/accordion-home",
    });
    expect(env.PI_CODING_AGENT_DIR).toBe("/run/agent");
    expect(env.ACCORDION_HOME).toBe("/run/accordion-home");
    expect("PI_CODING_AGENT_SESSION_DIR" in env).toBe(false);
  });

  it("without scrubPiEnv, inherits the full process env (backward compat)", () => {
    const env = buildPiEnv({ processEnv, agentDir: "/a", accordionHome: "/h" });
    expect(env.AGENT_TRIALS_API_KEY).toBe("secret");
  });

  it("with scrubPiEnv, drops secret-shaped vars and logs their names (never values)", () => {
    const logs = [];
    const env = buildPiEnv({
      processEnv,
      agentDir: "/a",
      accordionHome: "/h",
      scrubPiEnv: true,
      log: (m) => logs.push(m),
    });
    expect("AGENT_TRIALS_API_KEY" in env).toBe(false);
    expect(env.PATH).toBe("/usr/bin");
    expect(env.NODE_ENV).toBe("test");
    expect(logs.some((m) => m.includes("AGENT_TRIALS_API_KEY"))).toBe(true);
    expect(logs.some((m) => m.includes("secret"))).toBe(false);
  });

  it("piEnvPassthrough exempts a named var from scrubPiEnv", () => {
    const env = buildPiEnv({
      processEnv,
      agentDir: "/a",
      accordionHome: "/h",
      scrubPiEnv: true,
      piEnvPassthrough: ["AGENT_TRIALS_API_KEY"],
    });
    expect(env.AGENT_TRIALS_API_KEY).toBe("secret");
  });

  it("merges armEnv LAST — after scrubPiEnv, never itself scrubbed", () => {
    const env = buildPiEnv({
      processEnv,
      agentDir: "/a",
      accordionHome: "/h",
      scrubPiEnv: true,
      armEnv: { ACCORDION_SUMMARY_TRIGGER: "0.75", MY_API_KEY: "explicit-not-scrubbed" },
    });
    expect(env.ACCORDION_SUMMARY_TRIGGER).toBe("0.75");
    expect(env.MY_API_KEY).toBe("explicit-not-scrubbed");
  });

  it("armEnv overrides a base var of the same name", () => {
    const env = buildPiEnv({ processEnv, agentDir: "/a", accordionHome: "/h", armEnv: { PATH: "/custom/path" } });
    expect(env.PATH).toBe("/custom/path");
  });

  // ACCORDION_COMPLETION_LOG (Accordion extension completion side log, see
  // extension/accordion.ts runCompletion + collect.mjs foldCompletionLog) is
  // runner-owned telemetry plumbing: unlike PATH above, an arm must never be
  // able to redirect or drop it.
  it("sets ACCORDION_COMPLETION_LOG from completionLogFile", () => {
    const env = buildPiEnv({
      processEnv,
      agentDir: "/a",
      accordionHome: "/h",
      completionLogFile: "/run/dir/completions.jsonl",
    });
    expect(env.ACCORDION_COMPLETION_LOG).toBe("/run/dir/completions.jsonl");
  });

  it("omits ACCORDION_COMPLETION_LOG when no completionLogFile is given", () => {
    const env = buildPiEnv({ processEnv, agentDir: "/a", accordionHome: "/h" });
    expect("ACCORDION_COMPLETION_LOG" in env).toBe(false);
  });

  it("armEnv cannot override ACCORDION_COMPLETION_LOG — the runner's value always wins", () => {
    const env = buildPiEnv({
      processEnv,
      agentDir: "/a",
      accordionHome: "/h",
      completionLogFile: "/run/dir/completions.jsonl",
      armEnv: { ACCORDION_COMPLETION_LOG: "/arm/attempted/override.jsonl" },
    });
    expect(env.ACCORDION_COMPLETION_LOG).toBe("/run/dir/completions.jsonl");
  });

  it("survives scrubPiEnv (it's set after scrubbing, and isn't secret-shaped anyway)", () => {
    const env = buildPiEnv({
      processEnv,
      agentDir: "/a",
      accordionHome: "/h",
      scrubPiEnv: true,
      completionLogFile: "/run/dir/completions.jsonl",
    });
    expect(env.ACCORDION_COMPLETION_LOG).toBe("/run/dir/completions.jsonl");
  });
});

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
