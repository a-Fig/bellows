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
});
