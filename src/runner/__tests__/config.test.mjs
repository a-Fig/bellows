import { describe, it, expect } from "vitest";
import { validateTrialSpec, normalizeProblems, splitModel, parseConductorArm, normalizeBenchConfig } from "../config.mjs";

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

const rawBenchConfigBase = {
  accordionRepo: "C:/accordion",
  platformBase: "https://platform.example/",
  platformApiKeyEnv: "AGENT_TRIALS_API_KEY",
};

describe("normalizeBenchConfig", () => {
  it("omits worker and pricing when absent", () => {
    const cfg = normalizeBenchConfig({ ...rawBenchConfigBase });
    expect(cfg.worker).toBeUndefined();
    expect(cfg.pricing).toBeUndefined();
    expect(cfg.platformBase).toBe("https://platform.example"); // trailing slash trimmed
  });

  it("passes pricing through untouched when present", () => {
    const pricing = { "deepseek/deepseek-v4-flash": { inputPerMtok: 1 } };
    const cfg = normalizeBenchConfig({ ...rawBenchConfigBase, pricing });
    expect(cfg.pricing).toEqual(pricing);
  });

  it("normalizes a well-formed worker section and applies defaults", () => {
    const cfg = normalizeBenchConfig({
      ...rawBenchConfigBase,
      worker: { platformUrl: "https://platform.example/", name: "w1" },
    });
    expect(cfg.worker).toEqual({
      platformUrl: "https://platform.example",
      name: "w1",
      caps: [],
      pullBeforeClaim: false,
      parallel: 1,
    });
  });

  it("keeps caps, pullBeforeClaim, parallel when given", () => {
    const cfg = normalizeBenchConfig({
      ...rawBenchConfigBase,
      worker: { platformUrl: "https://p", name: "w1", caps: ["in-process", "gpu-probe"], pullBeforeClaim: true, parallel: 1 },
    });
    expect(cfg.worker.caps).toEqual(["in-process", "gpu-probe"]);
    expect(cfg.worker.pullBeforeClaim).toBe(true);
    expect(cfg.worker.parallel).toBe(1);
  });

  it("rejects a worker section missing platformUrl", () => {
    expect(() => normalizeBenchConfig({ ...rawBenchConfigBase, worker: { name: "w1" } })).toThrow(/worker.platformUrl/);
  });

  it("rejects a worker section missing name", () => {
    expect(() => normalizeBenchConfig({ ...rawBenchConfigBase, worker: { platformUrl: "https://p" } })).toThrow(/worker.name/);
  });

  it("rejects a non-positive-integer parallel", () => {
    expect(() =>
      normalizeBenchConfig({ ...rawBenchConfigBase, worker: { platformUrl: "https://p", name: "w1", parallel: 0 } }),
    ).toThrow(/worker.parallel/);
  });

  it("rejects worker.parallel > 1 at validation time (nit, adversarial review)", () => {
    // Previously only src/worker/loop.mjs's runWorkerLoop() rejected this, at
    // startup — after loadBenchConfig had already succeeded and the worker had
    // logged its "polling ..." banner. Validate what the loop actually rejects.
    expect(() =>
      normalizeBenchConfig({ ...rawBenchConfigBase, worker: { platformUrl: "https://p", name: "w1", parallel: 2 } }),
    ).toThrow(/worker.parallel/);
  });
});
