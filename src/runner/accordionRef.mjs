/**
 * accordionRef.mjs — resolve a per-trial `accordionRef` (any git rev the
 * accordion repo's origin knows: branch, tag, SHA) to a pinned, detached git
 * worktree, so a run can bench a specific branch/PR WITHOUT disturbing the main
 * checkout's working tree.
 *
 * Absent ref => callers use `config.accordionRepo` as-is (today's behavior). When
 * set, `resolveAccordionRef` returns the path of a reusable worktree checked out
 * at the resolved SHA; every downstream consumer (settings extensions path,
 * external-conductor launch dir, fingerprint's accordionCommit, the host's
 * BELLOWS_ACCORDION_REPO env) uses that path as the EFFECTIVE accordion repo.
 *
 * Dependency note (proven, not hand-waved): a fresh worktree has no node_modules,
 * but the bellows host imports only pure TS/rune modules from the checkout
 * (store.svelte.ts, live/mapping.ts, live/plan.ts, engine/tokens.ts,
 * conductors/index.ts). Those resolve their `svelte` runtime from BELLOWS's own
 * node_modules (vite-node.config.ts `noExternal: ["svelte"]`) and reach the
 * conductor barrel via the `$conductors` alias into the worktree's own
 * conductors/ dir — whose registered in-process conductors import only `./contract`
 * + node builtins. The pi `extension/accordion.ts` path is loaded by PI (which
 * provides ws/typebox/@earendil-works at runtime), never by bellows. So NO
 * `npm install` in the worktree is required for enumeration or an in-process host
 * run.
 *
 * External-conductor `conductors/ws/*` packages are a DIFFERENT story: they run
 * out-of-process (spawned directly, not imported by the host) and DO need their
 * own node_modules — e.g. `conductors/ws/triptych` needs `web-tree-sitter` +
 * `tree-sitter-wasms` for code skeletonization. provisionWorktree installs those
 * (see installConductorWsDeps below) so a trial pinning an accordionRef can
 * still dispatch to an out-of-process conductor without a manual `npm ci`.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { spawnSafe, killTree } from "./proc.mjs";

/** git rev must be a plausible branch/tag/SHA and must not look like a flag. */
export const ACCORDION_REF_RE = /^[A-Za-z0-9._/-]{1,200}$/;

/** Throw if `ref` is not a well-formed, non-flag git rev. Returns the ref. */
export function validateAccordionRef(ref) {
  if (typeof ref !== "string" || !ref.trim()) {
    throw new Error("accordionRef: must be a non-empty string");
  }
  if (ref.startsWith("-")) {
    throw new Error(`accordionRef: "${ref}" must not start with "-" (would be parsed as a git flag)`);
  }
  if (!ACCORDION_REF_RE.test(ref)) {
    throw new Error(`accordionRef: "${ref}" must match ${ACCORDION_REF_RE} (branch, tag, or SHA)`);
  }
  return ref;
}

/** Run git in `repo`, returning trimmed stdout. Throws on nonzero exit. */
function git(repo, args, timeoutMs = 120_000) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/**
 * Extract the ACTIONABLE git failure reason from an execFileSync error.
 * e.message's first line is always the generic "Command failed: git ..." wrapper;
 * the real reason (auth failure / ref not found / offline) is on stderr. Use the
 * last non-empty stderr line, falling back to the last non-empty message line.
 */
function gitErrText(e) {
  const stderr = typeof e?.stderr === "string" && e.stderr.trim() ? e.stderr : "";
  const source = stderr || (e && e.message ? e.message : String(e));
  const lines = source
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length ? lines[lines.length - 1] : String(e);
}

/** Run git without throwing; return {ok, out, err} (err = actionable reason). */
function gitTry(repo, args, timeoutMs = 120_000) {
  try {
    return { ok: true, out: git(repo, args, timeoutMs), err: "" };
  } catch (e) {
    return { ok: false, out: "", err: gitErrText(e) };
  }
}

/**
 * The private per-ref fetch destination: `refs/bellows-bench/<sha1-of-ref-string>`.
 * Distinct ref STRINGS map to distinct ref files, so two concurrent runs fetching
 * different refs can never clobber each other's resolution (unlike FETCH_HEAD,
 * which is a single last-writer-wins file); the SAME ref string maps to the same
 * file with the same content — a benign overwrite.
 */
