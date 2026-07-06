import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { probeRoomJoinable } from "../platform.mjs";

/** Stub of GET /rooms/<id>/spectate; records every request it sees. */
class StubRoom {
  constructor(phase) {
    this.phase = phase;
    this.requests = [];
    this.server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        this.requests.push({ method: req.method, url: req.url });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ phase: this.phase, agents: {} }));
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

describe("probeRoomJoinable — read-only spectate probe", () => {
  let stub;
  afterEach(async () => {
    if (stub) await stub.close();
    stub = undefined;
  });

  it("is joinable only while the room phase is waiting", async () => {
    stub = new StubRoom("waiting");
    const base = await stub.listen();
    expect(await probeRoomJoinable({ base, apiKey: "k", roomId: "r1", probeName: "p" })).toBe(true);
  });

  it("reports an in-play room as not joinable", async () => {
    stub = new StubRoom("play");
    const base = await stub.listen();
    expect(await probeRoomJoinable({ base, apiKey: "k", roomId: "r1", probeName: "p" })).toBe(false);
  });

  it("NEVER registers — the probe must not consume the room's reset", async () => {
    stub = new StubRoom("waiting");
    const base = await stub.listen();
    await probeRoomJoinable({ base, apiKey: "k", roomId: "r1", probeName: "p" });
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0].method).toBe("GET");
    expect(stub.requests[0].url).toContain("/spectate");
    expect(stub.requests.some((r) => r.url.includes("/register"))).toBe(false);
  });

  it("returns false on network failure instead of throwing", async () => {
    expect(
      await probeRoomJoinable({ base: "http://127.0.0.1:1", apiKey: "k", roomId: "r1", probeName: "p" }),
    ).toBe(false);
  });
});
