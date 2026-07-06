import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { finalizeStaleAgent } from "../platform.mjs";

class StubActionApi {
  constructor(reply) {
    this.reply = reply;
    this.requests = [];
    this.server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        this.requests.push({
          method: req.method,
          url: req.url,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"),
        });
        res.writeHead(this.reply.status || 200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(this.reply.json));
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

  it("returns failed when the platform refuses (e.g. grade pending)", async () => {
    stub = new StubActionApi({ json: { ok: false, code: "E_GRADE_PENDING" } });
    const base = await stub.listen();
    const ws = makeWorkspace({ agent_id: "agent-1", room_id: "room-9" });
    dirs.push(ws);
    expect(await finalizeStaleAgent({ base, apiKey: "k", workspaceDir: ws })).toBe("failed");
  });

  it("returns failed (never throws) on network error", async () => {
    const ws = makeWorkspace({ agent_id: "agent-1", room_id: "room-9" });
    dirs.push(ws);
    expect(
      await finalizeStaleAgent({ base: "http://127.0.0.1:1", apiKey: "k", workspaceDir: ws }),
    ).toBe("failed");
  });
});
