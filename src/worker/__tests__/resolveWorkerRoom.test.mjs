import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { resolveWorkerRoom } from "../loop.mjs";

/** Same tiny POST /api/rooms stub style as src/runner/__tests__/schedule.test.mjs. */
class StubRoomsApi {
  constructor() {
    this.requests = [];
    this.server = http.createServer((req, res) => this._handle(req, res));
  }
  async listen() {
    await new Promise((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const { port } = this.server.address();
    this.url = `http://127.0.0.1:${port}`;
    return this.url;
  }
  async close() {
    await new Promise((resolve) => this.server.close(resolve));
  }
  _handle(req, res) {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      this.requests.push({ method: req.method, url: req.url, body: raw ? JSON.parse(raw) : undefined });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ room_id: "room-created" }));
    });
  }
}

describe("resolveWorkerRoom", () => {
  let stub;
  afterEach(async () => {
    if (stub) await stub.close();
    stub = undefined;
  });

  it("prefers a pooled room and makes no network call", async () => {
    const roomId = await resolveWorkerRoom({
      spec: { room: { pool: ["pooled-room"], create: true } },
      config: { platformBase: "http://127.0.0.1:1" },
      apiKey: "k",
      log: () => {},
    });
    expect(roomId).toBe("pooled-room");
  });

  it("creates a room with the derived problem_set when room.create is set", async () => {
    stub = new StubRoomsApi();
    const base = await stub.listen();
    const logs = [];
    const roomId = await resolveWorkerRoom({
      spec: { problems: "easy-1", room: { create: true } },
      config: { platformBase: base },
      apiKey: "k",
      log: (m) => logs.push(m),
    });
    expect(roomId).toBe("room-created");
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0].url).toBe("/api/rooms");
    expect(stub.requests[0].body).toEqual({ game_type: "slopcode", problem_set: "easy-1" });
    expect(logs.some((m) => m.includes("problem_set=easy-1"))).toBe(true);
  });

  it("honors spec.room.base over config.platformBase", async () => {
    stub = new StubRoomsApi();
    const base = await stub.listen();
    const roomId = await resolveWorkerRoom({
      spec: { problems: ["xjq"], room: { create: true, base } },
      config: { platformBase: "http://127.0.0.1:1" },
      apiKey: "k",
      log: () => {},
    });
    expect(roomId).toBe("room-created");
    expect(stub.requests[0].body).toEqual({ game_type: "slopcode", problems: ["xjq"] });
  });

  it("throws loudly when there is neither a pool nor room.create", async () => {
    await expect(
      resolveWorkerRoom({
        spec: { room: {} },
        config: { platformBase: "http://127.0.0.1:1" },
        apiKey: "k",
        log: () => {},
      }),
    ).rejects.toThrow(/no room/);
  });
});
