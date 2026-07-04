/**
 * HTTP client for the agent-trials worker control-plane wire:
 *   POST /api/bench/workers/claim
 *   POST /api/bench/runs/<id>/heartbeat
 *   POST /api/bench/runs/<id>/events
 *   POST /api/bench/runs/<id>/complete
 *
 * Every request is JSON with an `X-API-Key` header. The key is read once by the
 * caller from process.env and passed in — this module never logs it, and no
 * error path here ever includes `apiKey` or a header dump in a thrown message.
 */

/** Small fetch wrapper with timeout. Node 20+ has global fetch (mirrors src/runner/platform.mjs). */
async function httpJson(url, { method = "GET", headers = {}, body, timeoutMs = 30_000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ac.signal,
    });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { __nonJson: true, __text: text.slice(0, 500) };
    }
    return { status: res.status, ok: res.ok, json };
  } finally {
    clearTimeout(timer);
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Full jitter exponential backoff: [0, min(cap, base*2^attempt)). */
export function backoffMs(attempt, { base = 500, cap = 15_000 } = {}) {
  const max = Math.min(cap, base * 2 ** attempt);
  return Math.floor(Math.random() * max);
}

/**
 * A thin platform client. Never logs `apiKey`. Every method takes only the
 * plain values it needs from a run/worker — never a whole config object — so a
 * careless `log(JSON.stringify(args))` upstream can't leak the key either.
 */
export class PlatformClient {
  /**
   * @param {object} args
   * @param {string} args.base           platform base URL (no trailing slash)
   * @param {string} args.apiKey         never logged
   * @param {(m:string)=>void} [args.log]
   */
  constructor({ base, apiKey, log = () => {} }) {
    this.base = base.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.log = log;
  }

  _headers() {
    return { "Content-Type": "application/json", "X-API-Key": this.apiKey };
  }

  /**
   * Claim the next run for this worker. Returns null on 204 (nothing to do).
   * @param {{worker:string, caps:string[], conductors:string[]}} body
   * @returns {Promise<import("../types.ts").ClaimedRun|null>}
   */
  async claim(body) {
    const url = `${this.base}/api/bench/workers/claim`;
    const { status, ok, json } = await httpJson(url, {
      method: "POST",
      headers: this._headers(),
      body,
      timeoutMs: 30_000,
    });
    if (status === 204) return null;
    if (!ok) throw new Error(`claim failed: HTTP ${status} ${safeJson(json)}`);
    if (!json || !json.run) throw new Error(`claim: malformed response (no "run"): ${safeJson(json)}`);
    return json.run;
  }

  /**
   * @param {string} runId
   * @param {string} worker
   * @returns {Promise<{cancel:boolean}>}
   */
  async heartbeat(runId, worker) {
    const url = `${this.base}/api/bench/runs/${encodeURIComponent(runId)}/heartbeat`;
    const { status, ok, json } = await httpJson(url, {
      method: "POST",
      headers: this._headers(),
      body: { worker },
      timeoutMs: 15_000,
    });
    if (status === 409) return { cancel: false, conflict: true };
    if (!ok) throw new Error(`heartbeat failed: HTTP ${status} ${safeJson(json)}`);
    return { cancel: json && json.cancel === true, conflict: false };
  }

  /**
   * Fire-and-forget-ish: retries a bounded few times, then drops (caller counts drops).
   * @param {string} runId
   * @param {string} worker
   * @param {import("../types.ts").WorkerEvent[]} events  max 100
   * @returns {Promise<boolean>} true if delivered
   */
  async sendEvents(runId, worker, events) {
    if (!events.length) return true;
    const url = `${this.base}/api/bench/runs/${encodeURIComponent(runId)}/events`;
    const batch = events.slice(0, 100);
    const maxAttempts = 3;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const { ok, status, json } = await httpJson(url, {
          method: "POST",
          headers: this._headers(),
          body: { worker, events: batch },
          timeoutMs: 15_000,
        });
        if (ok) return true;
        if (status === 409) return false; // run reaped/cancelled server-side — no point retrying
        if (status < 500 && status !== 429) {
          this.log(`[platform] events rejected (HTTP ${status}): ${safeJson(json)}`);
          return false;
        }
      } catch (e) {
        this.log(`[platform] events send error (attempt ${attempt + 1}/${maxAttempts}): ${e.message}`);
      }
      if (attempt < maxAttempts - 1) await sleep(backoffMs(attempt, { base: 1_000, cap: 8_000 }));
    }
    return false;
  }

  /**
   * Complete a run. Retries hard (~5 min budget) before giving up — the caller
   * must keep record.json on disk regardless, and log loudly on final failure.
   * @param {string} runId
   * @param {object} body  {worker, status, record, room_id?, error?, session_gz_b64?}
   * @returns {Promise<boolean>} true if the platform accepted it
   */
  async complete(runId, body) {
    const url = `${this.base}/api/bench/runs/${encodeURIComponent(runId)}/complete`;
    const deadline = Date.now() + 5 * 60_000;
    let attempt = 0;
    while (Date.now() < deadline) {
      try {
        const { ok, status, json } = await httpJson(url, {
          method: "POST",
          headers: this._headers(),
          body,
          timeoutMs: 60_000,
        });
        if (ok) return true;
        if (status === 409) {
          this.log(`[platform] complete for ${runId}: HTTP 409 (run reaped/cancelled) — not retrying`);
          return false;
        }
        if (status < 500 && status !== 429) {
          this.log(`[platform] complete for ${runId} rejected (HTTP ${status}): ${safeJson(json)}`);
          return false;
        }
        this.log(`[platform] complete for ${runId}: HTTP ${status}, retrying`);
      } catch (e) {
        this.log(`[platform] complete for ${runId} error: ${e.message} — retrying`);
      }
      attempt++;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(backoffMs(attempt, { base: 2_000, cap: 30_000 }), Math.max(1_000, remaining)));
    }
    this.log(`[platform] FAILED to deliver complete() for run ${runId} after retrying for ~5 minutes. ` +
      `record.json is still on disk — resubmit manually once the platform is reachable.`);
    return false;
  }
}

/** Stringify defensively — never let a circular/huge body throw or blow up a log line. */
function safeJson(v) {
  try {
    return JSON.stringify(v).slice(0, 500);
  } catch {
    return String(v).slice(0, 500);
  }
}
