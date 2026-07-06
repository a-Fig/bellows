import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { RoomPool } from "../schedule.mjs";

/**
 * Tiny in-test HTTP stub of POST /api/rooms, mirroring the style of
 * src/worker/__tests__/stubPlatform.mjs (a scripted handler + a request log)
 * but scoped to just this one endpoint since RoomPool.lease() is the only
 * thing under test here.
 *
 * NOTE: these body assertions previously pinned the flattened (bug) shape —
 * { game_type, auto_archive, problem_set/problems } sent verbatim as the
 * whole POST body — which is how the createRoom envelope bug shipped
 * unnoticed: the platform reads game_type from the top level but the room
 * config from a nested `config` key, so every field except game_type was
 * silently dropped server-side. Now asserts the corrected envelope
 * { game_type, config: { ... } }.
 */
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
      const body = raw ? JSON.parse(raw) : undefined;
      this.requests.push({ method: req.method, url: req.url, body });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ room_id: "room-xyz" }));
    });
  }
}

describe("RoomPool.lease — createRoom receives the derived roomConfig", () => {
  let stub;
  afterEach(async () => {
    if (stub) await stub.close();
    stub = undefined;
  });

  it("passes slopcodeRoomConfig(problems) through to POST /api/rooms", async () => {
    stub = new StubRoomsApi();
    const base = await stub.listen();

    const pool = new RoomPool({
      pool: [],
      create: true,
      base,
      apiKey: "k",
      problems: "easy-1",
      log: () => {},
    });

    const roomId = await pool.lease();
    expect(roomId).toBe("room-xyz");
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0].url).toBe("/api/rooms");
    expect(stub.requests[0].body).toEqual({
      game_type: "slopcode",
      config: { auto_archive: true, problem_set: "easy-1" },
    });
  });

  it("an explicit problem-name array is passed through as { problems: [...] }", async () => {
    stub = new StubRoomsApi();
    const base = await stub.listen();

    const pool = new RoomPool({
      pool: [],
      create: true,
      base,
      apiKey: "k",
      problems: ["xjq", "abc"],
      log: () => {},
    });

    await pool.lease();
    expect(stub.requests[0].body).toEqual({
      game_type: "slopcode",
      config: { auto_archive: true, problems: ["xjq", "abc"] },
    });
  });

  it("no problems (undefined) -> full-bench roomConfig, matching today's default", async () => {
    stub = new StubRoomsApi();
    const base = await stub.listen();

    const pool = new RoomPool({ pool: [], create: true, base, apiKey: "k", log: () => {} });
    await pool.lease();
    expect(stub.requests[0].body).toEqual({ game_type: "slopcode", config: { auto_archive: true } });
  });

  it("logs the derived leaderboard bucket before creating the room", async () => {
    stub = new StubRoomsApi();
    const base = await stub.listen();
    const logs = [];

    const pool = new RoomPool({
      pool: [],
      create: true,
      base,
      apiKey: "k",
      problems: "medium",
      log: (m) => logs.push(m),
    });
    await pool.lease();

    expect(logs.some((m) => m.includes("problem_set=medium"))).toBe(true);
  });
});