export function benchRefName(ref) {
  return `refs/bellows-bench/${crypto.createHash("sha1").update(ref, "utf8").digest("hex")}`;
}

/**
 * Fetch `ref` from origin and resolve it to a full 40-char SHA — RACE-FREE.
 *
 * Strategy: fetch with an explicit private refspec (`+<ref>:refs/bellows-bench/<h>`)
 * and rev-parse THAT ref. Resolution never reads FETCH_HEAD and never consults
 * `origin/<ref>` (whose update by a concurrent fetch of a different ref is not our
 * signal). For a bare-SHA ref the server may refuse a want-sha fetch
 * (uploadpack.allowAnySHA1InWant is commonly off) — fall back to resolving the SHA
 * directly against the local object store (the object is usually already present).
 * A nonexistent ref fails both paths => clear error carrying git's actual reason.
 *
 * @param {string} accordionRepo
 * @param {string} ref
 * @param {(m:string)=>void} [log]
 * @returns {string} full SHA
 */
export function resolveRefToSha(accordionRepo, ref, log = () => {}) {
  validateAccordionRef(ref);
  const dst = benchRefName(ref);
  const fetched = gitTry(accordionRepo, ["fetch", "origin", `+${ref}:${dst}`]);
  if (fetched.ok) {
    // `^{commit}` peels an annotated tag to its commit.
    const r = gitTry(accordionRepo, ["rev-parse", "--verify", `${dst}^{commit}`]);
    if (r.ok && /^[0-9a-f]{40}$/.test(r.out)) return r.out;
  } else {
    log(`[accordionRef] WARN: git fetch origin +${ref}:${dst} failed (${fetched.err})`);
    // Bare-SHA fallback: the fetch was refused/failed, but the object may already
    // be in the local store (a prior fetch/clone brought it in).
    if (/^[0-9a-f]{4,40}$/i.test(ref)) {
      const r = gitTry(accordionRepo, ["rev-parse", "--verify", `${ref}^{commit}`]);
      if (r.ok && /^[0-9a-f]{40}$/.test(r.out)) return r.out;
    }
  }
  throw new Error(
    `accordionRef: could not resolve "${ref}" from origin of ${accordionRepo}` +
      (fetched.ok ? ` (fetched, but ${dst} did not resolve to a commit)` : ` (git fetch failed: ${fetched.err})`),
  );
}

/** The first 12 chars of a SHA — the pinned worktree's dir name. */
export function shortSha(sha) {
  return sha.slice(0, 12);
}

/** The pinned-worktree path for a given runsDir + SHA. */
export function worktreePath(runsDir, sha) {
  return path.join(runsDir, "_accordion", shortSha(sha));
}

/**
 * Create (or reuse) a pinned, detached worktree of `accordionRepo` at `sha`
 * under `<runsDir>/_accordion/<sha12>`. Concurrency-safe: two parallel runs
 * resolving the same ref won't clobber each other (a lockfile serializes the
 * add; a loser waits and re-validates).
 *
 * Reuse rule: if the dir exists AND `git -C <path> rev-parse HEAD` == sha, reuse
 * it. If it exists but is broken/mismatched, remove (worktree remove --force +
 * prune) and recreate.
 *
 * @param {object} args
 * @param {string} args.accordionRepo  the source checkout (its origin knows the ref)
 * @param {string} args.sha            full 40-char SHA to pin
 * @param {string} args.runsDir        run output root (absolute)
 * @param {(m:string)=>void} [args.log]
 * @returns {Promise<string>} the worktree path (the effective accordion repo)
 */
