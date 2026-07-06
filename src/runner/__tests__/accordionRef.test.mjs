import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  validateAccordionRef,
  ACCORDION_REF_RE,
  benchRefName,
  resolveRefToSha,
  ensureWorktree,
  worktreePath,
  shortSha,
  resolveEffectiveAccordionRepo,
} from "../accordionRef.mjs";

// --- validation --------------------------------------------------------------

describe("validateAccordionRef", () => {
  it("accepts branch/tag/SHA-shaped refs", () => {
    for (const ref of [
      "main",
      "claude/happy-fermat-8b7485",
      "v1.2.3",
      "feature/foo_bar-baz",
      "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    ]) {
      expect(validateAccordionRef(ref)).toBe(ref);
      expect(ACCORDION_REF_RE.test(ref)).toBe(true);
    }
  });

  it("rejects a ref that starts with '-' (would be a git flag)", () => {
    expect(() => validateAccordionRef("--upload-pack=evil")).toThrow(/must not start with "-"/);
    expect(() => validateAccordionRef("-x")).toThrow(/must not start with "-"/);
  });

  it("rejects empty / non-string / disallowed characters", () => {
    expect(() => validateAccordionRef("")).toThrow();
    expect(() => validateAccordionRef(undefined)).toThrow();
    expect(() => validateAccordionRef("has space")).toThrow(/must match/);
    expect(() => validateAccordionRef("semi;colon")).toThrow(/must match/);
    expect(() => validateAccordionRef("$(evil)")).toThrow(/must match/);
  });

  it("rejects an over-long ref (>200 chars)", () => {
    expect(() => validateAccordionRef("a".repeat(201))).toThrow(/must match/);
    expect(validateAccordionRef("a".repeat(200))).toHaveLength(200);
  });
});

// --- worktree create / reuse / mismatch-recreate ------------------------------
// A scratch temp git repo fixture — never the real accordion repo.

const GIT_OK = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

function run(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

describe.skipIf(!GIT_OK)("worktree create/reuse/mismatch (scratch git repo)", () => {
  let tmp;
  let originRepo; // a "remote" the source checkout fetches from
  let srcRepo; // the accordionRepo (has origin -> originRepo)
  let runsDir;
  let shaA;
  let shaB;

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "acc-ref-test-"));
    originRepo = path.join(tmp, "origin");
    srcRepo = path.join(tmp, "src");
    runsDir = path.join(tmp, "runs");
    fs.mkdirSync(runsDir, { recursive: true });

    // Build the origin repo with two commits on two branches.
    fs.mkdirSync(originRepo, { recursive: true });
    run(originRepo, ["init", "-q", "-b", "main"]);
    run(originRepo, ["config", "user.email", "t@t.test"]);
    run(originRepo, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(originRepo, "a.txt"), "one");
    run(originRepo, ["add", "-A"]);
    run(originRepo, ["commit", "-q", "-m", "first"]);
    shaA = run(originRepo, ["rev-parse", "HEAD"]);
    // A second branch (the "PR branch") with a distinct commit.
    run(originRepo, ["checkout", "-q", "-b", "pr-branch"]);
    fs.writeFileSync(path.join(originRepo, "a.txt"), "two");
    run(originRepo, ["add", "-A"]);
    run(originRepo, ["commit", "-q", "-m", "second"]);
    shaB = run(originRepo, ["rev-parse", "HEAD"]);
    run(originRepo, ["checkout", "-q", "main"]);

    // Clone into src (gives src an `origin` remote). Clone gets both branches.
    execFileSync("git", ["clone", "-q", originRepo, srcRepo], { stdio: ["ignore", "pipe", "pipe"] });
    run(srcRepo, ["config", "user.email", "t@t.test"]);
    run(srcRepo, ["config", "user.name", "t"]);
  });

  afterAll(() => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("resolveRefToSha fetches a branch from origin and returns its full SHA", () => {
    const sha = resolveRefToSha(srcRepo, "pr-branch");
    expect(sha).toBe(shaB);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("resolveRefToSha resolves a bare SHA too", () => {
    expect(resolveRefToSha(srcRepo, shaA)).toBe(shaA);
  });

  it("resolveRefToSha throws on an unknown ref", () => {
    expect(() => resolveRefToSha(srcRepo, "no-such-branch")).toThrow(/could not resolve/);
  });

  it("the unknown-ref error carries git's actual reason, not the 'Command failed' wrapper", () => {
    let err = null;
    try {
      resolveRefToSha(srcRepo, "no-such-branch");
    } catch (e) {
      err = e;
    }
    expect(err).toBeTruthy();
    expect(err.message).toMatch(/could not resolve/);
    // The actionable git reason (last non-empty stderr line, e.g. "fatal:
    // couldn't find remote ref ..."), not execFileSync's generic wrapper line.
    expect(err.message).toMatch(/couldn't find remote ref|no such ref|not our ref|fatal/i);
    expect(err.message).not.toMatch(/Command failed: git/);
  });

  it("resolution pins a private per-ref refspec and never depends on FETCH_HEAD (race-free)", () => {
    const sha = resolveRefToSha(srcRepo, "pr-branch");
    expect(sha).toBe(shaB);
    // The pin landed on the private ref named by the ref STRING's sha1...
    expect(run(srcRepo, ["rev-parse", benchRefName("pr-branch")])).toBe(shaB);
    // ...so a concurrent fetch of a DIFFERENT ref clobbering FETCH_HEAD (the old
    // strategy's last-writer-wins hazard) cannot perturb re-resolution.
    run(srcRepo, ["fetch", "origin", "main"]);
    expect(run(srcRepo, ["rev-parse", "FETCH_HEAD"])).toBe(shaA); // FETCH_HEAD now points elsewhere
    expect(resolveRefToSha(srcRepo, "pr-branch")).toBe(shaB); // still correct
  });

  it("benchRefName: distinct ref strings map to distinct private refs; same ref is stable", () => {
    expect(benchRefName("pr-branch")).toBe(benchRefName("pr-branch"));
    expect(benchRefName("pr-branch")).not.toBe(benchRefName("main"));
    expect(benchRefName("a/b")).toMatch(/^refs\/bellows-bench\/[0-9a-f]{40}$/);
  });

  it("ensureWorktree CREATES a detached worktree checked out at the sha", () => {
    const wt = ensureWorktree({ accordionRepo: srcRepo, sha: shaB, runsDir });
    expect(wt).toBe(worktreePath(runsDir, shaB));
    expect(fs.existsSync(wt)).toBe(true);
    expect(run(wt, ["rev-parse", "HEAD"])).toBe(shaB);
    // Detached HEAD (no branch).
    expect(() => run(wt, ["symbolic-ref", "-q", "HEAD"])).toThrow();
    // Content matches the pinned commit.
    expect(fs.readFileSync(path.join(wt, "a.txt"), "utf8")).toBe("two");
  });

  it("ensureWorktree REUSES an existing matching worktree (same path, no error)", () => {
    const wt1 = ensureWorktree({ accordionRepo: srcRepo, sha: shaB, runsDir });
    // Drop a marker; a reuse must not blow it away.
    const marker = path.join(wt1, "REUSE_MARKER");
    fs.writeFileSync(marker, "x");
    const wt2 = ensureWorktree({ accordionRepo: srcRepo, sha: shaB, runsDir });
    expect(wt2).toBe(wt1);
    expect(fs.existsSync(marker)).toBe(true); // untouched => reused, not recreated
  });

  it("ensureWorktree RECREATES when the dir exists but HEAD mismatches", () => {
    const wt = worktreePath(runsDir, shaB);
    // Corrupt: force the existing worktree's HEAD to the WRONG commit.
    run(wt, ["checkout", "-q", "--detach", shaA]);
    expect(run(wt, ["rev-parse", "HEAD"])).toBe(shaA); // now mismatched
    const marker = path.join(wt, "REUSE_MARKER");
    fs.writeFileSync(marker, "stale");
    const out = ensureWorktree({ accordionRepo: srcRepo, sha: shaB, runsDir });
    expect(out).toBe(wt);
    expect(run(wt, ["rev-parse", "HEAD"])).toBe(shaB); // healed back to the pinned sha
    expect(fs.existsSync(marker)).toBe(false); // recreated => stale marker gone
  });

  it("ensureWorktree RECREATES when the dir exists but is not a git worktree (broken)", () => {
    const sha = shaA;
    const wt = worktreePath(runsDir, sha);
    // Pre-create a plain (non-worktree) directory where the worktree should go.
    fs.mkdirSync(wt, { recursive: true });
    fs.writeFileSync(path.join(wt, "junk.txt"), "not a git worktree");
    const out = ensureWorktree({ accordionRepo: srcRepo, sha, runsDir });
    expect(out).toBe(wt);
    expect(run(wt, ["rev-parse", "HEAD"])).toBe(sha);
  });

  it("resolveEffectiveAccordionRepo(no ref) returns the base repo unchanged", () => {
    const eff = resolveEffectiveAccordionRepo({ accordionRepo: srcRepo, accordionRef: undefined, runsDir });
    expect(eff).toEqual({ repo: srcRepo, ref: null, sha: null });
  });

  it("resolveEffectiveAccordionRepo(ref) resolves to the pinned worktree + sha", () => {
    const eff = resolveEffectiveAccordionRepo({ accordionRepo: srcRepo, accordionRef: "pr-branch", runsDir });
    expect(eff.ref).toBe("pr-branch");
    expect(eff.sha).toBe(shaB);
    expect(eff.repo).toBe(worktreePath(runsDir, shaB));
    expect(run(eff.repo, ["rev-parse", "HEAD"])).toBe(shaB);
  });

  it("shortSha is the first 12 chars", () => {
    expect(shortSha(shaB)).toBe(shaB.slice(0, 12));
    expect(shortSha(shaB)).toHaveLength(12);
  });
});
