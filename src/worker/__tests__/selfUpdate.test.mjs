import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { maybeSelfUpdate, currentHeadShort, defaultRunNpmCi } from "../selfUpdate.mjs";

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

// Same fixture shape as accordionRef.test.mjs: a bare-ish "origin" the worker
// repo clones from, plus a "clone" that plays the role of the worker's own
// checkout (`repoRoot`) being self-updated. Real temp git repos, never the
// actual bellows checkout.
describe.skipIf(!GIT_OK)("maybeSelfUpdate", () => {
  let tmp;
  let originRepo;
  let cloneRepo;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bellows-selfupdate-"));
    originRepo = path.join(tmp, "origin");
    cloneRepo = path.join(tmp, "clone");

    fs.mkdirSync(originRepo, { recursive: true });
    run(originRepo, ["init", "-q", "-b", "main"]);
    run(originRepo, ["config", "user.email", "t@t.test"]);
    run(originRepo, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(originRepo, "a.txt"), "one");
    run(originRepo, ["add", "-A"]);
    run(originRepo, ["commit", "-q", "-m", "first"]);

    execFileSync("git", ["clone", "-q", originRepo, cloneRepo], { stdio: ["ignore", "pipe", "pipe"] });
    run(cloneRepo, ["config", "user.email", "t@t.test"]);
    run(cloneRepo, ["config", "user.name", "t"]);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("current: HEAD already matches origin/main -> {action:'current'}, nothing changes", async () => {
    const result = await maybeSelfUpdate({ repoRoot: cloneRepo, log: () => {} });
    expect(result).toEqual({ action: "current" });
  });

  it("behind -> updated: fast-forwards and returns from/to; the clone's HEAD actually moves", async () => {
    fs.writeFileSync(path.join(originRepo, "a.txt"), "two");
    run(originRepo, ["add", "-A"]);
    run(originRepo, ["commit", "-q", "-m", "second"]);
    const newSha = run(originRepo, ["rev-parse", "HEAD"]);
    const oldSha = run(cloneRepo, ["rev-parse", "HEAD"]);

    const logs = [];
    const result = await maybeSelfUpdate({ repoRoot: cloneRepo, log: (m) => logs.push(m) });

    expect(result).toEqual({ action: "updated", from: oldSha, to: newSha });
    expect(run(cloneRepo, ["rev-parse", "HEAD"])).toBe(newSha);
    expect(fs.readFileSync(path.join(cloneRepo, "a.txt"), "utf8")).toBe("two");
  });

  it("dirty working tree -> skipped, never fetches or touches HEAD", async () => {
    fs.writeFileSync(path.join(cloneRepo, "a.txt"), "local edit, uncommitted");
    const before = run(cloneRepo, ["rev-parse", "HEAD"]);

    const result = await maybeSelfUpdate({ repoRoot: cloneRepo, log: () => {} });

    expect(result).toEqual({ action: "skipped", reason: "dirty working tree" });
    expect(run(cloneRepo, ["rev-parse", "HEAD"])).toBe(before);
    expect(fs.readFileSync(path.join(cloneRepo, "a.txt"), "utf8")).toBe("local edit, uncommitted");
  });

  it("an untracked file does NOT count as dirty — operator-local files (trial YAMLs, logs) must not pin a worker to old code", async () => {
    fs.writeFileSync(path.join(cloneRepo, "untracked.txt"), "operator-local file");
    fs.writeFileSync(path.join(originRepo, "a.txt"), "two");
    run(originRepo, ["add", "-A"]);
    run(originRepo, ["commit", "-q", "-m", "second"]);

    const result = await maybeSelfUpdate({ repoRoot: cloneRepo, log: () => {} });

    expect(result.action).toBe("updated");
    // the untracked file survives the fast-forward untouched
    expect(fs.readFileSync(path.join(cloneRepo, "untracked.txt"), "utf8")).toBe("operator-local file");
  });

  it("non-main branch -> skipped, never yanks a feature branch checkout", async () => {
    run(cloneRepo, ["checkout", "-q", "-b", "feature/foo"]);
    const result = await maybeSelfUpdate({ repoRoot: cloneRepo, log: () => {} });
    expect(result.action).toBe("skipped");
    expect(result.reason).toMatch(/feature\/foo/);
  });

  it("no origin remote -> skipped", async () => {
    run(cloneRepo, ["remote", "remove", "origin"]);
    const result = await maybeSelfUpdate({ repoRoot: cloneRepo, log: () => {} });
    expect(result).toEqual({ action: "skipped", reason: "no origin remote" });
  });

  it("diverged history -> ff-only refuses; {action:'skipped', reason:'diverged'}; old code keeps running untouched", async () => {
    // origin advances...
    fs.writeFileSync(path.join(originRepo, "a.txt"), "origin-two");
    run(originRepo, ["add", "-A"]);
    run(originRepo, ["commit", "-q", "-m", "origin-second"]);
    // ...and the local clone ALSO advances independently (diverged history).
    fs.writeFileSync(path.join(cloneRepo, "a.txt"), "local-two");
    run(cloneRepo, ["add", "-A"]);
    run(cloneRepo, ["commit", "-q", "-m", "local-second"]);
    const localHead = run(cloneRepo, ["rev-parse", "HEAD"]);

    const logs = [];
    const result = await maybeSelfUpdate({ repoRoot: cloneRepo, log: (m) => logs.push(m) });

    expect(result).toEqual({ action: "skipped", reason: "diverged" });
    expect(run(cloneRepo, ["rev-parse", "HEAD"])).toBe(localHead); // untouched
    expect(logs.some((m) => m.includes("WARN"))).toBe(true);
  });

  it("lockfile changed -> the injected npm-ci runner is called before reporting updated", async () => {
    fs.writeFileSync(path.join(originRepo, "package-lock.json"), '{"lockfileVersion":3}');
    run(originRepo, ["add", "-A"]);
    run(originRepo, ["commit", "-q", "-m", "bump lockfile"]);
    const newSha = run(originRepo, ["rev-parse", "HEAD"]);

    const fakeRunNpmCi = vi.fn(async () => {});
    const result = await maybeSelfUpdate({ repoRoot: cloneRepo, log: () => {}, runNpmCi: fakeRunNpmCi });

    expect(result).toEqual({ action: "updated", from: expect.any(String), to: newSha });
    expect(fakeRunNpmCi).toHaveBeenCalledTimes(1);
    expect(fakeRunNpmCi.mock.calls[0][0]).toBe(cloneRepo);
  });

  it("no lockfile change -> the npm-ci runner is never called", async () => {
    fs.writeFileSync(path.join(originRepo, "b.txt"), "unrelated change, no lockfile");
    run(originRepo, ["add", "-A"]);
    run(originRepo, ["commit", "-q", "-m", "unrelated"]);

    const fakeRunNpmCi = vi.fn(async () => {});
    const result = await maybeSelfUpdate({ repoRoot: cloneRepo, log: () => {}, runNpmCi: fakeRunNpmCi });

    expect(result.action).toBe("updated");
    expect(fakeRunNpmCi).not.toHaveBeenCalled();
  });

  it("npm ci failure after a lockfile-changing fast-forward -> rolls back HEAD and reports rolled-back", async () => {
    fs.writeFileSync(path.join(originRepo, "package-lock.json"), '{"lockfileVersion":3}');
    run(originRepo, ["add", "-A"]);
    run(originRepo, ["commit", "-q", "-m", "bump lockfile"]);
    const oldSha = run(cloneRepo, ["rev-parse", "HEAD"]);

    const failingRunNpmCi = vi.fn(async () => {
      throw new Error("npm ci: boom");
    });
    const logs = [];
    const result = await maybeSelfUpdate({ repoRoot: cloneRepo, log: (m) => logs.push(m), runNpmCi: failingRunNpmCi });

    expect(result.action).toBe("rolled-back");
    expect(result.reason).toMatch(/npm ci: boom/);
    // HEAD must be back at the pre-update sha — the worker keeps running old code.
    expect(run(cloneRepo, ["rev-parse", "HEAD"])).toBe(oldSha);
    expect(logs.some((m) => m.includes("WARN") && m.includes("rolling back"))).toBe(true);
  });

  it("not a git repo at all -> skipped (git status fails), never throws", async () => {
    const notARepo = path.join(tmp, "not-a-repo");
    fs.mkdirSync(notARepo, { recursive: true });
    const result = await maybeSelfUpdate({ repoRoot: notARepo, log: () => {} });
    expect(result.action).toBe("skipped");
    expect(result.reason).toMatch(/git status failed/);
  });
});