export async function ensureWorktree({ accordionRepo, sha, runsDir, log = () => {} }) {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`ensureWorktree: sha must be a full 40-char SHA (got "${sha}")`);
  const wt = worktreePath(runsDir, sha);
  const anchorDir = path.join(runsDir, "_accordion");
  fs.mkdirSync(anchorDir, { recursive: true });

  // Fast path: already present, matching, AND fully provisioned. Checked before
  // taking the lock so the common (steady-state) reuse case is lock-free.
  //
  // Deliberately NOT just worktreeMatches: a worktree can match the pinned sha
  // while never having finished provisioning (a prior run's conductor-deps
  // install failed or was interrupted — provisionWorktree now only writes
  // .bellows-provisioned on SUCCESS, see below). Before this check existed,
  // once worktreeMatches was true nothing ever called provisionWorktree again,
  // so a single failed install would wedge every later run pinning this sha
  // against missing node_modules until someone manually deleted the worktree
  // (bellows #39 follow-up). Falling through to the locked path lets such a
  // worktree get a real retry instead.
  if (worktreeMatches(wt, sha) && isFullyProvisioned(wt)) return wt;

  // Serialize creation (and re-provisioning attempts) across concurrent runs
  // with a lockfile (atomic O_EXCL).
  const lockPath = wt + ".lock";
  const release = await acquireLock(lockPath, log);
  try {
    if (!worktreeMatches(wt, sha)) {
      // The dir exists but is broken/mismatched (or a stale worktree registration
      // lingers). Tear it down before recreating.
      if (fs.existsSync(wt)) {
        log(`[accordionRef] worktree ${wt} exists but does not match ${shortSha(sha)} — recreating`);
        removeWorktree(accordionRepo, wt, log);
      }
      // Prune any stale registration pointing at this path (e.g. the dir was
      // deleted out from under git) so `worktree add` doesn't refuse.
      gitTry(accordionRepo, ["worktree", "prune"]);

      const add = gitTry(accordionRepo, ["worktree", "add", "--detach", wt, sha]);
      if (!add.ok && !worktreeMatches(wt, sha)) {
        // Not a race (worktreeMatches would be true if a concurrent run just
        // finished creating it while we were adding) — a genuine failure.
        throw new Error(`accordionRef: git worktree add --detach ${wt} ${shortSha(sha)} failed: ${add.err}`);
      }
      if (add.ok) {
        log(`[accordionRef] created worktree ${wt} @ ${shortSha(sha)}`);
        if (!worktreeMatches(wt, sha)) {
          throw new Error(`accordionRef: worktree ${wt} did not check out ${shortSha(sha)} after add`);
        }
      }
    }
    // Reached whenever the worktree is present & matching under the lock —
    // whether it already matched (steady-state reuse, possibly retrying a
    // previously-failed provision), was just created, or was created by a
    // racing run while we waited for the lock. provisionWorktree is itself
    // marker-gated and only marks success, so this is a cheap no-op once truly
    // provisioned and a real retry otherwise (bellows #39 follow-up).
    await provisionWorktree({ accordionRepo, worktree: wt, log });
    return wt;
  } finally {
    release();
  }
}

/**
 * Minimal provisioning a fresh worktree needs so the bellows host (vite-node)
 * can transform the accordion `app/src/lib/**` modules it imports, PLUS the npm
 * deps any out-of-process `conductors/ws/*` conductor needs (see
 * installConductorWsDeps below — those are NOT covered by the "no npm install
 * needed" reasoning in this file's header, which is scoped to the in-process
 * host path only).
 *
 * The ONLY missing artifact for the host path is `app/.svelte-kit/tsconfig.json`:
 * `app/tsconfig.json` does `extends: "./.svelte-kit/tsconfig.json"`, a file
 * svelte-kit generates during `npm install`/build. A fresh worktree has no
 * node_modules and no `.svelte-kit/`, so esbuild's transform fails to resolve that
 * `extends`. We do NOT run `npm install` for THAT (proven unnecessary: the host
 * imports only pure TS/rune modules whose `svelte` runtime comes from bellows'
 * node_modules and whose `$conductors` alias is provided by vite-node.config.ts —
 * see this file's header). Instead we satisfy the one missing file: copy the base
 * checkout's generated `.svelte-kit/tsconfig.json` (its compilerOptions are
 * ref-independent and its paths are relative, so they resolve inside any
 * same-layout worktree); if the base checkout never built one, write a minimal
 * stub. Marker `.bellows-provisioned` skips ALL of this (stub + conductor deps) on
 * reuse.
 *
 * @param {object} args
 * @param {string} args.accordionRepo
 * @param {string} args.worktree
 * @param {(m:string)=>void} [args.log]
 * @param {(worktree:string, log:(m:string)=>void)=>(boolean|void|Promise<boolean|void>)} [args.installDeps]
 *   test seam — replaces installConductorWsDeps. Returning (or resolving to)
 *   `false` means provisioning did NOT fully succeed; anything else
 *   (including a bare `vi.fn()` test double returning `undefined`) counts as
 *   success.
 * @returns {Promise<void>}
 */
