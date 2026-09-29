import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import {
  validateAccordionRef,
  ACCORDION_REF_RE,
  benchRefName,
  resolveRefToSha,
  ensureWorktree,
  worktreePath,
  shortSha,
  resolveEffectiveAccordionRepo,
  provisionWorktree,
  installConductorWsDeps,
  NPM_INSTALL_TIMEOUT_MS,
  LOCK_TIMEOUT_MS,
  LOCK_STALE_MS,
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

  it("ensureWorktree CREATES a detached worktree checked out at the sha", async () => {
    const wt = await ensureWorktree({ accordionRepo: srcRepo, sha: shaB, runsDir });
    expect(wt).toBe(worktreePath(runsDir, shaB));
    expect(fs.existsSync(wt)).toBe(true);
    expect(run(wt, ["rev-parse", "HEAD"])).toBe(shaB);
    // Detached HEAD (no branch).
    expect(() => run(wt, ["symbolic-ref", "-q", "HEAD"])).toThrow();
    // Content matches the pinned commit.
    expect(fs.readFileSync(path.join(wt, "a.txt"), "utf8")).toBe("two");
  });

  it("ensureWorktree REUSES an existing matching worktree (same path, no error)", async () => {
    const wt1 = await ensureWorktree({ accordionRepo: srcRepo, sha: shaB, runsDir });
    // Drop a marker; a reuse must not blow it away.
    const marker = path.join(wt1, "REUSE_MARKER");
    fs.writeFileSync(marker, "x");
    const wt2 = await ensureWorktree({ accordionRepo: srcRepo, sha: shaB, runsDir });
    expect(wt2).toBe(wt1);
    expect(fs.existsSync(marker)).toBe(true); // untouched => reused, not recreated
  });

  it("ensureWorktree re-attempts provisioning on reuse when the worktree matches but was never marked provisioned (bellows #39 follow-up)", async () => {
    const wt = await ensureWorktree({ accordionRepo: srcRepo, sha: shaB, runsDir });
    const marker = path.join(wt, ".bellows-provisioned");
    expect(fs.existsSync(marker)).toBe(true); // provisioned by the call above (no conductors/ws dir -> trivial success)

    // Simulate a worktree that matches the pinned sha but whose provisioning
    // never completed (e.g. a prior run's conductor-deps install failed after
    // the worktree was created, so the marker was never written). Before this
    // fix, ensureWorktree's fast path returned such a worktree unconditionally
    // and provisionWorktree was never called again — this worktree would stay
    // "stuck" forever.
    fs.rmSync(marker, { force: true });
    expect(fs.existsSync(marker)).toBe(false);

    const wt2 = await ensureWorktree({ accordionRepo: srcRepo, sha: shaB, runsDir });
    expect(wt2).toBe(wt);
    // Provisioning was retried (real installConductorWsDeps: no conductors/ws
    // dir here, so it trivially succeeds) and the marker is back.
    expect(fs.existsSync(marker)).toBe(true);
  });

  it("ensureWorktree RECREATES when the dir exists but HEAD mismatches", async () => {
    const wt = worktreePath(runsDir, shaB);
    // Corrupt: force the existing worktree's HEAD to the WRONG commit.
    run(wt, ["checkout", "-q", "--detach", shaA]);
    expect(run(wt, ["rev-parse", "HEAD"])).toBe(shaA); // now mismatched
    const marker = path.join(wt, "REUSE_MARKER");
    fs.writeFileSync(marker, "stale");
    const out = await ensureWorktree({ accordionRepo: srcRepo, sha: shaB, runsDir });
    expect(out).toBe(wt);
    expect(run(wt, ["rev-parse", "HEAD"])).toBe(shaB); // healed back to the pinned sha
    expect(fs.existsSync(marker)).toBe(false); // recreated => stale marker gone
  });

  it("ensureWorktree RECREATES when the dir exists but is not a git worktree (broken)", async () => {
    const sha = shaA;
    const wt = worktreePath(runsDir, sha);
    // Pre-create a plain (non-worktree) directory where the worktree should go.
    fs.mkdirSync(wt, { recursive: true });
    fs.writeFileSync(path.join(wt, "junk.txt"), "not a git worktree");
    const out = await ensureWorktree({ accordionRepo: srcRepo, sha, runsDir });
    expect(out).toBe(wt);
    expect(run(wt, ["rev-parse", "HEAD"])).toBe(sha);
  });

  it("resolveEffectiveAccordionRepo(no ref) returns the base repo unchanged", async () => {
    const eff = await resolveEffectiveAccordionRepo({ accordionRepo: srcRepo, accordionRef: undefined, runsDir });
    expect(eff).toEqual({ repo: srcRepo, ref: null, sha: null });
  });

  it("resolveEffectiveAccordionRepo(ref) resolves to the pinned worktree + sha", async () => {
    const eff = await resolveEffectiveAccordionRepo({ accordionRepo: srcRepo, accordionRef: "pr-branch", runsDir });
    expect(eff.ref).toBe("pr-branch");
    expect(eff.sha).toBe(shaB);
    expect(eff.repo).toBe(worktreePath(runsDir, shaB));
    expect(run(eff.repo, ["rev-parse", "HEAD"])).toBe(shaB);
  });

  it("shortSha is the first 12 chars", () => {
    expect(shortSha(shaB)).toBe(shaB.slice(0, 12));
    expect(shortSha(shaB)).toHaveLength(12);
  });

  // bellows #39 follow-up, 2026-09-30 Fable re-review of #44 — "cross-process
  // variant": acquireLock must wait, not just poll-and-fail. Two concurrent
  // ensureWorktree calls for the SAME sha race for the lockfile; the loser
  // should wait (via the real, non-blocking poll loop) and reuse what the
  // winner created, not throw a lock-timeout error.
  it("two concurrent ensureWorktree calls for the same sha both resolve to the same worktree (real lock contention)", async () => {
    const sha = shaA;
    const [wt1, wt2] = await Promise.all([
      ensureWorktree({ accordionRepo: srcRepo, sha, runsDir }),
      ensureWorktree({ accordionRepo: srcRepo, sha, runsDir }),
    ]);
    expect(wt1).toBe(worktreePath(runsDir, sha));
    expect(wt2).toBe(wt1);
    expect(run(wt1, ["rev-parse", "HEAD"])).toBe(sha);
  });
});

