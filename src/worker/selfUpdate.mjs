/**
 * Worker self-update: when the worker loop is IDLE (never mid-run — see
 * loop.mjs's call sites), detect whether THIS checkout (the bellows repo
 * itself, not config.accordionRepo) is behind origin/main, fast-forward it,
 * and report an "updated" action so the caller can process.exit(0) — the
 * worker's supervisor (a Windows while-loop PowerShell script, or a macOS
 * LaunchAgent's KeepAlive) relaunches node on the new code.
 *
 * Mirrors gitPull.mjs's execFileSync + bounded-timeout style. Refuses to
 * touch a dirty tree, a non-main branch, or a checkout with no `origin`
 * remote — the same machine may be a dev box with in-progress work checked
 * out, and self-update must never clobber it.
 */
import { execFileSync } from "node:child_process";
import { spawnSafe, killTree } from "../runner/proc.mjs";

const GIT_TIMEOUT_MS = 60_000;
const NPM_CI_TIMEOUT_MS = 5 * 60_000;

/** Run git in `repoRoot`, returning trimmed stdout. Throws on nonzero exit. */
function git(repoRoot, args, timeoutMs) {
  return execFileSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** First non-empty stderr line of an execFileSync error (falls back to e.message) — same extraction as accordionRef.mjs's gitErrText. */
function firstErrLine(e) {
  const stderr = typeof e?.stderr === "string" && e.stderr.trim() ? e.stderr : "";
  const source = stderr || (e && e.message ? e.message : String(e));
  const lines = source.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : String(e);
}

/**
 * Short (12-char) HEAD sha of `repoRoot`. Best-effort — returns null (never
 * throws) so worker startup logging/claim payloads can fall back to
 * "unknown" rather than crashing over a git hiccup.
 * @param {string} repoRoot
 * @param {(m:string)=>void} [log]
 * @returns {string|null}
 */
export function currentHeadShort(repoRoot, log = () => {}) {
  try {
    return git(repoRoot, ["rev-parse", "--short=12", "HEAD"], GIT_TIMEOUT_MS);
  } catch (e) {
    log(`[worker] WARN: could not determine HEAD sha of ${repoRoot}: ${firstErrLine(e)}`);
    return null;
  }
}

/**
 * The real `npm ci` runner (default; maybeSelfUpdate tests inject a fake via
 * `runNpmCi` instead of exercising this). Bounded by `timeoutMs` — on expiry
 * the child (and any descendants) is killed, mirroring
 * conductorAdvertise.mjs's enumerateInProcessConductors timeout pattern.
 * Uses spawnSafe (not execFileSync) because npm is a `.cmd` shim on Windows —
 * see proc.mjs's header for why that needs special handling.
 *
 * MUST install dev dependencies (B1, adversarial review): bellows needs
 * vite-node/vite/svelte — all devDependencies — at RUNTIME (run.mjs spawns
 * `node_modules/vite-node/vite-node.mjs` for every in-process run, and
 * conductorAdvertise spawns it on the claim path), and fleet installs use
 * plain `npm install`. An `--omit=dev` here would "succeed", skip the
 * rollback, and relaunch a worker that fails every run. `--include=dev` also
 * defends against a fleet box exporting NODE_ENV=production (which would
 * otherwise make a bare `npm ci` omit dev deps).
 * @param {string} repoRoot
 * @param {number} timeoutMs
 * @param {typeof spawnSafe} [spawnFn]  test seam: capture the spawned arg list
 * @returns {Promise<void>}
 */
export function defaultRunNpmCi(repoRoot, timeoutMs, spawnFn = spawnSafe) {
  return new Promise((resolve, reject) => {
    const child = spawnFn("npm", ["ci", "--include=dev"], {
      cwd: repoRoot,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let err = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killTree(child);
      reject(new Error(`npm ci timed out after ${timeoutMs}ms — killed the child`));
    }, timeoutMs);
    timer.unref?.();
    child.stderr?.on("data", (d) => (err += d));
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`npm ci exited ${code}: ${err.trim().slice(0, 500)}`));
        return;
      }
      resolve();
    });
  });
}

/**
 * Check whether `repoRoot` (the bellows checkout itself) is behind
 * origin/main and, if it's safe, fast-forward it. Called only when the
 * worker loop is idle (see loop.mjs) — never while a run is in flight.
 *
 * Outcome table:
 *   - dirty tree / non-main branch / no origin remote  -> {action:"skipped", reason}
 *   - fetch failure                                     -> {action:"skipped", reason:"fetch failed"}
 *   - HEAD already == origin/main                       -> {action:"current"}
 *   - ff-only merge fails (diverged history)             -> {action:"skipped", reason:"diverged"}
 *   - ff succeeds, no lockfile change                    -> {action:"updated", from, to}
 *   - ff succeeds, lockfile changed, npm ci succeeds      -> {action:"updated", from, to}
 *   - ff succeeds, lockfile changed, npm ci FAILS         -> git reset --hard back to `from`, {action:"rolled-back", reason}
 *     (code rollback only — node_modules may be left partially installed by
 *     the failed npm ci and may need a manual `npm install`; logged as WARN)
 *
 * @param {object} args
 * @param {string} args.repoRoot  the bellows checkout to update
 * @param {(m:string)=>void} [args.log]
 * @param {number} [args.timeoutMs]  per-git-command timeout (default 60s, matches gitPull.mjs's pull timeout)
 * @param {number} [args.npmCiTimeoutMs]  npm ci timeout (default 5 min)
 * @param {(repoRoot:string, timeoutMs:number)=>Promise<void>} [args.runNpmCi]
 *   test seam — replaces the real `npm ci --omit=dev` invocation
 * @returns {Promise<
 *   | {action:"skipped", reason:string}
 *   | {action:"current"}
 *   | {action:"updated", from:string, to:string}
 *   | {action:"rolled-back", reason:string}
 * >}
 */
