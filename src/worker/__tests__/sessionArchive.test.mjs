import { describe, it, expect } from "vitest";
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
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

  it("skips a session file over the 25 MB ceiling", () => {
    const agentDir = mkAgentDirWithSession("x"); // tiny real file, we'll stat-fake via a huge one instead
    // Overwrite with something the size check will actually reject: write >25MB.
    const sessDir = path.join(agentDir, "sessions", "proj");
    const big = Buffer.alloc(26 * 1024 * 1024, 0x61);
    fs.writeFileSync(path.join(sessDir, "2026-01-01_abc.jsonl"), big);
    const { sessionGzB64, skippedReason } = packSessionForUpload(agentDir);
    expect(sessionGzB64).toBeNull();
    expect(skippedReason).toMatch(/too large/);
    fs.rmSync(agentDir, { recursive: true, force: true });
  }, 15_000);
});
