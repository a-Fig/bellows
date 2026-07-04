/**
 * `pullBeforeClaim` support: `git pull --ff-only` the accordionRepo, throttled
 * to at most once per minute, plus stamping the repo's HEAD sha regardless of
 * whether a pull ran (accordion_sha is always recorded — see run-start event
 * and record.json).
 */
import { execFileSync } from "node:child_process";

const PULL_THROTTLE_MS = 60_000;
let lastPullAt = 0;

/**
 * @param {object} args
 * @param {string} args.accordionRepo
 * @param {(m:string)=>void} [args.log]
 * @param {boolean} [args.force]  bypass the once/min throttle (tests)
 * @returns {boolean} true if the pull ran AND actually moved HEAD (the caller
 *   should invalidate anything cached off the old checkout — see
 *   conductorAdvertise.mjs's clearConductorCache, m9 adversarial review). false
 *   when throttled, a no-op ("Already up to date"), or the pull failed.
 */
export function maybePullAccordion({ accordionRepo, log = () => {}, force = false }) {
  const now = Date.now();
  if (!force && now - lastPullAt < PULL_THROTTLE_MS) return false;
  lastPullAt = now;
  const before = accordionSha(accordionRepo);
  try {
    const out = execFileSync("git", ["-C", accordionRepo, "pull", "--ff-only"], {
      encoding: "utf8",
      timeout: 60_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    log(`[worker] git pull --ff-only (${accordionRepo}): ${out.trim().split(/\r?\n/)[0] || "ok"}`);
  } catch (e) {
    log(`[worker] WARN: git pull --ff-only failed for ${accordionRepo}: ${e.message.split(/\r?\n/)[0]} — continuing with the current tree`);
    return false;
  }
  const after = accordionSha(accordionRepo);
  return after !== before && !after.startsWith("unknown(") && !before.startsWith("unknown(");
}

/** git HEAD of the accordion checkout. Best-effort; "unknown" on failure. */
export function accordionSha(accordionRepo) {
  try {
    const out = execFileSync("git", ["-C", accordionRepo, "rev-parse", "HEAD"], {
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim();
  } catch (e) {
    return `unknown(${e.code || e.message || "err"})`;
  }
}

/** Reset the throttle. Test-only. */
export function _resetPullThrottle() {
  lastPullAt = 0;
}
