/**
 * Gzip + base64 a run's pi session JSONL for upload with `complete`. The
 * per-run session file location is exactly what src/runner/collect.mjs's
 * findNewestSessionFile already resolves (agentDir/sessions/**\/*.jsonl,
 * PI_CODING_AGENT_DIR for that run) — reused here rather than re-deriving it.
 */
import fs from "node:fs";
import zlib from "node:zlib";
import { findNewestSessionFile } from "../runner/collect.mjs";

/** 25 MB decoded-size ceiling (the platform wire's stated limit). */
export const MAX_SESSION_BYTES = 25 * 1024 * 1024;

/**
 * @param {string} agentDir  the run's PI_CODING_AGENT_DIR
 * @param {(m:string)=>void} [log]
 * @returns {{ sessionGzB64: string | null, skippedReason: string | null }}
 */
export function packSessionForUpload(agentDir, log = () => {}) {
  const sessionFile = findNewestSessionFile(agentDir);
  if (!sessionFile) {
    log(`[worker] no pi session file found under ${agentDir} — skipping session upload`);
    return { sessionGzB64: null, skippedReason: "no session file found" };
  }
  let stat;
  try {
    stat = fs.statSync(sessionFile);
  } catch (e) {
    log(`[worker] could not stat session file ${sessionFile}: ${e.message}`);
    return { sessionGzB64: null, skippedReason: `stat failed: ${e.message}` };
  }
  if (stat.size > MAX_SESSION_BYTES) {
    const mb = (stat.size / (1024 * 1024)).toFixed(1);
    log(`[worker] session file is ${mb} MB (> 25 MB) — skipping upload`);
    return { sessionGzB64: null, skippedReason: `session file too large (${mb} MB > 25 MB)` };
  }
  try {
    const raw = fs.readFileSync(sessionFile);
    const gz = zlib.gzipSync(raw);
    return { sessionGzB64: gz.toString("base64"), skippedReason: null };
  } catch (e) {
    log(`[worker] failed to gzip session file ${sessionFile}: ${e.message}`);
    return { sessionGzB64: null, skippedReason: `gzip failed: ${e.message}` };
  }
}
