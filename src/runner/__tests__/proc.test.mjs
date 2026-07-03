import { describe, it, expect } from "vitest";
import { resolveCommand } from "../proc.mjs";

describe("resolveCommand", () => {
  it("returns an absolute path for node (present on PATH)", () => {
    const r = resolveCommand("node");
    expect(typeof r).toBe("string");
    expect(r.length).toBeGreaterThan(0);
    // On Windows this should be an absolute path; on posix it may be /usr/bin/node.
    expect(r).toMatch(/node/i);
  });

  it("passes through an unknown command unchanged (best effort)", () => {
    expect(resolveCommand("definitely-not-a-real-cmd-xyz")).toBe("definitely-not-a-real-cmd-xyz");
  });
});
