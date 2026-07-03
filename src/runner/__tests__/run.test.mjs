import { describe, it, expect } from "vitest";
import { platformAgentName } from "../run.mjs";

describe("platformAgentName", () => {
  it("is unique per (trial, arm, seed)", () => {
    const names = new Set();
    for (const arm of ["keel", "compaction-naive", "none"]) {
      for (const seed of [1, 2, 3]) names.add(platformAgentName("trialX", arm, seed));
    }
    expect(names.size).toBe(9); // no collisions
  });

  it("uses the <trial>-<arm>-s<seed> shape", () => {
    expect(platformAgentName("t", "keel", 2)).toBe("t-keel-s2");
  });

  it("is ASCII-safe and bounded", () => {
    const n = platformAgentName("has space/slash", "arm:x", 1);
    expect(n).toMatch(/^[A-Za-z0-9_.-]+$/);
    expect(n.length).toBeLessThanOrEqual(80);
  });
});