export async function provisionWorktree({ accordionRepo, worktree, log = () => {}, installDeps = installConductorWsDeps }) {
  const marker = path.join(worktree, ".bellows-provisioned");
  if (fs.existsSync(marker)) return;
  const dstDir = path.join(worktree, "app", ".svelte-kit");
  const dst = path.join(dstDir, "tsconfig.json");
  // Only relevant when the worktree actually has an app/tsconfig.json that extends it.
  const appTsconfig = path.join(worktree, "app", "tsconfig.json");
  if (fs.existsSync(appTsconfig) && !fs.existsSync(dst)) {
    fs.mkdirSync(dstDir, { recursive: true });
    const baseGenerated = path.join(accordionRepo, "app", ".svelte-kit", "tsconfig.json");
    if (fs.existsSync(baseGenerated)) {
      fs.copyFileSync(baseGenerated, dst);
      log(`[accordionRef] provisioned ${dst} (copied from base checkout)`);
    } else {
      fs.writeFileSync(dst, MINIMAL_SVELTEKIT_TSCONFIG);
      log(`[accordionRef] provisioned ${dst} (minimal stub — base checkout had none)`);
    }
  }
  // The marker is written ONLY when installDeps signals success (anything but
  // an explicit `false`). Previously it was written unconditionally, so a
  // failed conductor-deps install still got remembered as "provisioned" —
  // combined with ensureWorktree's old lock-free fast path never re-checking
  // provisioning status at all, that meant a single failed install wedged
  // every later run against missing node_modules until someone manually
  // deleted the worktree (bellows #39 follow-up: "the install marker should
  // ideally only be written on success"). See ensureWorktree for the other
  // half of this fix — the marker alone isn't sufficient, since something also
  // has to call provisionWorktree again on reuse for a retry to ever happen.
  const installed = await installDeps(worktree, log);
  if (installed === false) {
    log(`[accordionRef] WARN: provisioning ${worktree} did not fully succeed — leaving .bellows-provisioned unwritten so a later run retries`);
    return;
  }
  try {
    fs.writeFileSync(marker, new Date().toISOString());
  } catch {
    /* best-effort marker */
  }
}

/** Bounded like selfUpdate.mjs's NPM_CI_TIMEOUT_MS — npm installs can be slow on a cold cache. */
export const NPM_INSTALL_TIMEOUT_MS = 5 * 60_000;

/**
 * How long a failed conductors/ws install is remembered so a later call skips
 * retrying it outright (bellows #39 follow-up, 2026-09-30 Fable re-review of
 * #44 — "add a failure memo with backoff per (SHA, workspace), so repeated
 * failures fail fast instead of hanging each run"). The memo lives INSIDE the
 * failed conductor's own dir (`<dir>/.bellows-install-failed.json`), which
 * already keys it by both the pinned SHA (the dir is under
 * `_accordion/<sha12>`) and the workspace (`conductors/ws/<name>`) without any
 * extra bookkeeping. Retries happen naturally: ensureWorktree's fast path
 * requires `.bellows-provisioned`, which provisionWorktree only writes on a
 * FULLY successful installDeps — so every claim against a still-broken SHA
 * re-enters this function, and the memo just makes each of those re-entries
 * cheap (skip re-spawning npm) until the backoff window elapses, instead of
 * re-running (and re-waiting out) a multi-minute install every time.
 */
export const PROVISION_FAILURE_BACKOFF_MS = 10 * 60_000;
const PROVISION_FAILURE_MEMO_NAME = ".bellows-install-failed.json";

/**
 * The cross-process worktree lock (acquireLock, below) must be willing to
 * wait at least as long as a legitimate install can take, plus margin
 * (bellows #39 follow-up, 2026-09-30 Fable re-review of #44 — "make the lock
 * timeout at least the install timeout"): the holder may legitimately be
 * mid-install for up to NPM_INSTALL_TIMEOUT_MS. A shorter lock timeout let a
 * SECOND process sharing runsDir throw "timed out ... waiting for lock" on
 * every run pinning this sha while the first was still installing — for a
 * dependency the second run might not even need. staleMs (used to steal a
 * lock believed abandoned by a crashed holder) needs the same margin, or a
 * legitimately still-installing holder's own lock could be stolen out from
 * under it right as its install finishes.
 */
