import { describe, it, expect } from "vitest";
import { defaultExecutor } from "../loop.mjs";

// claimed.arm comes straight off the platform's claim response (POST
// /workers/claim), unvalidated — it never passes through validateTrialSpec
// (see the COVERAGE note on validateArmEnv in src/runner/config.mjs). This
// covers ONLY the env-validation-throw path, which fires before
// resolveWorkerRoom's network call, so it's safely unit-testable without a
// stub platform or a real pi/host spawn.
describe("defaultExecutor — claimed.arm.env validation (worker path, Feature 1)", () => {
  const baseClaimed = {
    id: "run-1",
    trial: "t1",
    name: "n1",
    config: { room: { pool: ["r1"] } },
    seed: 1,
  };

  it("rejects a claimed run whose arm.env has a lowercase key", async () => {
    const claimed = { ...baseClaimed, arm: { conductor: "keel", env: { lowercase: "x" } } };
    await expect(defaultExecutor({ claimed, config: {}, apiKey: "k", runDir: "/x", log: () => {} })).rejects.toThrow(
      /invalid arm\.env/,
    );
  });

  it("rejects a claimed run whose arm.env clobbers a runner-controlled var", async () => {
    const claimed = { ...baseClaimed, arm: { conductor: "keel", env: { PATH: "/evil" } } };
    await expect(defaultExecutor({ claimed, config: {}, apiKey: "k", runDir: "/x", log: () => {} })).rejects.toThrow(
      /reserved/,
    );
  });

  it("rejects a claimed run with >32 env entries", async () => {
    const env = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`VAR_${i}`, "x"]));
    const claimed = { ...baseClaimed, arm: { conductor: "keel", env } };
    await expect(defaultExecutor({ claimed, config: {}, apiKey: "k", runDir: "/x", log: () => {} })).rejects.toThrow(
      /at most 32 entries/,
    );
  });

  it("does not throw the arm.env error for a claimed run with no env at all", async () => {
    // Absent env is valid (validateArmEnv([]) === []) — this must get PAST the
    // env-validation guard and into resolveWorkerRoom, which then fails for an
    // unrelated reason (spec.room has no pool/create) — asserting THAT failure
    // message, not "invalid arm.env", is what proves validation was skipped
    // rather than swallowed. resolveWorkerRoom's pooled-room retry loop (real
    // sleeps, up to ~6.5 min) is why this test avoids a pooled/create room.
    const claimed = { ...baseClaimed, config: { room: {} }, arm: { conductor: "keel" } };
    await expect(defaultExecutor({ claimed, config: {}, apiKey: "k", runDir: "/x", log: () => {} })).rejects.toThrow(
      /run has no room/,
    );
  });
});
