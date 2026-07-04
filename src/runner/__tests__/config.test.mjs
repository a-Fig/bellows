import { describe, it, expect } from "vitest";
import { validateTrialSpec, normalizeProblems, splitModel, parseConductorArm } from "../config.mjs";

const base = {
  trial: "t1",
  problems: "easy-1",
  model: "token-router:deepseek/deepseek-v4-flash",
  budget: 70000,
  protectTokens: 20000,
  arms: [{ conductor: "keel" }, { conductor: "none", name: "raw" }],
  seeds: 2,
  caps: { costUsd: 5, turns: 200, minutes: 90 },
  parallel: 3,
  room: { pool: ["r1", "r2"] },
};

describe("validateTrialSpec", () => {
  it("accepts a well-formed spec and applies defaults", () => {
    const spec = validateTrialSpec({ ...base, thinkingLevel: undefined, seeds: undefined, parallel: undefined });
    expect(spec.thinkingLevel).toBe("medium");
    expect(spec.seeds).toBe(1);
    expect(spec.parallel).toBe(1);
    expect(spec.arms[1].name).toBe("raw");
    expect(spec.room.create).toBe(false);
  });

  it("rejects a model without a colon", () => {
    expect(() => validateTrialSpec({ ...base, model: "deepseek-v4-flash" })).toThrow(/provider:modelId/);
  });

  it("rejects a trial name with spaces (used in paths)", () => {
    expect(() => validateTrialSpec({ ...base, trial: "bad name" })).toThrow(/trial/);
  });

  it("rejects empty arms", () => {
    expect(() => validateTrialSpec({ ...base, arms: [] })).toThrow(/arms/);
  });

  it("rejects a room with no pool and create=false", () => {
    expect(() => validateTrialSpec({ ...base, room: { pool: [], create: false } })).toThrow(/room/);
  });

  it("accepts create=true with an empty pool", () => {
    const spec = validateTrialSpec({ ...base, room: { create: true } });
    expect(spec.room.create).toBe(true);
    expect(spec.room.pool).toEqual([]);
  });

  it("rejects a non-positive budget", () => {
    expect(() => validateTrialSpec({ ...base, budget: 0 })).toThrow(/budget/);
  });

  it("rejects a bad thinking level", () => {
    expect(() => validateTrialSpec({ ...base, thinkingLevel: "ultra" })).toThrow(/thinkingLevel/);
  });

  it("validates caps fields", () => {
    expect(() => validateTrialSpec({ ...base, caps: { costUsd: 5, turns: 0, minutes: 90 } })).toThrow(/caps.turns/);
  });

  it("accepts an external:<id> arm", () => {
    const spec = validateTrialSpec({ ...base, arms: [{ conductor: "external:thermocline" }] });
    expect(spec.arms[0].conductor).toBe("external:thermocline");
    expect(spec.arms[0].name).toBe("external:thermocline"); // defaults to the raw conductor string
  });

  it("rejects external: with no id", () => {
    expect(() => validateTrialSpec({ ...base, arms: [{ conductor: "external:" }] })).toThrow(/external conductor id missing/);
  });

  it("rejects an external id with invalid characters", () => {
    expect(() => validateTrialSpec({ ...base, arms: [{ conductor: "external:bad id!" }] })).toThrow(/must match/);
  });
});

describe("parseConductorArm", () => {
  it("parses a bare conductor id as in-process", () => {
    expect(parseConductorArm("builtin")).toEqual({ type: "in-process", id: "builtin" });
    expect(parseConductorArm("none")).toEqual({ type: "in-process", id: "none" });
  });

  it("parses external:<id> as external", () => {
    expect(parseConductorArm("external:thermocline")).toEqual({ type: "external", id: "thermocline" });
  });

  it("rejects an empty string", () => {
    expect(() => parseConductorArm("")).toThrow(/non-empty string/);
  });

  it("rejects external: with a malformed id", () => {
    expect(() => parseConductorArm("external:has space")).toThrow(/must match/);
    expect(() => parseConductorArm("external:")).toThrow(/missing/);
  });
});

describe("helpers", () => {
  it("normalizeProblems sorts + joins a list", () => {
    expect(normalizeProblems(["b", "a", "c"])).toBe("a,b,c");
    expect(normalizeProblems("easy-1")).toBe("easy-1");
  });

  it("splitModel splits on the first colon only", () => {
    expect(splitModel("token-router:deepseek/deepseek-v4-flash")).toEqual({
      provider: "token-router",
      modelId: "deepseek/deepseek-v4-flash",
    });
    // provider ids never contain a colon, but modelIds might in theory — first-colon rule
    expect(splitModel("a:b:c")).toEqual({ provider: "a", modelId: "b:c" });
  });
});