export const LOCK_TIMEOUT_MS = NPM_INSTALL_TIMEOUT_MS + 30_000;
export const LOCK_STALE_MS = NPM_INSTALL_TIMEOUT_MS + 60_000;

/**
 * True iff `dir/node_modules` reflects a COMPLETE npm ci/install, not a
 * partial extract left by one that was killed or timed out mid-run (bellows
 * #39 follow-up, 2026-09-30 Fable re-review of #44 — "the node_modules
 * existence check must not treat a partial extract as done"). Both `npm ci`
 * and `npm install` write `node_modules/.package-lock.json` as one of the
 * LAST steps of a successful run, so its presence is a much stronger signal
 * than the bare directory existing (which a killed install can leave behind
 * half-populated, and which this function used to accept as "done").
 */
function hasCompletedInstall(dir) {
  return fs.existsSync(path.join(dir, "node_modules", ".package-lock.json"));
}

function failureMemoPath(dir) {
  return path.join(dir, PROVISION_FAILURE_MEMO_NAME);
}

/** The failure memo for `dir` if it's still within its backoff window, else null. */
function recentInstallFailure(dir) {
  let memo;
  try {
    memo = JSON.parse(fs.readFileSync(failureMemoPath(dir), "utf8"));
  } catch {
    return null; // no memo, or unreadable/corrupt — treat as no recent failure
  }
  if (!memo || typeof memo.at !== "string") return null;
  const ageMs = Date.now() - Date.parse(memo.at);
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs >= PROVISION_FAILURE_BACKOFF_MS) return null;
  return memo;
}

function recordInstallFailure(dir, message) {
  try {
    fs.writeFileSync(failureMemoPath(dir), JSON.stringify({ at: new Date().toISOString(), message: String(message).slice(0, 1000) }));
  } catch {
    /* best-effort — worst case the next call just retries instead of backing off */
  }
}

function clearInstallFailure(dir) {
  try {
    fs.rmSync(failureMemoPath(dir), { force: true });
  } catch {
    /* best-effort */
  }
}

/**
 * Async counterpart to spawnSafeSync's RETURN SHAPE ({status, stderr, error}),
 * built on the non-blocking spawnSafe (bellows #39 follow-up, 2026-09-30
 * Fable re-review of #44: "keep the install off the heartbeat's critical
 * path — use async spawn, or make sure the heartbeat keeps firing during the
 * install"). installConductorWsDeps used to call spawnSafeSync directly,
 * which runs child_process.spawnSync SYNCHRONOUSLY — it blocks Node's entire
 * single-threaded event loop for up to opts.timeout. This function runs deep
 * inside the worker's executeRun call chain (resolveEffectiveAccordionRepo ->
 * ensureWorktree -> provisionWorktree -> here — see run.mjs), which shares an
 * event loop with loop.mjs's 30s heartbeat setInterval (executeClaimedRun) —
 * so a hanging npm registry blocked the heartbeat too (JS has one thread; a
 * synchronous child_process call cannot yield to a timer), and the platform
 * reaped the run at its 180s no-heartbeat deadline and failed it, for every
 * arm in the run, not just conductors that needed a ws install. Using
 * spawnSafe (async) here lets the event loop — and the heartbeat — keep
 * running while npm does its I/O; opts.timeout is enforced by hand via
 * killTree instead of relying on spawn's own `timeout`/`killSignal` options
 * (2026-09-30 Fable re-review of #44, cheap note: spawn DOES have a built-in
 * timeout, unlike the earlier claim here — but it only signals the direct
 * child, not the whole process tree a hung `npm` can leave behind, which is
 * exactly what killTree is for), mirroring src/worker/selfUpdate.mjs's
 * defaultRunNpmCi.
 * @param {string} cmd
 * @param {string[]} args
 * @param {import("node:child_process").SpawnOptions & {timeout?: number}} opts
 * @param {typeof spawnSafe} [spawnFn]  test seam: substitute a fake async/sync spawn
 * @returns {Promise<{status: number|null, stderr: string, error: Error|null}>}
 */
