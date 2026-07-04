/**
 * Batches WorkerEvents for one run and flushes them to the platform every
 * ~5s or every 20 events (whichever comes first), and always on `drain()`.
 * Delivery failures are dropped (sendEvents already retries a bounded few
 * times) — dropCount is exposed so the worker loop can log a summary.
 */
export class EventBatcher {
  /**
   * @param {object} args
   * @param {import("./platformClient.mjs").PlatformClient} args.client
   * @param {string} args.runId
   * @param {string} args.worker
   * @param {number} [args.flushIntervalMs]
   * @param {number} [args.flushCount]
   */
  constructor({ client, runId, worker, flushIntervalMs = 5_000, flushCount = 20 }) {
    this.client = client;
    this.runId = runId;
    this.worker = worker;
    this.flushCount = flushCount;
    this.queue = [];
    this.dropCount = 0;
    this.sentCount = 0;
    this._flushing = null;
    this._timer = setInterval(() => void this.flush(), flushIntervalMs);
    this._timer.unref?.();
  }

  /** @param {import("../types.ts").WorkerEventType} type */
  push(type, data = {}) {
    this.queue.push({ ts: Date.now(), type, data });
    if (this.queue.length >= this.flushCount) void this.flush();
  }

  /** Flush whatever is queued right now. Coalesces concurrent callers onto one in-flight send. */
  async flush() {
    if (this._flushing) return this._flushing;
    if (!this.queue.length) return;
    const batch = this.queue.splice(0, this.queue.length);
    this._flushing = this._send(batch);
    try {
      await this._flushing;
    } finally {
      this._flushing = null;
    }
  }

  async _send(batch) {
    // The wire caps a batch at 100; split larger flushes into sequential posts.
    for (let i = 0; i < batch.length; i += 100) {
      const chunk = batch.slice(i, i + 100);
      const ok = await this.client.sendEvents(this.runId, this.worker, chunk);
      if (ok) this.sentCount += chunk.length;
      else this.dropCount += chunk.length;
    }
  }

  /** Stop the timer and flush whatever remains. Call once, at run end. */
  async drain() {
    clearInterval(this._timer);
    await this.flush();
  }
}
