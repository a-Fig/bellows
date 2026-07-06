/**
 * Platform (agent-trials / SlopCode) interactions the RUNNER performs directly:
 *  - leaderboard harvest by label -> PlatformResult
 *  - optional room creation (behind room.create flag)
 *  - room reachability check (join) for pool round-robin reuse
 *
 * The agent itself drives join/label/start/submit/finalize via slopcode_client.py
 * inside its workspace. The runner never mutates a live room's problem state —
 * with ONE exception: the post-run finalize sweep (finalizeStaleAgent), which
 * acts as the run's own agent to close a game the agent left open.
 */
import fs from "node:fs";
import path from "node:path";

/** Small fetch wrapper with timeout. Node 20+ has global fetch. */
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

/**
 * Fetch the leaderboard rows for an exact label. Retries a few times so a
 * just-finalized run has time to appear.
 * @param {object} args
 * @param {string} args.base
 * @param {string} args.label
 * @param {number} [args.timeoutTotalMs]  overall budget (default ~5 min — grading
 *   is platform-capped at ~3 concurrent, so under parallel runs a just-submitted
 *   grade can take minutes to land on the board)
 * @param {number} [args.pollIntervalMs]  default ~18s
 * @param {(m:string)=>void} [args.log]
 * @returns {Promise<import("../types.ts").PlatformResult | null>}
 */
export async function harvestLeaderboard({
  base,
  label,
  timeoutTotalMs = 300_000,
  pollIntervalMs = 18_000,
  log = () => {},
}) {
  // The server matches the ?label= query literally; empty means "no filter".
  // Trim ourselves so a whitespace-only label never turns into a full-board pull.
  const q = normalizeLabel(label);
  if (!q) {
    log(`[platform] refusing to harvest with an empty label (would match the whole board)`);
    return null;
  }
  const deadline = Date.now() + timeoutTotalMs;
  const url = `${base.replace(/\/+$/, "")}/games/slopcode/leaderboard?label=${encodeURIComponent(q)}`;
  let attempt = 0;
  /** @type {import("../types.ts").PlatformResult | null} */
  let lastPartial = null;
  while (Date.now() < deadline) {
    attempt++;
    let rows = [];
    try {
      const { json, status } = await httpJson(url, { timeoutMs: 30_000 });
      rows = Array.isArray(json?.leaderboard) ? json.leaderboard : [];
      if (status >= 500) log(`[platform] leaderboard ${status}, retrying`);
    } catch (e) {
      log(`[platform] leaderboard fetch error: ${e.message}`);
    }
    const result = pickLeaderboardRow(rows);
    if (result) {
      lastPartial = result;
      // A finalized row is the answer of record; return immediately. Otherwise
      // keep polling (a final row may still appear) but retain the partial.
      const isFinal = result.raw && result.raw.final === true;
      if (isFinal) return result;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(pollIntervalMs, Math.max(2_000, remaining)));
  }
  // No finalized row within the window — return the best partial (aborted runs
  // still emit non-final leaderboard snapshots per graded submission), or null.
  if (lastPartial) {
    log(`[platform] label "${q}": only a non-final row after ${attempt} poll(s) — recording as partial`);
  } else {
    log(`[platform] no leaderboard row for label "${q}" after ${attempt} attempt(s)`);
  }
  return lastPartial;
}

/** Trim + clamp a run label to the platform's 64-char limit. */
export function normalizeLabel(label) {
  return String(label == null ? "" : label).trim().slice(0, 64);
}

/**
 * Reduce a set of leaderboard rows (already filtered by label) to one
 * PlatformResult. Prefers a finalized (final:true) row; falls back to the
 * highest-scoring row. Returns null for an empty set.
 * @param {any[]} rows
 * @returns {import("../types.ts").PlatformResult | null}
 */
export function pickLeaderboardRow(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const finals = rows.filter((r) => r && r.final === true);
  const pool = finals.length ? finals : rows;
  // Highest run_score wins ties; treat null score as -Infinity.
  const score = (r) => (typeof r.run_score === "number" ? r.run_score : -Infinity);
  const row = pool.reduce((best, r) => (score(r) > score(best) ? r : best), pool[0]);
  return {
    gameId: str(row.game_id),
    roomId: str(row.room_id),
    agentName: str(row.agent_name),
    runScore: typeof row.run_score === "number" ? row.run_score : null,
    checkpointsSolved: num(row.checkpoints_solved),
    checkpointsAttempted: num(row.checkpoints_attempted),
    raw: row,
  };
}

function str(v) {
  return v == null ? "" : String(v);
}
function num(v) {
  return Number.isFinite(v) ? v : 0;
}

