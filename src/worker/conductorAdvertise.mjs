/**
 * Builds the `conductors` list a worker advertises on each claim poll:
 *   - every in-process conductor id from Accordion's IN_PROCESS_CONDUCTORS
 *     registry (via a tiny vite-node script — see src/host/enumerate-conductors.ts
 *     for why this can't just be a plain `import()`: the registry ultimately
 *     pulls in store.svelte.ts, which needs the Svelte rune compiler)
 *   - "external:<id>" for every <accordionRepo>/conductors/<id>/launch.json
 *
 * Cached for ~60s (per accordionRepo) so a 5s poll cadence doesn't re-spawn
 * vite-node (and re-walk the conductors dir) on every tick.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSafe, killTree } from "../runner/proc.mjs";

const BELLOWS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CACHE_TTL_MS = 60_000;
// M1 (adversarial review): the vite-node enumeration child previously had no
// timeout — a hung child (e.g. a broken accordionRepo checkout, or vite-node
// itself wedging on a cold module graph) blocked every future claim poll
// forever, since advertisedConductors() is awaited at the top of the loop.
// Mirrors gitPull.mjs's execFileSync `timeout` option, but since this spawns
// async (spawnSafe/child_process.spawn has no built-in timeout), we enforce
// it ourselves and killTree() the child (and any grandchildren vite-node
// spawned) on expiry.
const ENUMERATE_TIMEOUT_MS = 60_000;

/** Test seam: override the enumeration timeout so tests don't wait 60s for a hang. */
export const _timing = { enumerateTimeoutMs: ENUMERATE_TIMEOUT_MS };
export function _resetTiming() {
  _timing.enumerateTimeoutMs = ENUMERATE_TIMEOUT_MS;
}

/** @type {Map<string, {at:number, conductors:string[]}>} */
const cache = new Map();

/**
 * @param {object} args
 * @param {string} args.accordionRepo
 * @param {(m:string)=>void} [args.log]
 * @param {boolean} [args.force]  bypass the cache
 * @param {(log:(m:string)=>void)=>Promise<string[]>} [args.enumerateFn]  test seam:
 *   substitute enumerateInProcessConductors (e.g. to simulate an enumeration
 *   failure/timeout without a real vite-node/Accordion checkout)
 * @returns {Promise<string[]>}  e.g. ["builtin","keel",...,"external:thermocline"]
 */
export async function advertisedConductors({ accordionRepo, log = () => {}, force = false, enumerateFn = enumerateInProcessConductors }) {
  const now = Date.now();
  const hit = cache.get(accordionRepo);
  if (!force && hit && now - hit.at < CACHE_TTL_MS) return hit.conductors;

  let inProcess = [];
  try {
    inProcess = await enumerateFn(log);
  } catch (e) {
    // M1 (adversarial review): whether enumeration fails fast (a broken
    // checkout) or times out (a hung child, now bounded — see
    // enumerateInProcessConductors), the worker must keep advertising
    // something rather than blocking the claim loop or crashing it. The
    // server doesn't gate claims on the `conductors` list anyway (it's
    // informational routing), so advertising external-only here is safe.
    log(`[worker] WARN: could not enumerate in-process conductors: ${e.message}`);
  }
  const external = listExternalConductors(accordionRepo, log).map((id) => `external:${id}`);
  const conductors = [...inProcess, ...external];
  cache.set(accordionRepo, { at: now, conductors });
  return conductors;
}

/** Clear the cache (tests / after a `pullBeforeClaim` pull that may have added conductors). */
export function clearConductorCache() {
  cache.clear();
}

/**
 * Spawn the vite-node enumerate-conductors script and parse its stdout JSON array.
 * @param {(m:string)=>void} log
 * @param {number} [timeoutMs]  test seam (defaults to _timing.enumerateTimeoutMs)
 * @param {typeof spawnSafe} [spawnFn]  test seam: substitute a fake spawn (e.g. a script
 *   that hangs forever) without needing a real vite-node/Accordion checkout
 */
export function enumerateInProcessConductors(log, timeoutMs = _timing.enumerateTimeoutMs, spawnFn = spawnSafe) {
  return new Promise((resolve, reject) => {
    const args = [
      path.join(BELLOWS_ROOT, "node_modules", "vite-node", "vite-node.mjs"),
      "--config",
      "vite-node.config.ts",
      "src/host/enumerate-conductors.ts",
    ];
    const child = spawnFn(process.execPath, args, {
      cwd: BELLOWS_ROOT,
      env: { ...process.env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killTree(child);
      reject(new Error(`enumerate-conductors: timed out after ${timeoutMs}ms — killed the child`));
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
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
        reject(new Error(`enumerate-conductors exited ${code}: ${err.trim().slice(0, 300)}`));
        return;
      }
      try {
        const parsed = JSON.parse(out.trim());
        if (!Array.isArray(parsed)) throw new Error("stdout was not a JSON array");
        resolve(parsed);
      } catch (e) {
        reject(new Error(`enumerate-conductors: could not parse stdout: ${e.message}`));
      }
    });
  });
}

/** Scan <accordionRepo>/conductors/*\/launch.json for external conductor ids. */
export function listExternalConductors(accordionRepo, log = () => {}) {
  const dir = path.join(accordionRepo, "conductors");
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    log(`[worker] WARN: could not read conductors dir ${dir}: ${e.message}`);
    return [];
  }
  const ids = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const launchPath = path.join(dir, ent.name, "launch.json");
    if (fs.existsSync(launchPath)) ids.push(ent.name);
  }
  return ids.sort();
}
