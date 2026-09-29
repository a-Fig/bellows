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
 * explicitly passed through. Deliberately broad/heuristic and NAME-ONLY — it
 * never looks at a var's value, so it can neither confirm a match is a real
 * secret nor notice a secret embedded in a value whose name doesn't look like
 * one (an unscrubbed `*_URL` with a credential baked into it, for example).
 * False positives (an innocuous var that happens to contain "TOKEN") are the
 * safe failure mode; use piEnvPassthrough to un-scrub those.
 *
 * `(^|_)KEY(_|$)` catches bare `*_KEY` names that don't also contain "API"
 * (`OPENROUTER_KEY`, `DEEPSEEK_KEY`, `SSH_KEY`) without flagging "KEY" merely
 * appearing mid-word (`KEYBOARD_LAYOUT`). `DSN` and `COOKIE`/`SESSION` cover a
 * few more common secret shapes (a database/error-tracker connection string
 * frequently embeds a password; a cookie or session value can itself BE a
 * bearer credential) raised in the 2026-09-29 Fable review (bellows #37
 * follow-up). Deliberately NOT matching a bare `*_URL`: Fable's own suggested
 * pattern list omits it, and most `*_URL` vars in this codebase (platformBase,
 * webhook URLs, ...) are not secrets — that one stays a false-negative for the
 * config author to catch via piEnvPassthrough's inverse (adding the var to
 * SECRET_ENV_NAME_RE's callers' understanding of their own env, not this
 * heuristic) if their URL happens to embed a credential.
 */
export const SECRET_ENV_NAME_RE = /(API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_?KEY|AUTH|(^|_)KEY(_|$)|DSN|COOKIE|SESSION)/i;

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
