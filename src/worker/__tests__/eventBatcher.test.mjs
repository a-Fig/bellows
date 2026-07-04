import { describe, it, expect, vi, afterEach } from "vitest";
import { EventBatcher } from "../eventBatcher.mjs";

function fakeClient() {
  const calls = [];
  return {
    calls,
    sendEvents: vi.fn(async (runId, worker, events) => {
      calls.push({ runId, worker, events });
      return true;
    }),
  };
}

/** A fakeClient whose sendEvents doesn't resolve until you call resolveAll(). */
function controlledClient() {
  const calls = [];
  const pending = [];
  return {
    calls,
    sendEvents: vi.fn((runId, worker, events) => {
      calls.push({ runId, worker, events });
      return new Promise((resolve) => pending.push(() => resolve(true)));
    }),
    resolveAll() {
      const toResolve = pending.splice(0);
      for (const r of toResolve) r();
    },
  };
}

describe("EventBatcher", () => {
  /** @type {EventBatcher[]} */
  const batchers = [];
  afterEach(async () => {
    for (const b of batchers.splice(0)) await b.drain();
  });

  it("flushes at the count threshold without waiting for the timer", async () => {
    const client = fakeClient();
    const b = new EventBatcher({ client, runId: "r1", worker: "w1", flushCount: 3, flushIntervalMs: 60_000 });
    batchers.push(b);
    b.push("sync", { a: 1 });
    b.push("sync", { a: 2 });
    b.push("sync", { a: 3 }); // hits flushCount -> triggers a flush
    await vi.waitFor(() => expect(client.calls.length).toBeGreaterThan(0));
    expect(client.calls[0].events.length).toBe(3);
  });

  it("flushes on the interval timer", async () => {
    const client = fakeClient();
    const b = new EventBatcher({ client, runId: "r1", worker: "w1", flushCount: 1000, flushIntervalMs: 30 });
    batchers.push(b);
    b.push("warn", { message: "x" });
    await vi.waitFor(() => expect(client.calls.length).toBeGreaterThan(0), { timeout: 2000 });
    expect(client.calls[0].events[0].type).toBe("warn");
  });

  it("drain() flushes whatever remains and stops the timer", async () => {
    const client = fakeClient();
    const b = new EventBatcher({ client, runId: "r1", worker: "w1", flushCount: 1000, flushIntervalMs: 60_000 });
    b.push("checkpoint", { n: 1 });
    b.push("checkpoint", { n: 2 });
    await b.drain();
    expect(client.calls.length).toBe(1);
    expect(client.calls[0].events.length).toBe(2);
  });

  it("splits a flush larger than 100 into sequential sendEvents calls", async () => {
    const client = fakeClient();
    const b = new EventBatcher({ client, runId: "r1", worker: "w1", flushCount: 1000, flushIntervalMs: 60_000 });
    for (let i = 0; i < 250; i++) b.push("sync", { i });
    await b.drain();
    expect(client.calls.length).toBe(3); // 100 + 100 + 50
    expect(client.calls[0].events.length).toBe(100);
    expect(client.calls[1].events.length).toBe(100);
    expect(client.calls[2].events.length).toBe(50);
  });

  it("counts drops when sendEvents fails", async () => {
    const client = { sendEvents: vi.fn(async () => false) };
    const b = new EventBatcher({ client, runId: "r1", worker: "w1", flushCount: 1000, flushIntervalMs: 60_000 });
    b.push("warn", {});
    b.push("warn", {});
    await b.drain();
    expect(b.dropCount).toBe(2);
    expect(b.sentCount).toBe(0);
  });

  describe("m6: drain() flushes events queued while a prior flush was still in-flight (adversarial review)", () => {
    it("does not strand a push() that races an in-flight flush", async () => {
      const client = controlledClient();
      const b = new EventBatcher({ client, runId: "r1", worker: "w1", flushCount: 1000, flushIntervalMs: 60_000 });

      b.push("sync", { a: 1 });
      const flushPromise = b.flush(); // starts sending {a:1}; sendEvents won't resolve until we call resolveAll()
      await vi.waitFor(() => expect(client.sendEvents).toHaveBeenCalledTimes(1));

      // Race condition window: push more events WHILE the first flush is still in-flight.
      b.push("sync", { a: 2 });

      const drainPromise = b.drain();
      // Let the first (in-flight) send complete now that drain() is waiting on it.
      client.resolveAll();
      await flushPromise;
      // drain()'s loop should now see the queued {a:2} and send it too, rather
      // than returning as soon as the first in-flight flush settled.
      await vi.waitFor(() => expect(client.sendEvents).toHaveBeenCalledTimes(2));
      client.resolveAll();
      await drainPromise;

      expect(client.calls.length).toBe(2);
      expect(client.calls[0].events).toEqual([{ ts: expect.any(Number), type: "sync", data: { a: 1 } }]);
      expect(client.calls[1].events).toEqual([{ ts: expect.any(Number), type: "sync", data: { a: 2 } }]);
      expect(b.dropCount).toBe(0);
    });

    it("caps the drain loop and counts leftover events as dropped if the platform stays down and events keep arriving", async () => {
      // sendEvents resolving to false promptly is the realistic "platform down"
      // shape (PlatformClient.sendEvents already retries internally with its
      // own bounded timeout before ever returning false) — not a send that
      // never settles at all. Each failed attempt also enqueues one more event,
      // simulating new events still arriving during a persistent outage, so
      // the queue is never empty on its own; only the iteration cap ends this.
      let sendCount = 0;
      let b; // assigned below; referenced inside sendEvents' closure
      const client = {
        sendEvents: vi.fn(async () => {
          sendCount++;
          b.push("warn", { n: sendCount }); // more arrives while "down"
          return false;
        }),
      };
      b = new EventBatcher({ client, runId: "r1", worker: "w1", flushCount: 1000, flushIntervalMs: 60_000 });
      b.push("warn", { n: 0 });

      const start = Date.now();
      await b.drain();
      const elapsed = Date.now() - start;

      // Must terminate promptly (bounded by the iteration cap), not loop forever.
      expect(elapsed).toBeLessThan(5_000);
      expect(b.dropCount).toBeGreaterThan(0);
      expect(b.queue.length).toBe(0); // leftover events are cleared, not silently kept around
    });
  });
});