describe("defaultRunNpmCi (B1, adversarial review)", () => {
  /** A fake spawnFn returning an inert child that exits with the given code. */
  function makeSpawnFn(exitCode, calls) {
    return (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      const child = new EventEmitter();
      child.stderr = new EventEmitter();
      setImmediate(() => child.emit("exit", exitCode));
      return child;
    };
  }

  it("must NOT pass --omit=dev: bellows needs devDependencies (vite-node/vite/svelte) at runtime", async () => {
    // An `--omit=dev` npm ci would "succeed", skip the rollback, and relaunch a
    // worker whose every in-process run fails (run.mjs spawns
    // node_modules/vite-node/vite-node.mjs) — a silently bricked worker.
    const calls = [];
    await defaultRunNpmCi("C:/some/repo", 5_000, makeSpawnFn(0, calls));

    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("npm");
    expect(calls[0].args).toContain("ci");
    expect(calls[0].args).not.toContain("--omit=dev");
    // --include=dev defends against a fleet box exporting NODE_ENV=production.
    expect(calls[0].args).toContain("--include=dev");
    expect(calls[0].opts.cwd).toBe("C:/some/repo");
  });

  it("rejects on a nonzero exit code", async () => {
    const calls = [];
    await expect(defaultRunNpmCi("C:/some/repo", 5_000, makeSpawnFn(1, calls))).rejects.toThrow(/npm ci exited 1/);
  });
});

describe.skipIf(!GIT_OK)("currentHeadShort", () => {
  it("returns a 12-char short sha for a real repo", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bellows-headshort-"));
    try {
      run(tmp, ["init", "-q", "-b", "main"]);
      run(tmp, ["config", "user.email", "t@t.test"]);
      run(tmp, ["config", "user.name", "t"]);
      fs.writeFileSync(path.join(tmp, "a.txt"), "x");
      run(tmp, ["add", "-A"]);
      run(tmp, ["commit", "-q", "-m", "first"]);
      const full = run(tmp, ["rev-parse", "HEAD"]);

      expect(currentHeadShort(tmp)).toBe(full.slice(0, 12));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns null (not a throw) for a non-repo path", () => {
    expect(currentHeadShort("C:/definitely/not/a/repo")).toBeNull();
  });
});
