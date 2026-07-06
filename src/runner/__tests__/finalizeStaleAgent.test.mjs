import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { finalizeStaleAgent } from "../platform.mjs";

class StubActionApi {
  constructor(reply) {
    // `reply` can be a fixed { status, json } or a function (requestIndex) => { status, json }
    // so tests can script a sequence of responses (e.g. pending, pending, success).
    this.reply = reply;
    this.requests = [];
    this.server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const index = this.requests.length;
        this.requests.push({
          method: req.method,
          url: req.url,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"),
        });
        const reply = typeof this.reply === "function" ? this.reply(index) : this.reply;
        res.writeHead(reply.status || 200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(reply.json));
      });
    });
  }
  async listen() {
    await new Promise((r) => this.server.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${this.server.address().port}`;
  }
  async close() {
    await new Promise((r) => this.server.close(r));
  }
}

function makeWorkspace(session) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bellows-sweep-"));
  if (session) fs.writeFileSync(path.join(dir, ".slopcode_session.json"), JSON.stringify(session));
  return dir;
}

/** Records sleep calls without actually waiting, so grade-pending tests run instantly. */
function fakeSleep() {
  const calls = [];
  const fn = async (ms) => {
    calls.push(ms);
  };
  fn.calls = calls;
  return fn;
}

describe("finalizeStaleAgent", () => {
  let stub;
  const dirs = [];
  afterEach(async () => {
    if (stub) await stub.close();
    stub = undefined;
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it("finalizes on the agent's behalf from the workspace session file", async () => {
    stub = new StubActionApi({ json: { ok: true, data: { final: true } } });
    const base = await stub.listen();
    const ws = makeWorkspace({ agent_id: "agent-1", room_id: "room-9" });
    dirs.push(ws);
    const out = await finalizeStaleAgent({ base, apiKey: "k", workspaceDir: ws });
    expect(out).toBe("finalized");
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0].url).toBe("/rooms/room-9/action");
    expect(stub.requests[0].body).toEqual({ agent_id: "agent-1", command: "finalize" });
  });

  it("returns no-session when the agent never joined", async () => {
    const ws = makeWorkspace(null);
    dirs.push(ws);
    expect(await finalizeStaleAgent({ base: "http://127.0.0.1:1", apiKey: "k", workspaceDir: ws })).toBe(
      "no-session",
    );
  });

  it("returns failed (never throws) on network error", async () => {
    const ws = makeWorkspace({ agent_id: "agent-1", room_id: "room-9" });
    dirs.push(ws);
    expect(
      await finalizeStaleAgent({ base: "http://127.0.0.1:1", apiKey: "k", workspaceDir: ws }),
    ).toBe("failed");
  });

  it("returns failed immediately for a non-grade-pending 400 refusal (no retry loop)", async () => {
    stub = new StubActionApi({ json: { ok: false, code: "E_SOME_OTHER_ERROR" } });
    const base = await stub.listen();
    const ws = makeWorkspace({ agent_id: "agent-1", room_id: "room-9" });
    dirs.push(ws);
    const sleepFn = fakeSleep();
    const out = await finalizeStaleAgent({ base, apiKey: "k", workspaceDir: ws, sleepFn });
    expect(out).toBe("failed");
    expect(stub.requests).toHaveLength(1);
    expect(sleepFn.calls).toHaveLength(0);
  });

  it("polls through E_GRADE_PENDING and finalizes on the 3rd attempt", async () => {
    stub = new StubActionApi((index) =>
      index < 2
        ? { json: { ok: false, code: "E_GRADE_PENDING", error: "pending" } }
        : { json: { ok: true, data: { final: true } } },
    );
    const base = await stub.listen();
    const ws = makeWorkspace({ agent_id: "agent-1", room_id: "room-9" });
    dirs.push(ws);
    const sleepFn = fakeSleep();
    const out = await finalizeStaleAgent({
      base,
      apiKey: "k",
      workspaceDir: ws,
      sleepFn,
      gradePendingPollMs: 20_000,
      gradePendingBudgetMs: 240_000,
    });
    expect(out).toBe("finalized");
    expect(stub.requests).toHaveLength(3);
    // Two waits between the three attempts.
    expect(sleepFn.calls).toEqual([20_000, 20_000]);
  });

  it("gives up after the grade-pending budget and logs loudly with the room id", async () => {
    stub = new StubActionApi({ json: { ok: false, code: "E_GRADE_PENDING", error: "pending" } });
    const base = await stub.listen();
    const ws = makeWorkspace({ agent_id: "agent-1", room_id: "room-42" });
    dirs.push(ws);
    const sleepFn = fakeSleep();
    const logs = [];
    const out = await finalizeStaleAgent({
      base,
      apiKey: "k",
      workspaceDir: ws,
      sleepFn,
      gradePendingPollMs: 20_000,
      gradePendingBudgetMs: 60_000,
      log: (m) => logs.push(m),
    });
    expect(out).toBe("grade-pending-gave-up");
    // Budget 60s / poll 20s -> 3 retry sleeps before the deadline is exceeded.
    expect(sleepFn.calls).toEqual([20_000, 20_000, 20_000]);
    const retryLines = logs.filter((l) => l.includes("grade pending, retry"));
    expect(retryLines.length).toBeGreaterThan(0);
    const giveUpLine = logs.find((l) => l.includes("GIVING UP"));
    expect(giveUpLine).toBeTruthy();
    expect(giveUpLine).toContain("room-42");
  });
});
