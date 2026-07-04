import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PlatformClient } from "../platformClient.mjs";
import { StubPlatform } from "./stubPlatform.mjs";

const SECRET = "at_super_secret_key_do_not_leak";

describe("PlatformClient", () => {
  /** @type {StubPlatform} */
  let platform;
  let client;
  let logs;

  beforeEach(async () => {
    platform = new StubPlatform();
    await platform.listen();
    logs = [];
    client = new PlatformClient({ base: platform.url, apiKey: SECRET, log: (m) => logs.push(m) });
  });

  afterEach(async () => {
    await platform.close();
  });

  it("sends X-API-Key on claim and never logs it", async () => {
    platform.onClaim = () => ({ status: 200, body: { run: { id: "r1", trial: "t", name: "keel-1", config: {}, arm: { conductor: "keel" }, seed: 1 } } });
    const run = await client.claim({ worker: "w1", caps: ["in-process"], conductors: ["keel"] });
    expect(run.id).toBe("r1");
    expect(platform.requests[0].headers["x-api-key"]).toBe(SECRET);
    expect(logs.join("\n")).not.toContain(SECRET);
  });

  it("claim returns null on 204 (nothing to do)", async () => {
    platform.onClaim = () => ({ status: 204 });
    const run = await client.claim({ worker: "w1", caps: [], conductors: [] });
    expect(run).toBeNull();
  });

  it("claim throws a clear error on malformed response", async () => {
    platform.onClaim = () => ({ status: 200, body: { nope: true } });
    await expect(client.claim({ worker: "w1", caps: [], conductors: [] })).rejects.toThrow(/malformed/);
  });

  it("heartbeat returns cancel:true when the platform says so", async () => {
    platform.onHeartbeat = () => ({ status: 200, body: { cancel: true } });
    const r = await client.heartbeat("r1", "w1");
    expect(r.cancel).toBe(true);
    expect(platform.requests[0].body).toEqual({ worker: "w1" });
  });

  it("heartbeat surfaces a 409 as conflict without throwing", async () => {
    platform.onHeartbeat = () => ({ status: 409, body: { error: "reaped" } });
    const r = await client.heartbeat("r1", "w1");
    expect(r.conflict).toBe(true);
    expect(r.cancel).toBe(false);
  });

  it("sendEvents delivers a batch and caps it at 100 per call", async () => {
    const events = Array.from({ length: 150 }, (_, i) => ({ ts: i, type: "sync", data: {} }));
    const ok = await client.sendEvents("r1", "w1", events);
    expect(ok).toBe(true);
    expect(platform.requests[0].body.events.length).toBe(100);
  });

  it("sendEvents retries on 5xx then succeeds", async () => {
    let calls = 0;
    platform.onEvents = () => {
      calls++;
      if (calls < 2) return { status: 503, body: { error: "busy" } };
      return { status: 200, body: { ok: true } };
    };
    const ok = await client.sendEvents("r1", "w1", [{ ts: 1, type: "warn", data: {} }]);
    expect(ok).toBe(true);
    expect(calls).toBe(2);
  });

  it("sendEvents drops (returns false) after 3 failed attempts", async () => {
    platform.onEvents = () => ({ status: 500, body: { error: "down" } });
    const ok = await client.sendEvents("r1", "w1", [{ ts: 1, type: "warn", data: {} }]);
    expect(ok).toBe(false);
    expect(platform.requests.length).toBe(3);
  }, 15_000);

  it("sendEvents does not retry on 409", async () => {
    platform.onEvents = () => ({ status: 409, body: { error: "cancelled" } });
    const ok = await client.sendEvents("r1", "w1", [{ ts: 1, type: "warn", data: {} }]);
    expect(ok).toBe(false);
    expect(platform.requests.length).toBe(1);
  });

  it("complete retries on 5xx and eventually succeeds", async () => {
    let calls = 0;
    platform.onComplete = () => {
      calls++;
      if (calls < 3) return { status: 502, body: {} };
      return { status: 200, body: { ok: true } };
    };
    const ok = await client.complete("r1", { worker: "w1", status: "done", record: {} });
    expect(ok).toBe(true);
    expect(calls).toBe(3);
  }, 20_000);

  it("complete returns false (without throwing) on a 409", async () => {
    platform.onComplete = () => ({ status: 409, body: { error: "already completed" } });
    const ok = await client.complete("r1", { worker: "w1", status: "done", record: {} });
    expect(ok).toBe(false);
  });

  it("complete never includes the api key in a log line, even when rejected outright", async () => {
    // A non-5xx/429 rejection returns false immediately (no retry loop to leak).
    platform.onComplete = () => ({ status: 400, body: { error: "bad request" } });
    const ok = await client.complete("r1", { worker: "w1", status: "failed", record: {}, error: "x" });
    expect(ok).toBe(false);
    expect(logs.join("\n")).not.toContain(SECRET);
  });
});