export async function maybeSelfUpdate({
  repoRoot,
  log = () => {},
  timeoutMs = GIT_TIMEOUT_MS,
  npmCiTimeoutMs = NPM_CI_TIMEOUT_MS,
  runNpmCi = defaultRunNpmCi,
}) {
  // 1. Dirty tree — this machine may also be a dev box with work in progress;
  // never clobber it. Scoped to TRACKED modifications only
  // (--untracked-files=no): operator-local files (trial YAMLs, stray logs)
  // are routine on fleet boxes, a fast-forward never touches untracked paths
  // (git aborts a colliding merge itself, which lands in the "diverged" skip
  // below), and gating on them would silently pin a worker to old code — the
  // exact fleet-drift failure self-update exists to prevent. (A checkout with
  // core.autocrlf drift can still show phantom modified-but-identical TRACKED
  // files here forever — that's a rollout/config problem on that machine, not
  // something to paper over in this check; see TUTORIAL.md's self-update
  // section.)
  let statusOut;
  try {
    statusOut = git(repoRoot, ["status", "--porcelain", "--untracked-files=no"], timeoutMs);
  } catch (e) {
    log(`[worker] self-update WARN: git status --porcelain failed: ${firstErrLine(e)}`);
    return { action: "skipped", reason: "git status failed" };
  }
  if (statusOut) {
    return { action: "skipped", reason: "dirty working tree" };
  }

  // 2. Must be on main — a dev machine may have a feature branch checked out.
  let branch;
  try {
    branch = git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"], timeoutMs);
  } catch (e) {
    log(`[worker] self-update WARN: could not determine current branch: ${firstErrLine(e)}`);
    return { action: "skipped", reason: "could not determine current branch" };
  }
  if (branch !== "main") {
    return { action: "skipped", reason: `HEAD is on "${branch}", not "main"` };
  }

  // 3. Must have an origin remote.
  try {
    git(repoRoot, ["remote", "get-url", "origin"], timeoutMs);
  } catch {
    return { action: "skipped", reason: "no origin remote" };
  }

  // 4. Fetch (bounded timeout — network can hang).
  try {
    git(repoRoot, ["fetch", "origin", "main"], timeoutMs);
  } catch (e) {
    log(`[worker] self-update WARN: git fetch origin main failed: ${firstErrLine(e)} — continuing with the current tree`);
    return { action: "skipped", reason: "fetch failed" };
  }

  const oldHead = git(repoRoot, ["rev-parse", "HEAD"], timeoutMs);
  let remoteHead;
  try {
    remoteHead = git(repoRoot, ["rev-parse", "origin/main"], timeoutMs);
  } catch (e) {
    log(`[worker] self-update WARN: could not resolve origin/main after fetch: ${firstErrLine(e)}`);
    return { action: "skipped", reason: "could not resolve origin/main" };
  }
  if (oldHead === remoteHead) {
    return { action: "current" };
  }

  // 5. Fast-forward only — a diverged history (force-push, or local commits
  // on main) must never be rewritten unattended. Keep running old code.
  try {
    git(repoRoot, ["merge", "--ff-only", "origin/main"], timeoutMs);
  } catch (e) {
    log(`[worker] self-update WARN: fast-forward to origin/main failed (diverged?) — keeping current code: ${firstErrLine(e)}`);
    return { action: "skipped", reason: "diverged" };
  }
  const newHead = git(repoRoot, ["rev-parse", "HEAD"], timeoutMs);

  // 6. A lockfile change means the new code may need different/new deps —
  // reinstall before handing control to it. A diff failure here is
  // best-effort logged and treated as "no lockfile change" rather than
  // blocking the update (the ff already landed; erring towards relaunching
  // on the new code, same as any other worker restart, is safer than
  // getting stuck re-deriving a diff that just failed).
  let changedLockfile = false;
  try {
    const diffOut = git(repoRoot, ["diff", "--name-only", `${oldHead}..${newHead}`], timeoutMs);
    changedLockfile = diffOut.split(/\r?\n/).includes("package-lock.json");
  } catch (e) {
    log(`[worker] self-update WARN: could not diff ${oldHead}..${newHead} for lockfile changes: ${firstErrLine(e)} — skipping npm ci`);
  }

  if (changedLockfile) {
    log(`[worker] self-update: package-lock.json changed (${oldHead.slice(0, 12)}→${newHead.slice(0, 12)}) — running npm ci before relaunch`);
    try {
      await runNpmCi(repoRoot, npmCiTimeoutMs);
    } catch (e) {
      // m1 (adversarial review): this rollback guarantees the CODE is back at
      // oldHead so the relaunch-triggering "updated" path never fires — but a
      // failed `npm ci` may already have torn down / partially replaced
      // node_modules, and nothing here can restore that. Say so loudly rather
      // than implying the tree is fully healed.
      log(`[worker] self-update WARN: npm ci failed after fast-forward — rolling back code to ${oldHead.slice(0, 12)}: ${e.message}`);
      try {
        git(repoRoot, ["reset", "--hard", oldHead], timeoutMs);
      } catch (resetErr) {
        log(`[worker] self-update WARN: rollback (git reset --hard ${oldHead.slice(0, 12)}) ALSO failed: ${firstErrLine(resetErr)} — checkout may be inconsistent, manual intervention required`);
      }
      log(`[worker] self-update WARN: node_modules may be left partially installed by the failed npm ci — if this worker misbehaves, run npm install in ${repoRoot} manually`);
      return { action: "rolled-back", reason: `npm ci failed: ${e.message}` };
    }
  }

  return { action: "updated", from: oldHead, to: newHead };
}