function spawnAwaited(cmd, args, opts, spawnFn = spawnSafe) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(cmd, args, opts);
    } catch (error) {
      resolve({ status: null, stderr: "", error });
      return;
    }
    let stderr = "";
    let settled = false;
    const timeoutMs = opts && opts.timeout;
    const timer =
      typeof timeoutMs === "number" && timeoutMs > 0
        ? setTimeout(() => {
            if (settled) return;
            settled = true;
            killTree(child);
            resolve({ status: null, stderr, error: new Error(`timed out after ${timeoutMs}ms — killed the child`) });
          }, timeoutMs)
        : null;
    // Left ref'd (not unref'd): the child's own handle already keeps the
    // event loop alive for as long as this promise is pending (spawnSafe
    // never detaches/unrefs it). That's a real, different situation from
    // sleep() below, where nothing else is alive during the wait — unref'ing
    // THAT timer let Node exit silently mid-lock-wait (2026-09-30 Fable
    // re-review of #44, blocking bug).
    child.stderr?.on("data", (d) => (stderr += d));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ status: null, stderr, error });
    });
    // "close" (not "exit"): "exit" fires as soon as the process terminates,
    // which can be BEFORE its stdio streams finish draining — a stderr
    // chunk still in flight at that instant would resolve with a truncated
    // `stderr`. "close" fires only after stdio is fully flushed, so the
    // error text callers classify on (e.g. selfUpdate's "npm ci failed")
    // is never cut off (2026-09-30 Fable re-review of #44, cheap note).
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ status: code, stderr, error: null });
    });
  });
}

/**
 * Install npm dependencies for every out-of-process conductor under
 * `<worktree>/conductors/ws/*` that has a `package.json` but no completed
 * install yet (hasCompletedInstall IS the idempotency guard — re-provisioning
 * a worktree whose deps are already installed is a fast no-op;
 * provisionWorktree's own `.bellows-provisioned` marker additionally skips
 * calling this at all on reuse).
 *
 * Runs `npm ci --no-audit --no-fund` when a `package-lock.json` is present
 * (reproducible, matches CI); falls back to `npm install --no-audit --no-fund`
 * otherwise (e.g. a conductor with dependencies but no committed lockfile).
 * A conductor dir with a `package.json` but no `dependencies` and no lockfile
 * (e.g. thermocline) still gets a harmless `npm install` — cheap and correct.
 *
 * Best-effort: this runs inside ensureWorktree's cross-process lock (called
 * from provisionWorktree, itself only reached under that lock — see
 * ensureWorktree), so concurrent runs pinning the same sha never race each
 * other's installs. A failure here is logged as a WARN and does NOT throw —
 * the conductor's own attach-time error ("Tree-sitter dependencies required
 * for code skeletonization are not installed...") remains the loud signal for
 * an operator; this function only tries to avoid ever producing it. It DOES
 * report success/failure via its return value (see below) so provisionWorktree
 * can decide whether to mark the worktree provisioned. A failure is also
 * memoed (see recordInstallFailure) so a later call within
 * PROVISION_FAILURE_BACKOFF_MS skips re-attempting that dir instead of
 * re-running (and re-waiting out) the whole install again.
 *
 * `--ignore-scripts` (bellows #39 follow-up): verified empirically against the
 * current conductor workspaces rather than assumed — triptych's full resolved
 * dependency tree (itself + web-tree-sitter + tree-sitter-wasms, 3 packages
 * total per its package-lock.json) has zero preinstall/install/postinstall/
 * prepare/prepublish scripts anywhere in it, and thermocline has no
 * dependencies at all. So skipping lifecycle scripts here is safe today and
 * closes off arbitrary code execution during an unattended provisioning step.
 * If a future conductor dependency legitimately needs an install script, this
 * needs revisiting (e.g. scoped per-conductor), not silently dropped again.
 *
 * @param {string} worktree
 * @param {(m:string)=>void} [log]
 * @param {(cmd:string, args:string[], opts:object)=>(object|Promise<object>)} [spawnFn]
 *   test seam: substitute a fake spawn. May return a SpawnSyncReturns-shaped
 *   object directly (as before) or a Promise of one — both are awaited the
 *   same way, so every pre-existing synchronous test fake keeps working
 *   unchanged.
 * @returns {Promise<boolean>} true if every conductor that needed installing
 *   succeeded (including the trivial "nothing to install" cases and a dir
 *   skipped because a completed install already exists); false if at least
 *   one install failed or was skipped due to a recent-failure backoff.
 */