// --- lock/install timeout relationship (bellows #39 follow-up, 2026-09-30
// Fable re-review of #44: "make the lock timeout at least the install
// timeout") -------------------------------------------------------------

describe("lock timeout vs install timeout", () => {
  it("LOCK_TIMEOUT_MS and LOCK_STALE_MS are each >= NPM_INSTALL_TIMEOUT_MS", () => {
    // A holder of the worktree lock may legitimately be mid-install for up to
    // NPM_INSTALL_TIMEOUT_MS. If a waiter's patience (LOCK_TIMEOUT_MS) or the
    // stale-lock steal threshold (LOCK_STALE_MS) were shorter than that, a
    // second process sharing runsDir would throw "timed out waiting for
    // lock" — or steal a still-live holder's lock — while the first was
    // still legitimately installing.
    expect(LOCK_TIMEOUT_MS).toBeGreaterThanOrEqual(NPM_INSTALL_TIMEOUT_MS);
    expect(LOCK_STALE_MS).toBeGreaterThanOrEqual(NPM_INSTALL_TIMEOUT_MS);
  });
});

// --- acquireLock: REAL cross-process contention (bellows #39 follow-up,
// 2026-09-30 Fable re-review of #44, BLOCKING bug) --------------------------
// The in-process "two concurrent ensureWorktree calls" test above cannot
// catch an unref'd wait timer: vitest's own worker process already has other
// ref'd handles alive (its IPC channel back to the main vitest process, etc.)
// keeping the event loop open regardless of any one timer's ref status — so
// the exact bug Fable found (sleep()'s poll timer was unref'd; a waiting
// acquireLock can be the ONLY thing keeping a fresh bellows worker process
// alive, since the heartbeat/telemetry/batcher intervals and undici's idle
// sockets are themselves unref'd and nothing has been spawned yet) never
// reproduces inside that shared process. This test instead runs acquireLock
// inside a bare, freshly-spawned `node` child process with NOTHING else
// keeping its loop alive — exactly the condition Fable reproduced ("the
// unpatched code exits after 1 ms").
describe("acquireLock cross-process contention (real event-loop reproduction)", () => {
  const accordionRefUrl = new URL("../accordionRef.mjs", import.meta.url).href;
  let tmpDir;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "acc-lock-xproc-"));
  });
  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Write a standalone .mjs child script that imports the REAL acquireLock. */
  function writeChildScript(name, body) {
    const p = path.join(tmpDir, name);
    fs.writeFileSync(p, `import { acquireLock } from ${JSON.stringify(accordionRefUrl)};\n${body}\n`);
    return p;
  }

  it(
    "a waiter in an isolated node child process stays alive across the whole lock wait, instead of Node draining the event loop and exiting 0 silently (2026-09-30 Fable repro: unpatched code exits after ~1ms)",
    async () => {
      const lockPath = path.join(tmpDir, `${Date.now()}-${Math.random().toString(36).slice(2)}.lock`);
      const holdMs = 600;

      const holderScript = writeChildScript(
        "holder.mjs",
        [
          "const [, , lockPath, holdMsStr] = process.argv;",
          "const release = await acquireLock(lockPath, () => {}, { pollMs: 50, timeoutMs: 30000, staleMs: 30000 });",
          'process.stdout.write("HOLDING\\n");',
          "await new Promise((r) => setTimeout(r, Number(holdMsStr)));",
          "release();",
          'process.stdout.write("RELEASED\\n");',
        ].join("\n"),
      );
      const waiterScript = writeChildScript(
        "waiter.mjs",
        [
          "const [, , lockPath] = process.argv;",
          "const release = await acquireLock(lockPath, () => {}, { pollMs: 50, timeoutMs: 30000, staleMs: 30000 });",
          'process.stdout.write("ACQUIRED\\n");',
          "release();",
        ].join("\n"),
      );

      const holder = spawn(process.execPath, [holderScript, lockPath, String(holdMs)]);
      let holderOut = "";
      let holderErr = "";
      holder.stdout.on("data", (d) => (holderOut += d));
      holder.stderr.on("data", (d) => (holderErr += d));

      // Don't start the waiter until the holder genuinely has the lock —
      // otherwise both would race for it and the test wouldn't isolate the
      // WAIT path.
      await new Promise((resolve, reject) => {
        const deadline = Date.now() + 10_000;
        const check = setInterval(() => {
          if (holderOut.includes("HOLDING")) {
            clearInterval(check);
            resolve();
          } else if (Date.now() > deadline) {
            clearInterval(check);
            reject(new Error(`holder never reported HOLDING (stderr: ${holderErr})`));
          }
        }, 10);
        holder.once("error", (e) => {
          clearInterval(check);
          reject(e);
        });
      });

      const waiterStart = Date.now();
      const waiter = spawn(process.execPath, [waiterScript, lockPath]);
      let waiterOut = "";
      let waiterErr = "";
      let waiterExited = false;
      let waiterExitCode = null;
      waiter.stdout.on("data", (d) => (waiterOut += d));
      waiter.stderr.on("data", (d) => (waiterErr += d));
      const waiterExitPromise = new Promise((resolve) => {
        waiter.once("exit", (code) => {
          waiterExited = true;
          waiterExitCode = code;
          resolve();
        });
      });

      // The crux of the regression: with the unref'd timer, the waiter's
      // event loop has nothing else keeping it open and Node exits (code 0!)
      // almost immediately — well before the holder has released. Check
      // partway through the hold window that it has NOT already exited.
      await new Promise((r) => setTimeout(r, holdMs * 0.6));
      expect(waiterExited, `waiter exited early (stderr: ${waiterErr})`).toBe(false);

      await waiterExitPromise;
      const elapsed = Date.now() - waiterStart;
      expect(waiterExitCode, `waiter stderr: ${waiterErr}`).toBe(0);
      expect(waiterOut).toContain("ACQUIRED");
      // Genuinely waited out the holder rather than a coincidental fast exit.
      expect(elapsed).toBeGreaterThanOrEqual(holdMs * 0.8);
    },
    15_000,
  );
});

