import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hashDir, hashString } from "../fingerprint.mjs";

let dirA, dirB, dirC;

beforeAll(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bellows-fp-"));
  dirA = path.join(root, "a");
  dirB = path.join(root, "b");
  dirC = path.join(root, "c");
  for (const d of [dirA, dirB, dirC]) fs.mkdirSync(path.join(d, "sub"), { recursive: true });
  // A and B are identical; C differs by one byte.
  for (const d of [dirA, dirB]) {
    fs.writeFileSync(path.join(d, "client.py"), "print('hi')\n");
    fs.writeFileSync(path.join(d, "sub", "x.txt"), "abc");
  }
  fs.writeFileSync(path.join(dirC, "client.py"), "print('hi')\n");
  fs.writeFileSync(path.join(dirC, "sub", "x.txt"), "abd"); // one byte diff
});

describe("hashDir", () => {
  it("is stable for identical trees", () => {
    expect(hashDir(dirA)).toBe(hashDir(dirB));
  });
  it("is order-independent (same result on repeat)", () => {
    expect(hashDir(dirA)).toBe(hashDir(dirA));
  });
  it("changes when content changes", () => {
    expect(hashDir(dirA)).not.toBe(hashDir(dirC));
  });
  it("returns a 64-char hex sha256", () => {
    expect(hashDir(dirA)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("hashString", () => {
  it("is deterministic", () => {
    expect(hashString("hello")).toBe(hashString("hello"));
    expect(hashString("hello")).not.toBe(hashString("world"));
    expect(hashString("x")).toMatch(/^[0-9a-f]{64}$/);
  });
});
