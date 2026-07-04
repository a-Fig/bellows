import { describe, it, expect } from "vitest";
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import crypto from "node:crypto";
import { tmpdir } from "node:os";
import { packSessionForUpload } from "../sessionArchive.mjs";

function mkAgentDirWithSession(content) {
  const agentDir = fs.mkdtempSync(path.join(tmpdir(), "bellows-session-"));
  const sessDir = path.join(agentDir, "sessions", "proj");
  fs.mkdirSync(sessDir, { recursive: true });
  fs.writeFileSync(path.join(sessDir, "2026-01-01_abc.jsonl"), content);
  return agentDir;
}

describe("packSessionForUpload", () => {
  it("gzips + base64s the newest session file", () => {
    const agentDir = mkAgentDirWithSession('{"type":"session"}\n{"type":"message"}\n');
    const { sessionGzB64, skippedReason } = packSessionForUpload(agentDir);
    expect(skippedReason).toBeNull();
    expect(typeof sessionGzB64).toBe("string");
    const decoded = zlib.gunzipSync(Buffer.from(sessionGzB64, "base64")).toString("utf8");
    expect(decoded).toContain('"type":"session"');
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("skips with a reason when no session file exists", () => {
    const agentDir = fs.mkdtempSync(path.join(tmpdir(), "bellows-session-empty-"));
    const { sessionGzB64, skippedReason } = packSessionForUpload(agentDir);
    expect(sessionGzB64).toBeNull();
    expect(skippedReason).toMatch(/no session file/);
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it("skips a session file whose GZIPPED size is over the 25 MB ceiling", () => {
    // m7 (adversarial review): the server's cap (platform/bench_routes.py
    // complete_bench_run) is on the gzip-compressed size, not the raw
    // session size — so this must use INCOMPRESSIBLE content (random bytes)
    // to actually exceed the cap after gzip. Repeated-byte content (the old
    // test's Buffer.alloc(..., 0x61)) gzips down to a few KB and would no
    // longer trip this path after the fix, since the server would in fact
    // accept it.
    const agentDir = mkAgentDirWithSession("x");
    const sessDir = path.join(agentDir, "sessions", "proj");
    const big = crypto.randomBytes(26 * 1024 * 1024);
    fs.writeFileSync(path.join(sessDir, "2026-01-01_abc.jsonl"), big);
    const { sessionGzB64, skippedReason } = packSessionForUpload(agentDir);
    expect(sessionGzB64).toBeNull();
    expect(skippedReason).toMatch(/gzip/);
    fs.rmSync(agentDir, { recursive: true, force: true });
  }, 15_000);

  it("uploads a session that is over 25 MB RAW but compresses under the gzip cap", () => {
    // The actual bug: highly-compressible content (real pi session JSONL is
    // like this — repetitive JSON keys/tool output) can be well over 25 MB
    // raw yet gzip to a fraction of that. The server's cap is on the gzip
    // size, so this upload must be accepted, not skipped.
    const agentDir = mkAgentDirWithSession("x");
    const sessDir = path.join(agentDir, "sessions", "proj");
    const line = '{"type":"message","role":"assistant","content":"repeated compressible text "}\n';
    const big = Buffer.from(line.repeat(Math.ceil((30 * 1024 * 1024) / line.length)));
    expect(big.length).toBeGreaterThan(25 * 1024 * 1024);
    fs.writeFileSync(path.join(sessDir, "2026-01-01_abc.jsonl"), big);
    const { sessionGzB64, skippedReason } = packSessionForUpload(agentDir);
    expect(skippedReason).toBeNull();
    expect(typeof sessionGzB64).toBe("string");
    const gzBytes = Buffer.from(sessionGzB64, "base64");
    expect(gzBytes.length).toBeLessThan(25 * 1024 * 1024);
    fs.rmSync(agentDir, { recursive: true, force: true });
  }, 15_000);
});