/**
 * Create a room via POST /api/rooms (API-key gated). Tolerates 404 with a
 * clear "endpoint not deployed" error so the flag can ship ahead of the server.
 * @param {object} args
 * @param {string} args.base
 * @param {string} args.apiKey
 * @param {object} [args.roomConfig]  passed through as the request body
 * @returns {Promise<string>} the new room id
 */
export async function createRoom({ base, apiKey, roomConfig = {} }) {
  const url = `${base.replace(/\/+$/, "")}/api/rooms`;
  const { status, ok, json } = await httpJson(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
    body: roomConfig,
    timeoutMs: 30_000,
  });
  if (status === 404) {
    throw new Error(
      "room.create=true but POST /api/rooms returned 404 — the agent-trials " +
        "room-create endpoint is not deployed yet. Use room.pool with pre-created room ids instead.",
    );
  }
  if (!ok) {
    throw new Error(`createRoom failed: HTTP ${status} ${JSON.stringify(json).slice(0, 300)}`);
  }
  const roomId = json.room_id || json.roomId || json.id;
  if (!roomId) throw new Error(`createRoom: no room id in response ${JSON.stringify(json).slice(0, 300)}`);
  return String(roomId);
}

/**
 * Best-effort READ-ONLY probe that a pooled room is joinable (it has reset and
 * accepts registrations). Checks the spectator view's game phase — the server
 * only admits registrations while the room is in "waiting" (server.py
 * register(): `room.state not in ("waiting",)` → 409).
 *
 * MUST NOT register: registering flips a slopcode room out of "waiting", so a
 * register-based probe *consumes* the very reset it is checking for — the
 * probe succeeds, the game starts with the throwaway agent, and the real
 * agent's join then 409s (observed live: trial handoff-vs-builtin-easy1-r2,
 * probe agent bellows_worker_probe_1783309267064_0 locked the room).
 *
 * `probeName` is accepted for call-site compatibility but unused.
 * Never throws — returns bool.
 * @param {object} args
 * @param {string} args.base
 * @param {string} args.apiKey
 * @param {string} args.roomId
 * @param {string} [args.probeName]
 */
export async function probeRoomJoinable({ base, apiKey, roomId, probeName: _probeName }) {
  const url = `${base.replace(/\/+$/, "")}/rooms/${encodeURIComponent(roomId)}/spectate`;
  try {
    const { ok, json } = await httpJson(url, {
      method: "GET",
      headers: { "X-API-Key": apiKey },
      timeoutMs: 20_000,
    });
    return ok && json && json.phase === "waiting";
  } catch {
    return false;
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Best-effort finalize of the run's agent using the session file the
 * slopcode client saved in the workspace (`.slopcode_session.json`).
 *
 * A run that ends without `finalize` (turn/cost/time cap, crash, agent
 * forgot) leaves its game open FOREVER — slopcode rooms only schedule their
 * ~5 min auto-reset on finalize, so an un-finalized game wedges a pooled
 * room until someone finalizes by hand (observed live three runs straight:
 * smoke-03, then trials r2/r3). The runner holds the agent's identity, so it
 * finalizes on the agent's behalf after the run ends. Also makes the
 * leaderboard row `final`, which the harvest prefers.
 *
 * Returns "finalized" | "no-session" | "failed". Never throws.
 * @param {object} args
 * @param {string} args.base
 * @param {string} args.apiKey
 * @param {string} args.workspaceDir
 * @param {(m:string)=>void} [args.log]
 */
export async function finalizeStaleAgent({ base, apiKey, workspaceDir, log = () => {} }) {
  let session;
  try {
    const raw = fs.readFileSync(path.join(workspaceDir, ".slopcode_session.json"), "utf8");
    session = JSON.parse(raw);
  } catch {
    return "no-session"; // agent never joined (or workspace gone) — nothing to release
  }
  const agentId = session.agent_id;
  const roomId = session.room_id;
  if (!agentId || !roomId) return "no-session";
  const url = `${base.replace(/\/+$/, "")}/rooms/${encodeURIComponent(roomId)}/action`;
  try {
    const { ok, json } = await httpJson(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
      body: { agent_id: agentId, command: "finalize" },
      timeoutMs: 20_000,
    });
    if (ok && json && json.ok !== false) {
      log(`[finalize-sweep] finalized agent ${agentId} in room ${roomId}`);
      return "finalized";
    }
    log(`[finalize-sweep] finalize refused: ${JSON.stringify(json).slice(0, 160)}`);
    return "failed";
  } catch (e) {
    log(`[finalize-sweep] finalize error: ${e.message}`);
    return "failed";
  }
}