// --- conductors/ws/* dependency install (mocked command runner) --------------
// Mirrors selfUpdate.test.mjs's `defaultRunNpmCi` test seam: a fake spawnFn
// captures the argv/opts a real `spawnSafeSync` call would have received,
// without ever actually invoking npm. installConductorWsDeps is pure fs +
// spawnFn, so these are plain temp-dir fixtures — no scratch git repo needed.

describe("installConductorWsDeps", () => {
  const dirs = [];
  const mkWorktree = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "acc-wsdeps-"));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  /**
   * A fake async/sync-agnostic spawn that records calls and returns a
   * successful SpawnSyncReturns-shape. installConductorWsDeps `await`s
   * whatever this returns, so a plain synchronous return (as here) works
   * identically to the real default (spawnAwaited), which resolves a Promise
   * of the same shape — no test needs to know the difference.
   */
  function makeSpawnFn(calls, { status = 0, stderr = "", error } = {}) {
    return (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return { status, stderr, error };
    };
  }

  function makeWsConductor(worktree, name, { pkgJson = true, lockfile = false, nodeModules = false, partialNodeModules = false } = {}) {
    const dir = path.join(worktree, "conductors", "ws", name);
    fs.mkdirSync(dir, { recursive: true });
    if (pkgJson) fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name }));
    if (lockfile) fs.writeFileSync(path.join(dir, "package-lock.json"), "{}");
    if (nodeModules) {
      // A COMPLETED install: node_modules/.package-lock.json is the sentinel
      // npm writes near the end of a successful `ci`/`install` (see
      // hasCompletedInstall in accordionRef.mjs).
      fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true });
      fs.writeFileSync(path.join(dir, "node_modules", ".package-lock.json"), "{}");
    }
    if (partialNodeModules) {
      // Simulates a killed/timed-out install (bellows #39 follow-up,
      // 2026-09-30 Fable re-review of #44): node_modules exists (npm created
      // it early) but the completed-install sentinel is absent.
      fs.mkdirSync(path.join(dir, "node_modules", "some-half-extracted-pkg"), { recursive: true });
    }
    return dir;
  }

  it("no conductors/ws dir at all -> no-op, spawnFn never called, never throws, returns true", async () => {
    const worktree = mkWorktree();
    const calls = [];
    const result = await installConductorWsDeps(worktree, () => {}, makeSpawnFn(calls));
    expect(calls).toHaveLength(0);
    // A no-op ("nothing needed installing") is a SUCCESS, not a failure —
    // provisionWorktree relies on this to still mark a worktree with no
    // conductors/ws dir as provisioned (bellows #39 follow-up).
    expect(result).toBe(true);
  });

  it("package.json + package-lock.json, no node_modules -> runs `npm ci --no-audit --no-fund` in that dir", async () => {
    const worktree = mkWorktree();
    const dir = makeWsConductor(worktree, "triptych", { lockfile: true });
    const calls = [];
    const logs = [];
    await installConductorWsDeps(worktree, (m) => logs.push(m), makeSpawnFn(calls));

    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("npm");
    expect(calls[0].args).toEqual(["ci", "--no-audit", "--no-fund", "--ignore-scripts"]);
    expect(calls[0].opts.cwd).toBe(dir);
    expect(logs).toContain("[accordionRef] installed deps in conductors/ws/triptych");
  });

  it("returns true when every needed install succeeds", async () => {
    const worktree = mkWorktree();
    makeWsConductor(worktree, "triptych", { lockfile: true });
    const result = await installConductorWsDeps(worktree, () => {}, makeSpawnFn([]));
    expect(result).toBe(true);
  });

  it("package.json with NO package-lock.json -> falls back to `npm install --no-audit --no-fund --ignore-scripts`", async () => {
    const worktree = mkWorktree();
    makeWsConductor(worktree, "thermocline", { lockfile: false });
    const calls = [];
    await installConductorWsDeps(worktree, () => {}, makeSpawnFn(calls));

    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(["install", "--no-audit", "--no-fund", "--ignore-scripts"]);
  });

  it("a COMPLETED node_modules (sentinel present) -> skipped, spawnFn never called for that dir (idempotent)", async () => {
    const worktree = mkWorktree();
    makeWsConductor(worktree, "triptych", { lockfile: true, nodeModules: true });
    const calls = [];
    const logs = [];
    await installConductorWsDeps(worktree, (m) => logs.push(m), makeSpawnFn(calls));

    expect(calls).toHaveLength(0);
    expect(logs).toHaveLength(0);
  });

  // bellows #39 follow-up, 2026-09-30 Fable re-review of #44: "the
  // node_modules existence check must not treat a partial extract as done."
  it("a PARTIAL node_modules (no completed-install sentinel) is NOT treated as already-installed -> reinstalled", async () => {
    const worktree = mkWorktree();
    const dir = makeWsConductor(worktree, "triptych", { lockfile: true, partialNodeModules: true });
    expect(fs.existsSync(path.join(dir, "node_modules"))).toBe(true); // the old (insufficient) check's signal
    expect(fs.existsSync(path.join(dir, "node_modules", ".package-lock.json"))).toBe(false);
    const calls = [];
    const result = await installConductorWsDeps(worktree, () => {}, makeSpawnFn(calls));

    expect(calls).toHaveLength(1); // reinstalled, not skipped
    expect(calls[0].args[0]).toBe("ci");
    expect(result).toBe(true);
  });

  it("a dir with no package.json (stray file/dir under conductors/ws) is skipped", async () => {
    const worktree = mkWorktree();
    fs.mkdirSync(path.join(worktree, "conductors", "ws", "not-a-conductor"), { recursive: true });
    fs.writeFileSync(path.join(worktree, "conductors", "ws", "README.md"), "not a dir"); // stray file entry
    const calls = [];
    await expect(installConductorWsDeps(worktree, () => {}, makeSpawnFn(calls))).resolves.toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("installs each conductor that needs it, independently, in one pass", async () => {
    const worktree = mkWorktree();
    makeWsConductor(worktree, "triptych", { lockfile: true }); // needs ci
    makeWsConductor(worktree, "thermocline", { lockfile: false }); // needs install
    makeWsConductor(worktree, "already-done", { lockfile: true, nodeModules: true }); // skipped
    const calls = [];
    const logs = [];
    await installConductorWsDeps(worktree, (m) => logs.push(m), makeSpawnFn(calls));

    expect(calls).toHaveLength(2);
    const byDir = Object.fromEntries(calls.map((c) => [path.basename(c.opts.cwd), c.args]));
    expect(byDir["triptych"]).toEqual(["ci", "--no-audit", "--no-fund", "--ignore-scripts"]);
    expect(byDir["thermocline"]).toEqual(["install", "--no-audit", "--no-fund", "--ignore-scripts"]);
    expect(byDir["already-done"]).toBeUndefined();
    expect(logs).toContain("[accordionRef] installed deps in conductors/ws/triptych");
    expect(logs).toContain("[accordionRef] installed deps in conductors/ws/thermocline");
  });

  it("nonzero exit -> logs a WARN with the exit code and stderr, does NOT throw", async () => {
    const worktree = mkWorktree();
    makeWsConductor(worktree, "triptych", { lockfile: true });
    const calls = [];
    const logs = [];
    const spawnFn = makeSpawnFn(calls, { status: 1, stderr: "npm ERR! network timeout\n" });
    await expect(installConductorWsDeps(worktree, (m) => logs.push(m), spawnFn)).resolves.toBe(false);

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/WARN/);
    expect(logs[0]).toContain("conductors/ws/triptych");
    expect(logs[0]).toContain("exit 1");
    expect(logs[0]).toContain("npm ERR! network timeout");
  });

  it("returns false when an install exits nonzero (bellows #39: signals provisionWorktree to not mark success)", async () => {
    const worktree = mkWorktree();
    makeWsConductor(worktree, "triptych", { lockfile: true });
    const spawnFn = makeSpawnFn([], { status: 1, stderr: "npm ERR! network timeout\n" });
    const result = await installConductorWsDeps(worktree, () => {}, spawnFn);
    expect(result).toBe(false);
  });

  it("spawn error (e.g. ENOENT — npm not on PATH) -> logs a WARN, does NOT throw", async () => {
    const worktree = mkWorktree();
    makeWsConductor(worktree, "triptych", { lockfile: true });
    const calls = [];
    const logs = [];
    const spawnFn = makeSpawnFn(calls, { error: Object.assign(new Error("spawnSync npm ENOENT"), { code: "ENOENT" }) });
    await expect(installConductorWsDeps(worktree, (m) => logs.push(m), spawnFn)).resolves.toBe(false);

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/WARN/);
    expect(logs[0]).toContain("ENOENT");
  });

  it("returns false on a spawn error", async () => {
    const worktree = mkWorktree();
    makeWsConductor(worktree, "triptych", { lockfile: true });
    const spawnFn = makeSpawnFn([], { error: Object.assign(new Error("spawnSync npm ENOENT"), { code: "ENOENT" }) });
    await expect(installConductorWsDeps(worktree, () => {}, spawnFn)).resolves.toBe(false);
  });

  it("a spawnFn that itself throws -> caught, logged as a WARN, does NOT throw or abort remaining dirs", async () => {
    const worktree = mkWorktree();
    makeWsConductor(worktree, "triptych", { lockfile: true });
    makeWsConductor(worktree, "thermocline", { lockfile: false });
    const logs = [];
    let calls = 0;
    const throwingSpawnFn = () => {
      calls += 1;
      throw new Error("boom");
    };
    await expect(installConductorWsDeps(worktree, (m) => logs.push(m), throwingSpawnFn)).resolves.toBe(false);

    expect(calls).toBe(2); // both dirs attempted despite the first throwing
    expect(logs.filter((m) => m.includes("WARN") && m.includes("boom"))).toHaveLength(2);
  });

  it("returns false when a throwing spawnFn fails every dir", async () => {
    const worktree = mkWorktree();
    makeWsConductor(worktree, "triptych", { lockfile: true });
    const throwingSpawnFn = () => {
      throw new Error("boom");
    };
    await expect(installConductorWsDeps(worktree, () => {}, throwingSpawnFn)).resolves.toBe(false);
  });

  it("returns false overall when only ONE of several conductors fails (a partial failure is still a failure)", async () => {
    const worktree = mkWorktree();
    makeWsConductor(worktree, "triptych", { lockfile: true }); // will succeed
    makeWsConductor(worktree, "thermocline", { lockfile: false }); // will fail
    const spawnFn = (cmd, args, opts) => {
      if (path.basename(opts.cwd) === "thermocline") return { status: 1, stderr: "boom" };
      return { status: 0, stderr: "" };
    };
    await expect(installConductorWsDeps(worktree, () => {}, spawnFn)).resolves.toBe(false);
  });

  // --- failure-memo backoff (bellows #39 follow-up, 2026-09-30 Fable re-review
  // of #44: "add a failure memo with backoff per (SHA, workspace), so repeated
  // failures fail fast instead of hanging each run") -----------------------

  const FAILURE_MEMO_NAME = ".bellows-install-failed.json"; // must match accordionRef.mjs's PROVISION_FAILURE_MEMO_NAME

  it("a failed install writes a failure memo into the conductor's own dir", async () => {
    const worktree = mkWorktree();
    const dir = makeWsConductor(worktree, "triptych", { lockfile: true });
    const spawnFn = makeSpawnFn([], { status: 1, stderr: "npm ERR! registry unreachable\n" });
    await installConductorWsDeps(worktree, () => {}, spawnFn);

    const memoPath = path.join(dir, FAILURE_MEMO_NAME);
    expect(fs.existsSync(memoPath)).toBe(true);
    const memo = JSON.parse(fs.readFileSync(memoPath, "utf8"));
    expect(typeof memo.at).toBe("string");
    expect(memo.message).toContain("registry unreachable");
  });

  it("a RECENT failure memo makes the next call skip re-spawning npm entirely (fail fast)", async () => {
    const worktree = mkWorktree();
    const dir = makeWsConductor(worktree, "triptych", { lockfile: true });
    fs.writeFileSync(path.join(dir, FAILURE_MEMO_NAME), JSON.stringify({ at: new Date().toISOString(), message: "npm ERR! registry unreachable" }));
    const calls = [];
    const logs = [];
    const result = await installConductorWsDeps(worktree, (m) => logs.push(m), makeSpawnFn(calls));

    expect(calls).toHaveLength(0); // never re-attempted npm at all
    expect(result).toBe(false);
    expect(logs.some((m) => m.includes("WARN") && m.includes("skipping npm install") && m.includes("triptych"))).toBe(true);
  });

  it("a STALE failure memo (older than the backoff window) is retried normally", async () => {
    const worktree = mkWorktree();
    const dir = makeWsConductor(worktree, "triptych", { lockfile: true });
    const longAgo = new Date(Date.now() - 60 * 60_000).toISOString(); // 1h ago >> the backoff window
    fs.writeFileSync(path.join(dir, FAILURE_MEMO_NAME), JSON.stringify({ at: longAgo, message: "npm ERR! registry unreachable" }));
    const calls = [];
    const result = await installConductorWsDeps(worktree, () => {}, makeSpawnFn(calls));

    expect(calls).toHaveLength(1); // retried, not skipped
    expect(result).toBe(true);
  });

  it("a successful retry clears the failure memo so a later call doesn't skip", async () => {
    const worktree = mkWorktree();
    const dir = makeWsConductor(worktree, "triptych", { lockfile: true });
    const longAgo = new Date(Date.now() - 60 * 60_000).toISOString();
    const memoPath = path.join(dir, FAILURE_MEMO_NAME);
    fs.writeFileSync(memoPath, JSON.stringify({ at: longAgo, message: "npm ERR! registry unreachable" }));

    await installConductorWsDeps(worktree, () => {}, makeSpawnFn([])); // succeeds
    expect(fs.existsSync(memoPath)).toBe(false);
  });
});

