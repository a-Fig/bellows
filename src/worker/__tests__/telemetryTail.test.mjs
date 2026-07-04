import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { TelemetryTail } from "../telemetryTail.mjs";

describe("TelemetryTail", () => {
  /** @type {TelemetryTail[]} */
  const tails = [];
  afterEach(() => {
    for (const t of tails.splice(0)) t.stop();
  });

  it("translates a sync HostEvent into a sync WorkerEvent, incrementally as lines are appended", async () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), "bellows-tail-"));
    const file = path.join(dir, "host.jsonl");
    const seen = [];
    const tail = new TelemetryTail({ file, onEvent: (type, data) => seen.push({ type, data }) });
    tails.push(tail);

    fs.appendFileSync(file, JSON.stringify({ t: "attach", at: 1, sessionId: "s1", conductor: "keel", budget: 5000, protectTokens: 1000 }) + "\n");
    fs.appendFileSync(file, JSON.stringify({ t: "sync", at: 2, rev: 1, blocks: 10, liveTokens: 400, foldedBlocks: 2 }) + "\n");
    tail._poll(); // deterministic — don't wait on the 1s interval

    expect(seen.length).toBe(1);
    expect(seen[0].type).toBe("sync");
    expect(seen[0].data).toEqual({ rev: 1, liveTokens: 400, blocks: 10, foldedBlocks: 2, budget: 5000 });

    fs.appendFileSync(file, JSON.stringify({ t: "sync", at: 3, rev: 2, blocks: 12, liveTokens: 600, foldedBlocks: 3 }) + "\n");
    tail._poll();
    expect(seen.length).toBe(2);
    expect(seen[1].data.rev).toBe(2);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("maps an error HostEvent to a warn WorkerEvent", () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), "bellows-tail-"));
    const file = path.join(dir, "host.jsonl");
    const seen = [];
    const tail = new TelemetryTail({ file, onEvent: (type, data) => seen.push({ type, data }) });
    tails.push(tail);

    fs.writeFileSync(file, JSON.stringify({ t: "error", at: 1, message: "boom" }) + "\n");
    tail._poll();
    expect(seen).toEqual([{ type: "warn", data: { message: "boom" } }]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("is a no-op when the file does not exist yet", () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), "bellows-tail-"));
    const file = path.join(dir, "host.jsonl"); // never created
    const seen = [];
    const tail = new TelemetryTail({ file, onEvent: (type, data) => seen.push({ type, data }) });
    tails.push(tail);
    expect(() => tail._poll()).not.toThrow();
    expect(seen).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
