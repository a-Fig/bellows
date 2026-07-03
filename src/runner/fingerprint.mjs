/**
 * Fingerprint computation — the identity used to compare runs across trials.
 * Conforms to src/types.ts (Fingerprint).
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, execSync } from "node:child_process";
import { REPO_ROOT, normalizeProblems } from "./config.mjs";

/** bellows version, read from package.json (stable input to the fingerprint). */
export function bellowsVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** `pi --version`. Best-effort; returns "unknown" on failure.
 *  Uses execSync with a single command string so Windows resolves the pi.cmd
 *  shim via the shell without the args-array deprecation warning (DEP0190). */
export function piVersion() {
  try {
    const out = execSync("pi --version", {
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim().split(/\r?\n/)[0] || "unknown";
  } catch (e) {
    return `unknown(${e.code || e.message || "err"})`;
  }
}

/** git HEAD of the accordion checkout. Best-effort; "unknown" on failure. */
export function accordionCommit(accordionRepo) {
  try {
    const out = execFileSync("git", ["-C", accordionRepo, "rev-parse", "HEAD"], {
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
    });
    return out.trim();
  } catch (e) {
    return `unknown(${e.code || e.message || "err"})`;
  }
}

/**
 * sha256 over the contents of a directory tree, deterministic across platforms.
 * Hashes each file's POSIX-relative path + a NUL + its bytes, in sorted order.
 * @param {string} dir
 */
export function hashDir(dir) {
  const h = crypto.createHash("sha256");
  const files = [];
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile()) files.push(full);
    }
  };
  walk(dir);
  files
    .map((f) => ({ rel: path.relative(dir, f).split(path.sep).join("/"), full: f }))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
    .forEach(({ rel, full }) => {
      h.update(rel);
      h.update("\0");
      h.update(fs.readFileSync(full));
      h.update("\0");
    });
  return h.digest("hex");
}

/** sha256 of a string. */
export function hashString(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

/**
 * Build the parts of the Fingerprint that are shared across all runs of a trial.
 * Per-run fields (conductorId) are filled in by the caller.
 * @param {object} args
 * @param {import("../types.ts").TrialSpec} args.spec
 * @param {import("../types.ts").BenchConfig} args.config
 * @param {string} args.workspaceTemplateDir
 * @param {string} args.kickoffPrompt
 * @returns {Omit<import("../types.ts").Fingerprint, "conductorId">}
 */
export function sharedFingerprint({ spec, config, workspaceTemplateDir, kickoffPrompt }) {
  return {
    model: spec.model,
    thinkingLevel: spec.thinkingLevel || "medium",
    budget: spec.budget,
    protectTokens: spec.protectTokens,
    problems: normalizeProblems(spec.problems),
    workspaceTemplateHash: hashDir(workspaceTemplateDir),
    kickoffPromptHash: hashString(kickoffPrompt),
    piVersion: piVersion(),
    accordionCommit: accordionCommit(config.accordionRepo),
    conductorId: "", // filled per run
    bellowsVersion: bellowsVersion(),
  };
}