export async function installConductorWsDeps(worktree, log = () => {}, spawnFn = spawnAwaited) {
  const wsDir = path.join(worktree, "conductors", "ws");
  let entries;
  try {
    entries = fs.readdirSync(wsDir, { withFileTypes: true });
  } catch {
    return true; // no conductors/ws dir in this checkout (older ref, or none) — nothing to do
  }
  let ok = true;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(wsDir, entry.name);
    if (!fs.existsSync(path.join(dir, "package.json"))) continue;
    if (hasCompletedInstall(dir)) continue; // already installed

    const recentFailure = recentInstallFailure(dir);
    if (recentFailure) {
      const remainingS = Math.max(0, Math.round((PROVISION_FAILURE_BACKOFF_MS - (Date.now() - Date.parse(recentFailure.at))) / 1000));
      log(
        `[accordionRef] WARN: skipping npm install in conductors/ws/${entry.name} — failed recently (${recentFailure.message}); retrying in ~${remainingS}s`,
      );
      ok = false;
      continue;
    }

    const hasLockfile = fs.existsSync(path.join(dir, "package-lock.json"));
    const args = hasLockfile ? ["ci", "--no-audit", "--no-fund", "--ignore-scripts"] : ["install", "--no-audit", "--no-fund", "--ignore-scripts"];
    let result;
    try {
      result = await spawnFn("npm", args, {
        cwd: dir,
        timeout: NPM_INSTALL_TIMEOUT_MS,
        windowsHide: true,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      const message = e && e.message ? e.message : String(e);
      log(`[accordionRef] WARN: npm ${args[0]} failed in conductors/ws/${entry.name}: ${message}`);
      recordInstallFailure(dir, message);
      ok = false;
      continue;
    }
    if (result.error) {
      log(`[accordionRef] WARN: npm ${args[0]} failed in conductors/ws/${entry.name}: ${result.error.message}`);
      recordInstallFailure(dir, result.error.message);
      ok = false;
      continue;
    }
    if (result.status !== 0) {
      const stderrLines = String(result.stderr || "")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      const reason = stderrLines.length ? stderrLines[stderrLines.length - 1] : `exited ${result.status}`;
      log(`[accordionRef] WARN: npm ${args[0]} failed in conductors/ws/${entry.name} (exit ${result.status}): ${reason}`);
      recordInstallFailure(dir, reason);
      ok = false;
      continue;
    }
    clearInstallFailure(dir);
    log(`[accordionRef] installed deps in conductors/ws/${entry.name}`);
  }
  return ok;
}

/**
 * Minimal `app/.svelte-kit/tsconfig.json` fallback: just enough compilerOptions for
 * esbuild's transform of the accordion app modules the host imports. Path aliases
 * ($conductors) are resolved by vite-node.config.ts, NOT tsconfig, so they are
 * intentionally omitted here — this only unblocks the `extends` resolution.
 */
const MINIMAL_SVELTEKIT_TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      moduleResolution: "bundler",
      module: "esnext",
      target: "esnext",
      lib: ["esnext", "DOM", "DOM.Iterable"],
      verbatimModuleSyntax: true,
      isolatedModules: true,
      noEmit: true,
      types: ["node"],
    },
  },
  null,
  2,
);

/** True iff `wt` is a git worktree whose HEAD is exactly `sha`. */
function worktreeMatches(wt, sha) {
  if (!fs.existsSync(wt)) return false;
  const r = gitTry(wt, ["rev-parse", "HEAD"]);
  return r.ok && r.out === sha;
}

/** True iff `wt` was already successfully provisioned (see provisionWorktree). */
function isFullyProvisioned(wt) {
  return fs.existsSync(path.join(wt, ".bellows-provisioned"));
}

