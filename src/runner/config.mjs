/**
 * Config + trial-spec loading and validation.
 * Shapes conform to src/types.ts (BenchConfig, TrialSpec, ArmSpec, RoomSupply).
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Repo root = two levels up from src/runner/. */
export const REPO_ROOT = path.resolve(__dirname, "..", "..");

const VALID_THINKING = new Set(["off", "minimal", "low", "medium", "high"]);

/**
 * Load bench config. Falls back to bench.config.example.json with a warning.
 * @param {(msg:string)=>void} [warn]
 * @returns {{ config: import("../types.ts").BenchConfig, source: string }}
 */
export function loadBenchConfig(warn = console.warn) {
  const real = path.join(REPO_ROOT, "bench.config.json");
  const example = path.join(REPO_ROOT, "bench.config.example.json");
  let source;
  if (fs.existsSync(real)) {
    source = real;
  } else if (fs.existsSync(example)) {
    warn(
      `[bellows] bench.config.json not found — falling back to bench.config.example.json. ` +
        `Copy it and edit paths for your machine.`,
    );
    source = example;
  } else {
    throw new Error(
      `No bench config: neither ${real} nor ${example} exists.`,
    );
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(source, "utf8"));
  } catch (e) {
    throw new Error(`Failed to parse ${source}: ${e.message}`);
  }
  const cfg = normalizeBenchConfig(raw);
  return { config: cfg, source };
}

/** @returns {import("../types.ts").BenchConfig} */
function normalizeBenchConfig(raw) {
  const errs = [];
  if (!raw || typeof raw !== "object") errs.push("config is not an object");
  const s = (k) => (typeof raw[k] === "string" && raw[k].trim() ? raw[k] : null);
  const accordionRepo = s("accordionRepo");
  const platformBase = s("platformBase");
  const platformApiKeyEnv = s("platformApiKeyEnv");
  if (!accordionRepo) errs.push("accordionRepo (string) is required");
  if (!platformBase) errs.push("platformBase (string) is required");
  if (!platformApiKeyEnv) errs.push("platformApiKeyEnv (string) is required");
  if (errs.length) throw new Error(`Invalid bench config:\n  - ${errs.join("\n  - ")}`);
  return {
    accordionRepo,
    platformBase: platformBase.replace(/\/+$/, ""),
    platformApiKeyEnv,
    piAgentDir: s("piAgentDir") || path.join(os.homedir(), ".pi", "agent"),
    runsDir: s("runsDir") || "./runs",
  };
}

/**
 * Load + validate a trial spec YAML.
 * @param {string} specPath
 * @returns {import("../types.ts").TrialSpec}
 */
export function loadTrialSpec(specPath) {
  const abs = path.resolve(specPath);
  if (!fs.existsSync(abs)) throw new Error(`Trial spec not found: ${abs}`);
  let raw;
  try {
    raw = YAML.parse(fs.readFileSync(abs, "utf8"));
  } catch (e) {
    throw new Error(`Failed to parse trial YAML ${abs}: ${e.message}`);
  }
  return validateTrialSpec(raw);
}

/**
 * Validate an already-parsed trial object. Throws with a clear message on any
 * problem. Returns a normalized TrialSpec (defaults applied).
 * @param {any} raw
 * @returns {import("../types.ts").TrialSpec}
 */