// --- provisionWorktree: installDeps wiring + marker idempotency --------------

describe("provisionWorktree — conductor deps wiring", () => {
  const dirs = [];
  const mkWorktree = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "acc-provision-"));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it("calls installDeps(worktree, log) once on first provisioning", async () => {
    const worktree = mkWorktree();
    const accordionRepo = mkWorktree(); // no app/tsconfig.json -> stub step is a no-op
    const installDeps = vi.fn();
    await provisionWorktree({ accordionRepo, worktree, log: () => {}, installDeps });

    expect(installDeps).toHaveBeenCalledTimes(1);
    expect(installDeps.mock.calls[0][0]).toBe(worktree);
    expect(typeof installDeps.mock.calls[0][1]).toBe("function");
  });

  it("does NOT call installDeps again once the .bellows-provisioned marker exists (reuse)", async () => {
    const worktree = mkWorktree();
    const accordionRepo = mkWorktree();
    const installDeps = vi.fn();
    await provisionWorktree({ accordionRepo, worktree, log: () => {}, installDeps });
    await provisionWorktree({ accordionRepo, worktree, log: () => {}, installDeps });

    expect(installDeps).toHaveBeenCalledTimes(1);
  });

  it("defaults installDeps to the real installConductorWsDeps (no conductors/ws dir -> harmless no-op)", async () => {
    const worktree = mkWorktree();
    const accordionRepo = mkWorktree();
    // No injected installDeps: exercises the real default wiring end-to-end.
    await expect(provisionWorktree({ accordionRepo, worktree, log: () => {} })).resolves.not.toThrow();
    expect(fs.existsSync(path.join(worktree, ".bellows-provisioned"))).toBe(true);
  });

  // bellows #39 follow-up: "the install marker should ideally only be written
  // on success" — a failed installDeps must NOT leave .bellows-provisioned
  // behind, or a broken worktree looks permanently "done" to every later run.
  it("does NOT write the marker when installDeps returns false (failed install)", async () => {
    const worktree = mkWorktree();
    const accordionRepo = mkWorktree();
    const installDeps = vi.fn(() => false);
    const logs = [];
    await provisionWorktree({ accordionRepo, worktree, log: (m) => logs.push(m), installDeps });

    expect(fs.existsSync(path.join(worktree, ".bellows-provisioned"))).toBe(false);
    expect(logs.some((m) => m.includes("WARN") && m.includes("did not fully succeed"))).toBe(true);
  });

  it("retries installDeps on a later call after a failed install left no marker", async () => {
    const worktree = mkWorktree();
    const accordionRepo = mkWorktree();
    const installDeps = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);

    await provisionWorktree({ accordionRepo, worktree, log: () => {}, installDeps }); // fails, no marker
    expect(fs.existsSync(path.join(worktree, ".bellows-provisioned"))).toBe(false);

    await provisionWorktree({ accordionRepo, worktree, log: () => {}, installDeps }); // retried, succeeds
    expect(installDeps).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(path.join(worktree, ".bellows-provisioned"))).toBe(true);
  });

  it("a bare vi.fn() (returns undefined) still counts as success and writes the marker", async () => {
    // Guards the exact compatibility case the marker-gating logic must not
    // break: callers/tests that pass installDeps without bothering to return
    // anything must be treated as success, only an explicit `false` is failure.
    const worktree = mkWorktree();
    const accordionRepo = mkWorktree();
    const installDeps = vi.fn();
    await provisionWorktree({ accordionRepo, worktree, log: () => {}, installDeps });
    expect(fs.existsSync(path.join(worktree, ".bellows-provisioned"))).toBe(true);
  });

  it("installDeps returning a Promise<false> (the real installConductorWsDeps' shape) is awaited before deciding the marker", async () => {
    const worktree = mkWorktree();
    const accordionRepo = mkWorktree();
    const installDeps = vi.fn(() => Promise.resolve(false));
    await provisionWorktree({ accordionRepo, worktree, log: () => {}, installDeps });
    expect(fs.existsSync(path.join(worktree, ".bellows-provisioned"))).toBe(false);
  });
});
