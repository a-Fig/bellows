/**
 * Gzip + base64 a run's pi session JSONL for upload with `complete`. The
 * per-run session file location is exactly what src/runner/collect.mjs's
 * findNewestSessionFile already resolves (agentDir/sessions/**\/*.jsonl,
 * PI_CODING_AGENT_DIR for that run) — reused here rather than re-deriving it.
 */
import fs from "node:fs";
import zlib from "node:zlib";
import { findNewestSessionFile } from "../runner/collect.mjs";

/**
 * 25 MiB ceiling — checked against the GZIP-COMPRESSED size, matching the
 * server exactly (m7, adversarial review). platform/bench_routes.py's
 * complete_bench_run does `session_gz = base64.b64decode(session_gz_b64)`
 * then rejects when `len(session_gz) > MAX_SESSION_GZ_BYTES` — that's the
 * size of the gzip blob itself (post-base64-decode, pre-gunzip), NOT the
 * size of the raw/decompressed session content. A compressible session file
 * can be well over 25 MB raw and still gzip under the cap (pi session JSONL
 * is highly compressible text) — checking raw bytes here would wrongly skip
 * uploads the server would have accepted, and would wrongly accept nothing
 * it shouldn't (the two checks only coincide for incompressible content).
 */
export const MAX_SESSION_BYTES = 25 * 1024 * 1024;

/**
 * A raw-file pre-filter, well above MAX_SESSION_BYTES, so we don't even
 * attempt to read+gzip an absurdly large file before finding out it's over
 * the (post-gzip) cap. Not the authoritative check — gzip below is.
 */
const RAW_PREFILTER_BYTES = 500 * 1024 * 1024; // 500 MiB

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
  if (stat.size > RAW_PREFILTER_BYTES) {
    const mb = (stat.size / (1024 * 1024)).toFixed(1);
    log(`[worker] session file is ${mb} MB raw (> ${RAW_PREFILTER_BYTES / (1024 * 1024)} MB prefilter) — skipping upload without attempting gzip`);
    return { sessionGzB64: null, skippedReason: `session file too large to attempt (${mb} MB raw)` };
  }
  let gz;
  try {
    const raw = fs.readFileSync(sessionFile);
    gz = zlib.gzipSync(raw);
  } catch (e) {
    log(`[worker] failed to gzip session file ${sessionFile}: ${e.message}`);
    return { sessionGzB64: null, skippedReason: `gzip failed: ${e.message}` };
  }
  // Authoritative check: the SERVER's cap is on this gzip-compressed size.
  if (gz.length > MAX_SESSION_BYTES) {
    const rawMb = (stat.size / (1024 * 1024)).toFixed(1);
    const gzMb = (gz.length / (1024 * 1024)).toFixed(1);
    log(`[worker] session file gzips to ${gzMb} MB (raw ${rawMb} MB) — exceeds 25 MB gzip cap, skipping upload`);
    return { sessionGzB64: null, skippedReason: `gzipped session too large (${gzMb} MB gzip > 25 MB)` };
  }
  return { sessionGzB64: gz.toString("base64"), skippedReason: null };
}
