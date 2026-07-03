import { describe, it, expect } from "vitest";
import { validateTrialSpec, normalizeProblems, splitModel } from "../config.mjs";

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
