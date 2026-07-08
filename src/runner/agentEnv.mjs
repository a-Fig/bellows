/**
 * Environment hardening for the spawned pi agent on bench workers (issue #16).
 *
 * macOS Homebrew-Python workers ship two provisioning defects that otherwise
 * turn onboarding into a capability test rather than a coding benchmark:
 *
 *   1. Python's SSL trust store is uninitialized ("Install Certificates.command
 *      not run") -> the agent's very first HTTPS call dies with
 *      CERTIFICATE_VERIFY_FAILED and every platform call is blocked until the
 *      agent independently discovers a workaround (one observed run "recovered"
 *      by disabling TLS verification entirely). certifi is already installed on
 *      the host, just not wired into Python's default context, so we point
 *      SSL_CERT_FILE / REQUESTS_CA_BUNDLE at its bundle.
 *
 *   2. The workers expose only `python3`, but the briefing AND the
 *      platform-served guides say `python` -> `python: command not found`. We
 *      drop a `python -> python3` shim on PATH so every `python …` the agent
 *      runs works, including the guides bellows doesn't control.
 *
 * Everything here is a no-op on a healthy env: SSL_CERT_FILE already set or
 * certifi missing -> no SSL vars; `python` already resolvable (e.g. Windows) or
 * `python3` absent -> no shim. So it's safe to apply unconditionally at spawn.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Ask the host's python3 where certifi's CA bundle lives. Returns the path, or
 * null if python3/certifi is unavailable (a healthy non-macOS worker, or a host
 * without certifi — both handled by callers as "leave SSL alone").
 */
function certifiWhere() {
  try {
    return execFileSync("python3", ["-c", "import certifi; print(certifi.where())"], {
      encoding: "utf8",
      timeout: 10_000,
    }).trim();
  } catch {
    return null;
  }
}

/**
 * SSL env additions that wire certifi into stdlib ssl/urllib + requests. Empty
 * when SSL is already configured (never override an operator's deliberate
 * setting), certifi can't be located, or the bundle path doesn't exist.
 * @param {object} [deps]
 * @param {NodeJS.ProcessEnv} [deps.env]     base env to read SSL_CERT_FILE from
 * @param {() => (string|null)} [deps.where]  certifi-path resolver (injectable)
 * @param {(p:string)=>boolean} [deps.existsSync]
 * @returns {{SSL_CERT_FILE?:string, REQUESTS_CA_BUNDLE?:string}}
 */
export function resolveSslCertEnv({ env = process.env, where = certifiWhere, existsSync = fs.existsSync } = {}) {
  if (env.SSL_CERT_FILE) return {};
  const cafile = where();
  if (!cafile || !existsSync(cafile)) return {};
  return { SSL_CERT_FILE: cafile, REQUESTS_CA_BUNDLE: cafile };
}

/** First executable named `cmd` on env.PATH, or null. No subprocess. */
function resolveOnPath(cmd, env) {
  const dirs = (env.PATH || "").split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, cmd);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* not here / not executable */
    }
  }
  return null;
}

/** Write an executable `python` shim into binDir that exec's `python3`. */
function writePythonShim(binDir) {
  fs.mkdirSync(binDir, { recursive: true });
  const shim = path.join(binDir, "python");
  fs.writeFileSync(shim, '#!/bin/sh\nexec python3 "$@"\n');
  fs.chmodSync(shim, 0o755);
}

/**
 * Ensure a `python` command exists by shimming it to `python3`. Returns the
 * shim dir to prepend to PATH, or "" when no shim is needed. No-op on Windows
 * (ships `python`), when `python` already resolves, or when there's no `python3`
 * to shim to.
 * @param {object} args
 * @param {string} args.binDir              per-run dir to hold the shim
 * @param {NodeJS.ProcessEnv} [args.env]
 * @param {NodeJS.Platform} [args.platform]
 * @param {(cmd:string, env:NodeJS.ProcessEnv)=>(string|null)} [args.resolve]
 * @param {(binDir:string)=>void} [args.writeShim]
 * @returns {string}
 */
export function ensurePythonShim({
  binDir,
  env = process.env,
  platform = process.platform,
  resolve = resolveOnPath,
  writeShim = writePythonShim,
} = {}) {
  if (platform === "win32") return "";        // Windows already ships `python`
  if (resolve("python", env)) return "";       // shim unnecessary
  if (!resolve("python3", env)) return "";     // nothing to shim to
  writeShim(binDir);
  return binDir;
}

/**
 * Compute the env additions for the spawned pi agent: certifi SSL vars + a
 * `python`->`python3` PATH shim, each applied only when the host needs it.
 * Callers merge the result over the base spawn env.
 * @param {object} args
 * @param {NodeJS.ProcessEnv} args.baseEnv   env the agent will otherwise inherit
 * @param {string} args.binDir               per-run dir to hold the python shim
 * @param {NodeJS.Platform} [args.platform]
 * @param {(m:string)=>void} [args.log]
 * @returns {Record<string,string>}          additions to spread over baseEnv
 */
export function agentSpawnEnv({ baseEnv, binDir, platform = process.platform, log = () => {} }) {
  /** @type {Record<string,string>} */
  const add = {};

  const ssl = resolveSslCertEnv({ env: baseEnv });
  if (ssl.SSL_CERT_FILE) {
    Object.assign(add, ssl);
    log(`[env] SSL_CERT_FILE -> ${ssl.SSL_CERT_FILE} (certifi; fixes CERTIFICATE_VERIFY_FAILED)`);
  }

  const shimDir = ensurePythonShim({ binDir, env: baseEnv, platform });
  if (shimDir) {
    add.PATH = shimDir + path.delimiter + (baseEnv.PATH || "");
    log(`[env] python->python3 shim on PATH (${shimDir})`);
  }

  return add;
}
