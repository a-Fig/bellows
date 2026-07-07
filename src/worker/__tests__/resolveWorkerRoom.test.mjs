import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { resolveWorkerRoom } from "../loop.mjs";

/**
 * Same tiny POST /api/rooms stub style as src/runner/__tests__/schedule.test.mjs.
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

  it("prefers a pooled room once it probes joinable", async () => {
    const probed = [];
    const roomId = await resolveWorkerRoom({
      spec: { room: { pool: ["pooled-room"], create: true } },
      config: { platformBase: "http://127.0.0.1:1" },
      apiKey: "k",
      log: () => {},
      probeFn: async ({ roomId }) => {
        probed.push(roomId);
        return true;
      },
      sleepFn: async () => {},
    });
    expect(roomId).toBe("pooled-room");
    expect(probed).toEqual(["pooled-room"]);
  });

  it("rejects a pooled room + problem-scoped spec BEFORE any join/probe (worker-path mis-scoping guard)", async () => {
    // Claimed (platform-dispatched) specs never pass through validateTrialSpec —
    // this is the worker-path twin of that guard. The throw happens inside
    // defaultExecutor before executeRun, and executeClaimedRun folds any executor
    // throw into a failed complete() carrying the message (covered by
    // loop.test.mjs "an executor throw is caught, folded into a failed
    // complete(), and the loop keeps going").
    const probed = [];
    await expect(
      resolveWorkerRoom({
        spec: { problems: "easy-1", room: { pool: ["pooled-room"] } },
        config: { platformBase: "http://127.0.0.1:1" },
        apiKey: "k",
        log: () => {},
        probeFn: async ({ roomId }) => {
          probed.push(roomId);
          return true;
        },
        sleepFn: async () => {},
      }),
    ).rejects.toThrow(/pooled rooms carry the problem set/);
    expect(probed).toEqual([]); // guard fires before any room join/probe is attempted
  });

  it("rejects a pooled room + explicit problem-name list likewise", async () => {
    await expect(
      resolveWorkerRoom({
        spec: { problems: ["xjq"], room: { pool: ["pooled-room"] } },
        config: { platformBase: "http://127.0.0.1:1" },
        apiKey: "k",
        log: () => {},
        probeFn: async () => true,
        sleepFn: async () => {},
      }),
    ).rejects.toThrow(/room\.pool \+ a problem-scoped/);
  });

  it("a pooled room + full-bench problems (`all`) still proceeds", async () => {
    const probed = [];
    const roomId = await resolveWorkerRoom({
      spec: { problems: "all", room: { pool: ["pooled-room"] } },
      config: { platformBase: "http://127.0.0.1:1" },
      apiKey: "k",
      log: () => {},
      probeFn: async ({ roomId }) => {
        probed.push(roomId);
        return true;
      },
      sleepFn: async () => {},
    });
    expect(roomId).toBe("pooled-room");
    expect(probed).toEqual(["pooled-room"]);
  });

  it("waits out a not-yet-reset pooled room and succeeds when the probe recovers", async () => {
    let calls = 0;
    const sleeps = [];
    const roomId = await resolveWorkerRoom({
      spec: { room: { pool: ["pooled-room"] } },
      config: { platformBase: "http://127.0.0.1:1" },
      apiKey: "k",
      log: () => {},
      probeFn: async () => ++calls >= 3,
      sleepFn: async (ms) => sleeps.push(ms),
    });
    expect(roomId).toBe("pooled-room");
    expect(calls).toBe(3);
    expect(sleeps).toEqual([15_000, 30_000]);
  });

  it("throws loudly when the pooled room never becomes joinable", async () => {
    let calls = 0;
    await expect(
      resolveWorkerRoom({
        spec: { room: { pool: ["dead-room"] } },
        config: { platformBase: "http://127.0.0.1:1" },
        apiKey: "k",
        log: () => {},
        probeFn: async () => {
          calls++;
          return false;
        },
        sleepFn: async () => {},
      }),
    ).rejects.toThrow(/never became joinable/);
    expect(calls).toBe(7);
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
    expect(stub.requests[0].body).toEqual({
      game_type: "slopcode",
      config: { auto_archive: true, problem_set: "easy-1" },
    });
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
    expect(stub.requests[0].body).toEqual({
      game_type: "slopcode",
      config: { auto_archive: true, problems: ["xjq"] },
    });
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
