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
 * run. (External-conductor `.mjs` files that import `ws` are NOT part of this and
 * would need their own deps — out of scope; ref benching targets in-process
 * conductors + the extension.)
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

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
 * @returns {string} the worktree path (the effective accordion repo)
 */
export function ensureWorktree({ accordionRepo, sha, runsDir, log = () => {} }) {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`ensureWorktree: sha must be a full 40-char SHA (got "${sha}")`);
  const wt = worktreePath(runsDir, sha);
  const anchorDir = path.join(runsDir, "_accordion");
  fs.mkdirSync(anchorDir, { recursive: true });

  // Fast path: already present and matching. Check before taking the lock so the
  // common reuse case is lock-free.
  if (worktreeMatches(wt, sha)) return wt;

  // Serialize creation across concurrent runs with a lockfile (atomic O_EXCL).
  const lockPath = wt + ".lock";
  const release = acquireLock(lockPath, log);
  try {
    // Re-check under the lock — a concurrent run may have finished it while we waited.
    if (worktreeMatches(wt, sha)) return wt;

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
    if (!add.ok) {
      // A racing run may have created it between our check and our add (EEXIST-ish).
      if (worktreeMatches(wt, sha)) return wt;
      throw new Error(`accordionRef: git worktree add --detach ${wt} ${shortSha(sha)} failed: ${add.err}`);
    }
    log(`[accordionRef] created worktree ${wt} @ ${shortSha(sha)}`);
    if (!worktreeMatches(wt, sha)) {
      throw new Error(`accordionRef: worktree ${wt} did not check out ${shortSha(sha)} after add`);
    }
    provisionWorktree({ accordionRepo, worktree: wt, log });
    return wt;
  } finally {
    release();
  }
}

/**
 * Minimal provisioning a fresh worktree needs so the bellows host (vite-node)
 * can transform the accordion `app/src/lib/**` modules it imports.
 *
 * The ONLY missing artifact is `app/.svelte-kit/tsconfig.json`: `app/tsconfig.json`
 * does `extends: "./.svelte-kit/tsconfig.json"`, a file svelte-kit generates during
 * `npm install`/build. A fresh worktree has no node_modules and no `.svelte-kit/`,
 * so esbuild's transform fails to resolve that `extends`. We do NOT run `npm install`
 * (proven unnecessary: the host imports only pure TS/rune modules whose `svelte`
 * runtime comes from bellows' node_modules and whose `$conductors` alias is provided
 * by vite-node.config.ts — see this file's header). Instead we satisfy the one
 * missing file: copy the base checkout's generated `.svelte-kit/tsconfig.json` (its
 * compilerOptions are ref-independent and its paths are relative, so they resolve
 * inside any same-layout worktree); if the base checkout never built one, write a
 * minimal stub. Marker `.bellows-provisioned` skips this on reuse.
 */
export function provisionWorktree({ accordionRepo, worktree, log = () => {} }) {
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
  try {
    fs.writeFileSync(marker, new Date().toISOString());
  } catch {
    /* best-effort marker */
  }
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
 * Returns a release() function. Steals a stale lock (older than STALE_MS) so a
 * crashed run can't wedge every future run.
 */
function acquireLock(lockPath, log, { timeoutMs = 120_000, pollMs = 100, staleMs = 300_000 } = {}) {
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
      // Busy-wait via a short synchronous sleep (this whole module is sync so the
      // caller — a per-run setup step — can stay synchronous).
      sleepSync(pollMs);
    }
  }
}

/** Synchronous sleep (Atomics.wait on a throwaway buffer). */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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
 * @returns {{repo:string, ref:string|null, sha:string|null}}
 */
export function resolveEffectiveAccordionRepo({ accordionRepo, accordionRef, runsDir, log = () => {} }) {
  if (accordionRef === undefined || accordionRef === null || accordionRef === "") {
    return { repo: accordionRepo, ref: null, sha: null };
  }
  validateAccordionRef(accordionRef);
  const sha = resolveRefToSha(accordionRepo, accordionRef, log);
  const repo = ensureWorktree({ accordionRepo, sha, runsDir, log });
  log(`[accordionRef] ref "${accordionRef}" -> ${sha} -> worktree ${repo}`);
  return { repo, ref: accordionRef, sha };
}
