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
import { spawnSafe } from "../runner/proc.mjs";

const BELLOWS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CACHE_TTL_MS = 60_000;

/** @type {Map<string, {at:number, conductors:string[]}>} */
const cache = new Map();

/**
 * @param {object} args
 * @param {string} args.accordionRepo
 * @param {(m:string)=>void} [args.log]
 * @param {boolean} [args.force]  bypass the cache
 * @returns {Promise<string[]>}  e.g. ["builtin","keel",...,"external:thermocline"]
 */
export async function advertisedConductors({ accordionRepo, log = () => {}, force = false }) {
  const now = Date.now();
  const hit = cache.get(accordionRepo);
  if (!force && hit && now - hit.at < CACHE_TTL_MS) return hit.conductors;

  let inProcess = [];
  try {
    inProcess = await enumerateInProcessConductors(log);
  } catch (e) {
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

/** Spawn the vite-node enumerate-conductors script and parse its stdout JSON array. */
function enumerateInProcessConductors(log) {
  return new Promise((resolve, reject) => {
    const args = [
      path.join(BELLOWS_ROOT, "node_modules", "vite-node", "vite-node.mjs"),
      "--config",
      "vite-node.config.ts",
      "src/host/enumerate-conductors.ts",
    ];
    const child = spawnSafe(process.execPath, args, {
      cwd: BELLOWS_ROOT,
      env: { ...process.env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => reject(e));
    child.on("exit", (code) => {
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
