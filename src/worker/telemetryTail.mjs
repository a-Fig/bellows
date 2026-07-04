/**
 * Tails a host.jsonl telemetry file (see src/host/telemetry.ts — sync, append-only,
 * one JSON HostEvent per line) while a run is in flight, translating the events
 * the worker cares about into WorkerEvents. Read-only; never mutates the file.
 *
 * Polls on an interval rather than fs.watch — host.jsonl may not exist yet at
 * attach time (spawnHost/main.ts creates it lazily on first tel.emit), and a
 * plain poll sidesteps watch/rename edge cases on Windows entirely.
 */
import fs from "node:fs";
import { parseJsonl } from "../runner/collect.mjs";

const POLL_MS = 1_000;

export class TelemetryTail {
  /**
   * @param {object} args
   * @param {string} args.file        host.jsonl path (may not exist yet)
   * @param {(type: import("../types.ts").WorkerEventType, data: object)=>void} args.onEvent
   * @param {(m:string)=>void} [args.log]
   */
  constructor({ file, onEvent, log = () => {} }) {
    this.file = file;
    this.onEvent = onEvent;
    this.log = log;
    this._offset = 0;
    this._budget = null;
    this._timer = setInterval(() => this._poll(), POLL_MS);
    this._timer.unref?.();
  }

  _poll() {
    let text;
    try {
      if (!fs.existsSync(this.file)) return;
      const fd = fs.openSync(this.file, "r");
      try {
        const stat = fs.fstatSync(fd);
        if (stat.size <= this._offset) return; // nothing new (or truncated — ignore, next write catches up)
        const len = stat.size - this._offset;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, this._offset);
        this._offset = stat.size;
        text = buf.toString("utf8");
      } finally {
        fs.closeSync(fd);
      }
    } catch (e) {
      this.log(`[worker] telemetry tail read error: ${e.message}`);
      return;
    }
    for (const rec of parseJsonl(text)) {
      if (!rec || typeof rec.t !== "string") continue;
      if (rec.t === "attach" && Number.isFinite(rec.budget)) this._budget = rec.budget;
      if (rec.t === "sync") {
        this.onEvent("sync", {
          rev: rec.rev,
          liveTokens: rec.liveTokens,
          blocks: rec.blocks,
          foldedBlocks: rec.foldedBlocks,
          budget: this._budget,
        });
      } else if (rec.t === "error") {
        this.onEvent("warn", { message: rec.message });
      }
    }
  }

  /** Stop polling. One last poll to catch anything written just before teardown. */
  stop() {
    clearInterval(this._timer);
    this._poll();
  }
}