/** Remove a worktree (force), tolerating an already-broken registration. */
function removeWorktree(accordionRepo, wt, log) {
  const rm = gitTry(accordionRepo, ["worktree", "remove", "--force", wt]);
  if (!rm.ok) {
    // remove can fail if the registration is already gone; fall back to a manual
    // rmdir + prune so recreation isn't blocked.
    log(`[accordionRef] worktree remove --force ${wt} failed (${rm.err}) — rmdir + prune`);
    try {
      fs.rmSync(wt, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    gitTry(accordionRepo, ["worktree", "prune"]);
  }
}

/**
 * Acquire an exclusive lockfile, waiting for a concurrent holder to release.
 * Returns a release() function. Steals a stale lock (older than staleMs) so a
 * crashed run can't wedge every future run.
 *
 * timeoutMs/staleMs default to LOCK_TIMEOUT_MS/LOCK_STALE_MS (both bounded
 * below by NPM_INSTALL_TIMEOUT_MS plus margin — see their definitions above
 * installConductorWsDeps) rather than fixed literals, so this lock's patience
 * can never fall behind however long a legitimate install is allowed to take.
 *
 * The wait itself is non-blocking (bellows #39 follow-up, 2026-09-30 Fable
 * re-review of #44's "cross-process variant": a second bellows process
 * sharing runsDir can wait here while the first is mid-install, and that wait
 * runs on the SAME event loop as loop.mjs's heartbeat — a synchronous
 * Atomics.wait busy-sleep would starve it exactly like the blocking npm spawn
 * this follow-up also fixes). ensureWorktree (the only caller in production)
 * is async, so this can just await a real timer between polls instead.
 *
 * Exported (test seam only — not part of the module's real call graph outside
 * this file) so a genuine cross-process test can exercise this exact wait
 * loop in an isolated `node` child process with nothing else keeping its
 * event loop alive, the precise condition under which the sleep() unref bug
 * below let Node exit silently instead of waiting (see accordionRef.test.mjs).
 */
export async function acquireLock(lockPath, log, { timeoutMs = LOCK_TIMEOUT_MS, pollMs = 100, staleMs = LOCK_STALE_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, "wx"); // O_CREAT|O_EXCL — atomic
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          fs.rmSync(lockPath, { force: true });
        } catch {
          /* ignore */
        }
      };
    } catch (e) {
      if (e && e.code !== "EEXIST") throw e;
      // Held by someone else. Steal if stale, else wait.
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > staleMs) {
          log(`[accordionRef] stealing stale lock ${lockPath}`);
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        // Lock vanished between EEXIST and stat — retry immediately.
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`accordionRef: timed out after ${timeoutMs}ms waiting for lock ${lockPath}`);
      }
      await sleep(pollMs);
    }
  }
}

/**
 * Non-blocking sleep (setTimeout-based — see acquireLock for why this must
 * not busy-block the event loop). Deliberately NOT unref'd (2026-09-30
 * Fable re-review of #44, blocking bug): while acquireLock is waiting on a
 * lock another process holds, nothing else is necessarily ref'd yet —
 * nothing has been spawned, and the worker's heartbeat/telemetry/batcher
 * intervals and undici's idle sockets are themselves all unref'd — so an
 * unref'd wait timer here left NOTHING keeping the event loop alive. Node
 * drained the loop and exited 0 silently mid-wait, the worker never called
 * complete(), and the platform reaped the run ~180s later. This sleep is
 * exactly the thing meant to hold the process open while genuinely still
 * waiting for the lock, so it must stay ref'd.
 */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Resolve a trial's `accordionRef` (if any) to the EFFECTIVE accordion repo path.
 * Absent ref => returns { repo: accordionRepo, ref: null, sha: null } (today's
 * behavior). Set => fetch + resolve + ensure the pinned worktree, and log one
 * clear line (resolved SHA + worktree path).
 *
 * @param {object} args
 * @param {string} args.accordionRepo  config.accordionRepo (source checkout)
 * @param {string|undefined} args.accordionRef  the trial's optional ref
 * @param {string} args.runsDir        absolute runs root (worktrees live under it)
 * @param {(m:string)=>void} [args.log]
 * @returns {Promise<{repo:string, ref:string|null, sha:string|null}>}
 */
export async function resolveEffectiveAccordionRepo({ accordionRepo, accordionRef, runsDir, log = () => {} }) {
  if (accordionRef === undefined || accordionRef === null || accordionRef === "") {
    return { repo: accordionRepo, ref: null, sha: null };
  }
  validateAccordionRef(accordionRef);
  const sha = resolveRefToSha(accordionRepo, accordionRef, log);
  const repo = await ensureWorktree({ accordionRepo, sha, runsDir, log });
  log(`[accordionRef] ref "${accordionRef}" -> ${sha} -> worktree ${repo}`);
  return { repo, ref: accordionRef, sha };
}
