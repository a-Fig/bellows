/**
 * Secret-scrubbing for pi's spawn env (bench.config's `scrubPiEnv`).
 *
 * pi runs the benchmarked agent with the runner's full process env by default
 * (see buildPiEnv in run.mjs), which means the platform API key and any other
 * ambient secret on the runner's env is reachable from the agent's bash tool.
 * scrubPiEnv opts a config into stripping anything that LOOKS like a secret by
 * name, with an explicit passthrough list for setups that rely on env (e.g. a
 * provider key pi reads from env instead of auth.json).
 */

/**
 * Var names matching this (case-insensitive) are dropped by scrubEnv unless
 * explicitly passed through. Deliberately broad/heuristic — false positives
 * (an innocuous var that happens to contain "TOKEN") are the safe failure
 * mode; use piEnvPassthrough to un-scrub those.
 */
export const SECRET_ENV_NAME_RE = /(API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_?KEY|AUTH)/i;

/**
 * Drop every var from `env` whose NAME matches SECRET_ENV_NAME_RE, except
 * names listed in `passthrough`. Pure function; does not mutate `env`.
 * @param {NodeJS.ProcessEnv} env
 * @param {string[]} [passthrough]
 * @returns {{ env: NodeJS.ProcessEnv, scrubbed: string[] }} the filtered env
 *   (new object) and the sorted list of NAMES removed (never values — callers
 *   log this list, so it must never carry a secret's value).
 */
export function scrubEnv(env, passthrough = []) {
  const keep = new Set(passthrough);
  /** @type {NodeJS.ProcessEnv} */
  const out = {};
  const scrubbed = [];
  for (const [name, value] of Object.entries(env)) {
    if (SECRET_ENV_NAME_RE.test(name) && !keep.has(name)) {
      scrubbed.push(name);
      continue;
    }
    out[name] = value;
  }
  scrubbed.sort();
  return { env: out, scrubbed };
}
