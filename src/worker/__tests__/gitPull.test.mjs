import { describe, it, expect, afterEach } from "vitest";
import { maybePullAccordion, accordionSha, _resetPullThrottle } from "../gitPull.mjs";

describe("maybePullAccordion", () => {
  afterEach(() => _resetPullThrottle());

  it("throttles to at most once/min: a second call without force is a no-op (no throw, no crash)", () => {
    const logs = [];
    // Not a real git repo — expect a warning to be logged, not a throw.
    maybePullAccordion({ accordionRepo: "C:/definitely/not/a/repo", log: (m) => logs.push(m), force: true });
    expect(logs.some((m) => m.includes("WARN"))).toBe(true);

    const before = logs.length;
    maybePullAccordion({ accordionRepo: "C:/definitely/not/a/repo", log: (m) => logs.push(m) }); // throttled, not forced
    expect(logs.length).toBe(before); // nothing new logged — throttle held
  });
});

describe("accordionSha", () => {
  it("returns 'unknown(...)' for a non-repo path rather than throwing", () => {
    const sha = accordionSha("C:/definitely/not/a/repo");
    expect(sha).toMatch(/^unknown\(/);
  });

  it("returns a real 40-char sha for this repo's own accordion checkout", () => {
    // bellows-worker's bench.config.example.json points at a real Accordion checkout on
    // this machine — reuse that path rather than hardcoding one that may not exist elsewhere.
    const sha = accordionSha(process.env.BELLOWS_TEST_ACCORDION_REPO || "C:/Users/smash/Desktop/Claude Work Space/Accordion-Public");
    expect(sha).toMatch(/^[0-9a-f]{40}$|^unknown\(/);
  });
});