export function validateTrialSpec(raw) {
  const errs = [];
  const ok = raw && typeof raw === "object";
  if (!ok) throw new Error("Trial spec is not an object.");

  if (typeof raw.trial !== "string" || !raw.trial.trim())
    errs.push("trial: required non-empty string");
  else if (!/^[A-Za-z0-9._-]+$/.test(raw.trial))
    errs.push(`trial: "${raw.trial}" must match [A-Za-z0-9._-]+ (used in paths + labels)`);

  const problems = raw.problems;
  const problemsOk =
    typeof problems === "string" ||
    (Array.isArray(problems) && problems.length > 0 && problems.every((p) => typeof p === "string"));
  if (!problemsOk) errs.push("problems: required — a string or non-empty string[]");

  if (typeof raw.model !== "string" || !raw.model.includes(":"))
    errs.push('model: required "provider:modelId" string (must contain ":")');

  if (raw.thinkingLevel !== undefined && !VALID_THINKING.has(raw.thinkingLevel))
    errs.push(`thinkingLevel: "${raw.thinkingLevel}" not one of ${[...VALID_THINKING].join(", ")}`);

  if (!Number.isFinite(raw.budget) || raw.budget <= 0)
    errs.push("budget: required positive number");
  if (!Number.isFinite(raw.protectTokens) || raw.protectTokens < 0)
    errs.push("protectTokens: required non-negative number");

  if (!Array.isArray(raw.arms) || raw.arms.length === 0)
    errs.push("arms: required non-empty array");
  else {
    raw.arms.forEach((a, i) => {
      if (!a || typeof a !== "object" || typeof a.conductor !== "string" || !a.conductor.trim())
        errs.push(`arms[${i}].conductor: required non-empty string`);
      if (a && a.name !== undefined && typeof a.name !== "string")
        errs.push(`arms[${i}].name: must be a string if present`);
    });
  }

  if (raw.seeds !== undefined && (!Number.isInteger(raw.seeds) || raw.seeds < 1))
    errs.push("seeds: must be a positive integer if present");
  if (raw.parallel !== undefined && (!Number.isInteger(raw.parallel) || raw.parallel < 1))
    errs.push("parallel: must be a positive integer if present");

  const caps = raw.caps;
  if (!caps || typeof caps !== "object") errs.push("caps: required object {costUsd, turns, minutes}");
  else {
    if (!Number.isFinite(caps.costUsd) || caps.costUsd <= 0) errs.push("caps.costUsd: required positive number");
    if (!Number.isInteger(caps.turns) || caps.turns <= 0) errs.push("caps.turns: required positive integer");
    if (!Number.isFinite(caps.minutes) || caps.minutes <= 0) errs.push("caps.minutes: required positive number");
    if (caps.totalTokens !== undefined && (!Number.isInteger(caps.totalTokens) || caps.totalTokens <= 0))
      errs.push("caps.totalTokens: must be a positive integer when set");
  }

  const room = raw.room;
  if (!room || typeof room !== "object") errs.push("room: required object {pool?, create?, base?}");
  else {
    const hasPool = Array.isArray(room.pool) && room.pool.length > 0;
    if (room.pool !== undefined && !Array.isArray(room.pool)) errs.push("room.pool: must be a string[] if present");
    else if (Array.isArray(room.pool) && !room.pool.every((r) => typeof r === "string"))
      errs.push("room.pool: every entry must be a string");
    if (room.create !== undefined && typeof room.create !== "boolean") errs.push("room.create: must be a boolean");
    if (room.base !== undefined && typeof room.base !== "string") errs.push("room.base: must be a string");
    if (!hasPool && room.create !== true)
      errs.push("room: need either a non-empty pool or create:true (no rooms available otherwise)");
  }

  if (errs.length) throw new Error(`Invalid trial spec:\n  - ${errs.join("\n  - ")}`);

  /** @type {import("../types.ts").TrialSpec} */
  const spec = {
    trial: raw.trial,
    problems: Array.isArray(problems) ? problems.slice() : problems,
    model: raw.model,
    thinkingLevel: raw.thinkingLevel || "medium",
    budget: raw.budget,
    protectTokens: raw.protectTokens,
    arms: raw.arms.map((a) => ({ conductor: a.conductor, name: a.name || a.conductor })),
    seeds: raw.seeds || 1,
    caps: { costUsd: caps.costUsd, turns: caps.turns, minutes: caps.minutes, totalTokens: caps.totalTokens },
    parallel: raw.parallel || 1,
    room: {
      pool: Array.isArray(room.pool) ? room.pool.slice() : [],
      create: room.create === true,
      base: typeof room.base === "string" ? room.base : undefined,
    },
  };
  return spec;
}

/** Normalized problems string for the fingerprint (sorted + comma-joined). */
export function normalizeProblems(problems) {
  if (Array.isArray(problems)) return problems.slice().sort().join(",");
  return String(problems);
}

/** Split "provider:modelId" on the FIRST colon. */
export function splitModel(model) {
  const idx = model.indexOf(":");
  if (idx === -1) throw new Error(`model must be "provider:modelId": ${model}`);
  return { provider: model.slice(0, idx), modelId: model.slice(idx + 1) };
}
