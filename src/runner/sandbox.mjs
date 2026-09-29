/**
 * Opt-in filesystem sandbox for the benchmarked agent (config/trial
 * `sandbox: "landlock"`).
 *
 * What is confined: the `pi --mode rpc` process and EVERYTHING it spawns — the
 * bash tool's shells, python, the Accordion extension (loaded in-process by
 * pi) and the WS conductor runners the extension spawns. pi is exec'd through
 * bin/landlock-exec.py, which applies a Landlock domain to itself and then
 * execs pi; Landlock domains are inherited across fork/exec and can never be
 * loosened, so no descendant can step outside the granted trees.
 *
 * What is NOT confined (deliberately): the runner itself, the headless host
 * (bellows-owned code that must write host.jsonl into the run dir and never
 * executes agent-controlled code) and legacy external conductors launched by
 * the runner from launch.json. None of them are reachable from the agent's
 * tool calls.
 *
 * Only filesystem access is restricted. Network (the agent must reach the
 * Agent Trials platform over HTTPS and its conductor over loopback) and
 * Landlock scopes are left alone by construction (see landlock-exec.py) —
 * Landlock cannot restrict the network at all, and bellows runs unprivileged
 * so it cannot set its own firewall rules either. `sandboxEgress: "blocked"`
 * does NOT close the network; it only VERIFIES (via the same canary, with
 * network probes added — see buildEgressProbes) that something else, e.g. a
 * host-level iptables egress allowlist (see TUTORIAL.md), already did. A
 * sandboxed agent still reached the public internet over plain HTTPS on
 * 2026-09-28 (fetched SlopCode's hidden tests + reference solutions from
 * GitHub) until that host-level allowlist was added — this canary exists so
 * that gap fails loudly instead of silently contaminating scores again.
 * `sandboxEgress` defaults to "blocked" whenever the sandbox is "landlock"
 * (see resolveSandboxEgress) — provision the host-level allowlist with
 * scripts/egress-allowlist.sh before running sandboxed trials for real.
 *
 * Nothing here ever runs the agent unsandboxed when the sandbox was asked for:
 * an unsupported platform/kernel, a policy path that doesn't exist, a wrapper
 * setup failure or a canary probe (filesystem OR egress) that escapes all
 * fail the run before pi is spawned.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveCommand } from "./proc.mjs";

// Bellows checkout root (two levels up from src/runner/). Computed here rather
// than imported from config.mjs, which imports this module (validation).
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const SANDBOX_MODES = new Set(["off", "landlock"]);
export const LANDLOCK_EXEC = path.join(REPO_ROOT, "bin", "landlock-exec.py");

/** Read+exec system trees (only the ones that exist are granted). */
export const SYSTEM_RX = ["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", "/opt"];
/** Read-only system trees. /proc: Landlock's ptrace rule still hides other
 *  domains' /proc/<pid>/{environ,cwd,root,fd,mem}; /sys: node reads cgroup
 *  limits from it. */
export const SYSTEM_RO = ["/etc", "/proc", "/sys"];
/** Device files granted read-write (nothing else under /dev). */
export const DEV_RW = ["/dev/null", "/dev/zero", "/dev/full", "/dev/random", "/dev/urandom", "/dev/tty"];
/** /etc entries that are commonly symlinks OUT of /etc (e.g. Ubuntu's
 *  /etc/resolv.conf -> /run/systemd/resolve/stub-resolv.conf). The directory
 *  holding each resolved target is granted read-only so DNS/TLS/time keep
 *  working (a directory rather than the file itself because resolvers replace
 *  the file by rename, and Landlock rules are bound to inodes). */
export const ETC_SYMLINK_TARGETS = ["/etc/resolv.conf", "/etc/hosts", "/etc/localtime", "/etc/ssl/certs/ca-certificates.crt"];

const EACCES = 13;
const EPERM = 1;

/**
 * Effective sandbox mode for a run. The bench config sets the default
 * (`sandbox`, "off" when absent); a trial may turn the sandbox ON
 * (`sandbox: "landlock"`) but can never turn off a sandbox the operator's
 * config enforces — the sandbox only ever adds restrictions. Throws on unknown
 * values (a platform-claimed spec never went through validateTrialSpec).
 * @param {{sandbox?: string}} config
 * @param {{sandbox?: string} | null | undefined} spec
 * @returns {"off"|"landlock"}
 */
export function resolveSandboxMode(config, spec) {
  const fromConfig = config?.sandbox ?? "off";
  const fromTrial = spec?.sandbox;
  if (!SANDBOX_MODES.has(fromConfig)) throw new Error(`sandbox: "${fromConfig}" in bench config is not one of off, landlock`);
  if (fromTrial !== undefined && !SANDBOX_MODES.has(fromTrial))
    throw new Error(`sandbox: "${fromTrial}" in trial spec is not one of off, landlock`);
  if (fromConfig === "landlock" && fromTrial === "off")
    throw new Error(
      'trial sets sandbox: "off" but bench.config.json enforces sandbox: "landlock" — a trial can only enable the sandbox, never disable it',
    );
  return fromConfig === "landlock" || fromTrial === "landlock" ? "landlock" : "off";
}

export const SANDBOX_EGRESS_VALUES = new Set(["unchecked", "blocked"]);

/**
 * Egress hosts the canary must confirm are UNREACHABLE when sandboxEgress is
 * "blocked" — the exact hosts a contaminated benchmark used on 2026-09-28 to
 * fetch SlopCode's public hidden tests and reference solutions
 * (github.com/gabeorlanski/scb-problems) instead of solving the problem.
 */
export const DEFAULT_EGRESS_BLOCKED_HOSTS = ["github.com:443", "raw.githubusercontent.com:443", "pypi.org:443"];

/**
 * Effective sandboxEgress for a run. Owner decision, 2026-09-28 ("dont let
 * them have internet"), after a Landlock-sandboxed agent still reached the
 * open internet: the DEFAULT depends on the effective sandbox mode
 * (resolveSandboxMode) rather than being a flat "unchecked" —
 *
 *   - mode "landlock" -> defaults to "blocked" when neither config nor trial
 *     says anything.
 *   - mode "off"       -> defaults to "unchecked" (there is no sandboxed
 *     canary process to run egress probes in — see the "blocked requires
 *     landlock" check below).
 *
 * Either side may still say "blocked" explicitly (still honored, still only
 * ever TIGHTENS — a trial can never loosen a config that enforces "blocked",
 * same as resolveSandboxMode), but an EXPLICIT "unchecked" is only valid when
 * the resolved mode is "off": once landlock is in effect, egress is always
 * checked and "unchecked" is not an available override. This keeps a stale
 * config-level `sandboxEgress: "unchecked"` (written back when the default
 * was flat) from silently defeating the check for a trial that turns
 * landlock on per-trial — it throws instead, same "fail loudly rather than
 * silently run more permissively than asked" posture as everything else in
 * this file. Throws on unknown values too (a platform-claimed spec never
 * went through validateTrialSpec).
 *
 * Also requires the filesystem sandbox itself to resolve to "landlock" when
 * the result is "blocked": egress probes run through the exact same
 * Landlock-wrapped canary process as the filesystem probes
 * (prepareLandlockRun), so there is nothing to run them in when the
 * filesystem sandbox is off — silently skipping the check there would defeat
 * the entire point of this verification. Never returns "unchecked" when
 * "blocked" was actually requested (or defaulted); it throws instead.
 * @param {{sandbox?: string, sandboxEgress?: string}} config
 * @param {{sandbox?: string, sandboxEgress?: string} | null | undefined} spec
 * @returns {"unchecked"|"blocked"}
 */
export function resolveSandboxEgress(config, spec) {
  const fromConfig = config?.sandboxEgress;
  const fromTrial = spec?.sandboxEgress;
  if (fromConfig !== undefined && !SANDBOX_EGRESS_VALUES.has(fromConfig))
    throw new Error(`sandboxEgress: "${fromConfig}" in bench config is not one of unchecked, blocked`);
  if (fromTrial !== undefined && !SANDBOX_EGRESS_VALUES.has(fromTrial))
    throw new Error(`sandboxEgress: "${fromTrial}" in trial spec is not one of unchecked, blocked`);
  if (fromConfig === "blocked" && fromTrial === "unchecked")
    throw new Error(
      'trial sets sandboxEgress: "unchecked" but bench.config.json enforces sandboxEgress: "blocked" — a trial can only tighten egress ' +
        "checking, never loosen it",
    );

  const mode = resolveSandboxMode(config, spec);
  const requested =
    fromConfig === "blocked" || fromTrial === "blocked" ? "blocked" : fromConfig === "unchecked" || fromTrial === "unchecked" ? "unchecked" : undefined;

  if (requested === "unchecked" && mode === "landlock")
    throw new Error(
      'sandboxEgress: "unchecked" is not allowed together with sandbox: "landlock" — once the filesystem sandbox is on, egress is ' +
        'checked by default ("blocked"); "unchecked" is only available when the effective sandbox is "off". Remove the explicit ' +
        'sandboxEgress: "unchecked" (the "blocked" default will apply) or set sandbox: "off" to run without egress checking.',
    );

  const egress = requested ?? (mode === "landlock" ? "blocked" : "unchecked");
  if (egress === "blocked" && mode !== "landlock")
    throw new Error(
      'sandboxEgress: "blocked" requires sandbox: "landlock" — egress probes run inside the same Landlock-wrapped canary process as the ' +
        "filesystem probes, so there is no sandboxed process to run them in when the filesystem sandbox is off.",
    );
  return egress;
}

const HOST_PORT_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?:[0-9]{1,5}$/;

/**
 * Normalize/validate the optional `sandboxEgressAllow` config section: a
 * string[] of "host:port" entries (e.g. the model API host) that the egress
 * canary must confirm ARE reachable when sandboxEgress is "blocked". Ignored
 * when sandboxEgress is "unchecked". Returns a list of error strings (empty =
 * valid).
 */
export function validateSandboxEgressAllow(raw) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || !raw.every((s) => typeof s === "string"))
    return ['sandboxEgressAllow: must be a string[] of "host:port" entries if present'];
  const errs = [];
  for (const s of raw) {
    if (!HOST_PORT_RE.test(s)) {
      errs.push(`sandboxEgressAllow: "${s}" must look like "host:port" (e.g. "api.deepseek.com:443")`);
      continue;
    }
    const port = Number(s.slice(s.lastIndexOf(":") + 1));
    if (!(port >= 1 && port <= 65535)) errs.push(`sandboxEgressAllow: "${s}" port must be 1-65535`);
  }
  return errs;
}

/** Absolute python3 used to launch the wrapper (it restricts itself, then execs). */
export function resolvePython3() {
  const p = resolveCommand("python3");
  if (!path.isAbsolute(p)) throw new Error('sandbox: "landlock" needs python3 on PATH to run bin/landlock-exec.py');
  return p;
}

/**
 * The kernel's Landlock ABI version via `landlock-exec.py --abi` (0 when
 * Landlock is unavailable or disabled).
 * @param {{python?: string, spawn?: typeof spawnSync}} [deps]
 * @returns {number}
 */
export function landlockAbi({ python, spawn = spawnSync } = {}) {
  const py = python || resolvePython3();
  const r = spawn(py, ["-I", "-S", LANDLOCK_EXEC, "--abi"], { encoding: "utf8", timeout: 15_000 });
  if (r.error) throw new Error(`sandbox: could not run ${LANDLOCK_EXEC} --abi: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`sandbox: ${LANDLOCK_EXEC} --abi exited ${r.status}: ${(r.stderr || "").trim()}`);
  const n = Number.parseInt(String(r.stdout).trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Fail fast unless Landlock can actually be enforced here. Never returns
 * "unsandboxed" — it throws with an actionable message instead.
 * @param {{platform?: string, abi?: () => number}} [deps]
 * @returns {number} the ABI version
 */
export function assertLandlockAvailable({ platform = process.platform, abi = () => landlockAbi() } = {}) {
  if (platform !== "linux")
    throw new Error(
      `sandbox: "landlock" requires Linux, but this runner is on ${platform}. Refusing to run the agent unsandboxed — ` +
        `set sandbox: "off" (bench.config.json / trial) to run without filesystem isolation.`,
    );
  const v = abi();
  if (!(v >= 1))
    throw new Error(
      'sandbox: "landlock" requested but this kernel has no usable Landlock (ABI 0: not built in, or not in the ' +
        "`lsm=` boot list). Refusing to run the agent unsandboxed.",
    );
  return v;
}

function isUnder(p, root) {
  const rel = path.relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Root of the npm package that owns `piPath` (the `pi` bin is a symlink into
 * <pkg>/dist/...; deps are nested under <pkg>/node_modules for a global
 * install). Falls back to <prefix> (dirname(dirname(bin))) when no named
 * package.json is found.
 */
export function resolvePiInstallRoot(piPath, { realpathSync = fs.realpathSync, readFileSync = fs.readFileSync } = {}) {
  let real;
  try {
    real = realpathSync(piPath);
  } catch {
    real = piPath;
  }
  let dir = path.dirname(real);
  while (true) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
      if (pkg && typeof pkg.name === "string" && pkg.name) return dir;
    } catch {
      /* no/invalid package.json here — keep walking */
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return path.dirname(path.dirname(piPath));
}

/**
 * Normalize/validate the optional `sandboxAllow` config section:
 * `{ ro?: string[], rx?: string[], rw?: string[] }` of absolute paths.
 * Returns a list of error strings (empty = valid).
 */
export function validateSandboxAllow(raw) {
  if (raw === undefined) return [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return ["sandboxAllow: must be an object {ro?, rx?, rw?} if present"];
  const errs = [];
  for (const k of Object.keys(raw)) {
    if (!["ro", "rx", "rw"].includes(k)) {
      errs.push(`sandboxAllow.${k}: unknown key (allowed: ro, rx, rw)`);
      continue;
    }
    const v = raw[k];
    if (!Array.isArray(v) || !v.every((p) => typeof p === "string" && p.trim())) {
      errs.push(`sandboxAllow.${k}: must be a string[] of paths`);
      continue;
    }
    for (const p of v) if (!path.posix.isAbsolute(p)) errs.push(`sandboxAllow.${k}: "${p}" must be an absolute path`);
  }
  return errs;
}

/**
 * Build the Landlock grant list for one run. Pure except for the injectable
 * fs probes. Everything not listed is denied (read, write, exec, list,
 * create, delete, rename, truncate, device ioctl): other runs, the trial dir,
 * the bellows checkout and its bench.config.json, the operator's home dir,
 * /tmp, and this run's own harness files (host.jsonl, pi-rpc.log,
 * record.json, host-stderr.log) that sit next to — not inside — the granted
 * subtrees of the run dir.
 *
 * @param {object} a
 * @param {string} a.workspaceDir     rw — the agent's cwd
 * @param {string} a.agentDir         rw — PI_CODING_AGENT_DIR (settings, auth, sessions)
 * @param {string} a.accordionHome    rw — ACCORDION_HOME (session descriptor, controller state)
 * @param {string} a.tmpDir           rw — exported as TMPDIR
 * @param {string} a.binDir           rx — the run's python shim dir
 * @param {string} a.completionLogFile  write-only (pre-created) — ACCORDION_COMPLETION_LOG
 * @param {string} a.accordionRepo    rx — effective (possibly pinned-worktree) checkout
 * @param {string} a.piPath           absolute pi executable
 * @param {string} [a.nodePath]       node executable (default process.execPath)
 * @param {string} [a.bellowsRoot]    bellows checkout (default REPO_ROOT)
 * @param {Record<string,string|undefined>} [a.env]  pi's env (SSL_CERT_FILE & co are honored)
 * @param {{ro?:string[], rx?:string[], rw?:string[]}} [a.extra]  config.sandboxAllow
 * @param {{existsSync?:Function, realpathSync?:Function, readFileSync?:Function}} [a.fsImpl]
 * @returns {{mode:"ro"|"rx"|"rw"|"wo", path:string, why:string}[]}
 */
export function buildLandlockPolicy(a) {
  const fsImpl = { existsSync: fs.existsSync, realpathSync: fs.realpathSync, readFileSync: fs.readFileSync, ...(a.fsImpl || {}) };
  const bellowsRoot = a.bellowsRoot || REPO_ROOT;
  const nodePath = a.nodePath || process.execPath;
  const env = a.env || {};
  /** @type {{mode:"ro"|"rx"|"rw"|"wo", path:string, why:string}[]} */
  const rules = [];
  const seen = new Set();
  const add = (mode, p, why, { optional = false } = {}) => {
    if (!p) return;
    if (!fsImpl.existsSync(p)) {
      if (optional) return;
      throw new Error(`sandbox policy: ${why} path does not exist: ${p}`);
    }
    const key = `${mode}\0${p}`;
    if (seen.has(key)) return;
    seen.add(key);
    rules.push({ mode, path: p, why });
  };
  const covered = (p) => rules.some((r) => r.mode !== "wo" && isUnder(p, r.path));

  for (const p of SYSTEM_RX) add("rx", p, "system", { optional: true });
  for (const p of SYSTEM_RO) add("ro", p, "system", { optional: true });
  for (const p of DEV_RW) add("rw", p, "device", { optional: true });

  // Symlinked /etc entries (resolv.conf -> /run/systemd/resolve/...).
  for (const link of ETC_SYMLINK_TARGETS) {
    let real;
    try {
      real = fsImpl.realpathSync(link);
    } catch {
      continue;
    }
    if (!covered(real)) add("ro", path.dirname(real), `target of ${link}`, { optional: true });
  }
  // TLS bundles pointed to by env (agentEnv.mjs may set these to certifi's).
  for (const k of ["SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"]) {
    const v = env[k];
    if (v && path.isAbsolute(v) && !covered(v)) add("ro", v, `$${k}`, { optional: true });
  }

  // Runtimes: node (whatever prefix it lives in) + the pi package.
  let nodeReal = nodePath;
  try {
    nodeReal = fsImpl.realpathSync(nodePath);
  } catch {
    /* keep as-is */
  }
  const nodePrefix = path.dirname(path.dirname(nodeReal));
  if (!covered(nodeReal)) add("rx", nodePrefix, "node install");
  add("rx", resolvePiInstallRoot(a.piPath, fsImpl), "pi install");

  // Code the agent's process tree must load/exec.
  add("rx", a.accordionRepo, "accordion checkout (extension + conductors/ws/* runners)");
  add("ro", path.join(bellowsRoot, "src", "runner", "extensions"), "bellows pi extensions (deepseekReplayCompat)");
  // The Accordion extension's bare imports (e.g. `ws`) resolve by walking up
  // from the checkout; a pinned worktree under runs/_accordion/ lands in
  // bellows' own node_modules.
  if (isUnder(a.accordionRepo, bellowsRoot)) add("ro", path.join(bellowsRoot, "node_modules"), "bellows node_modules (extension deps)", { optional: true });
  add("rx", a.binDir, "run bin/ (python shim)");

  // The run's writable state.
  add("rw", a.workspaceDir, "workspace");
  add("rw", a.agentDir, "pi agent dir");
  add("rw", a.accordionHome, "accordion home (host channel descriptors)");
  add("rw", a.tmpDir, "TMPDIR");
  add("wo", a.completionLogFile, "completion side log (append-only)");

  for (const mode of ["ro", "rx", "rw"]) for (const p of a.extra?.[mode] || []) add(mode, p, "config.sandboxAllow");
  return rules;
}

/** `--mode path` pairs for landlock-exec.py. */
export function rulesToArgs(rules) {
  return rules.flatMap((r) => [`--${r.mode}`, r.path]);
}

/**
 * The argv prefix that runs a command inside the sandbox:
 * `[python3, -I, -S, landlock-exec.py, --rx /usr, ..., --]` — append the
 * command. The SAME prefix is used for the canary and for pi.
 */
export function landlockArgvPrefix(rules, { python, execScript = LANDLOCK_EXEC } = {}) {
  return [python || resolvePython3(), "-I", "-S", execScript, ...rulesToArgs(rules), "--"];
}

// --- canary -------------------------------------------------------------------

/** Probe program run INSIDE the sandbox (python3 -I -S -c). Prints one JSON
 *  array of {name, ok, errno, detail}. */
export const CANARY_PY = String.raw`
import json, os, socket, subprocess, sys, tempfile
out = []
for p in json.loads(sys.argv[1]):
    op, target = p["op"], p.get("path")
    r = {"name": p["name"], "ok": False, "errno": None, "detail": ""}
    try:
        if op == "read":
            with open(target, "rb") as f:
                f.read(64)
        elif op == "list":
            r["detail"] = "%d entries" % len(os.listdir(target))
        elif op == "write":
            fn = os.path.join(target, ".sandbox-canary-%d" % os.getpid())
            with open(fn, "w") as f:
                f.write("canary")
            with open(fn) as f:
                if f.read() != "canary":
                    raise AssertionError("read-back mismatch")
            os.unlink(fn)
        elif op == "create":
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            os.close(fd)
            os.unlink(target)
        elif op == "open-wo":
            # Same flags as node's fs.appendFile ("a"): the file already exists,
            # so O_CREAT must not need MAKE_REG.
            fd = os.open(target, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
            os.close(fd)
        elif op == "tmpdir":
            if os.environ.get("TMPDIR") != target:
                raise AssertionError("TMPDIR=%r, expected %r" % (os.environ.get("TMPDIR"), target))
            fd, fn = tempfile.mkstemp(prefix="sandbox-canary-")
            os.write(fd, b"x")
            os.close(fd)
            os.unlink(fn)
            if not os.path.realpath(fn).startswith(os.path.realpath(target) + os.sep):
                raise AssertionError("mkstemp landed in %s" % fn)
            r["detail"] = fn
        elif op == "exec":
            cp = subprocess.run(p["argv"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=30)
            lines = cp.stdout.decode("utf-8", "replace").strip().splitlines()
            r["detail"] = (lines[0] if lines else "")[:80]
            if cp.returncode != 0:
                raise RuntimeError("exit %d: %s" % (cp.returncode, r["detail"]))
        elif op == "tcp":
            # Egress probe (sandboxEgress). Landlock never restricts the network
            # (see bin/landlock-exec.py) — this only tells the truth about whether
            # something ELSE (a host-level firewall) is blocking it. A "deny"-
            # expected probe passing (connection succeeds) means egress is open.
            host, _, port_s = target.rpartition(":")
            s = socket.create_connection((host, int(port_s)), timeout=5)
            s.close()
        else:
            raise ValueError("unknown op %r" % op)
        r["ok"] = True
    except OSError as e:
        r["errno"] = e.errno
        r["detail"] = e.strerror or str(e)
    except Exception as e:
        r["detail"] = "%s: %s" % (type(e).__name__, e)
    out.append(r)
sys.stdout.write(json.dumps(out) + "\n")
`;

/**
 * Create (once) a decoy "other run" under runsRoot so the cross-run probe
 * always has an existing target — a missing target would fail with ENOENT and
 * look like a pass.
 */
export function ensureCanaryDecoy(runsRoot) {
  const dir = path.join(runsRoot, "_sandbox_canary", "decoy-run", "workspace");
  const file = path.join(dir, "solution.py");
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, "# decoy: another run's solution. A sandboxed agent must not be able to read this.\n");
  return file;
}

/**
 * Canary probes for one run. `expect: "deny"` rows must fail with
 * EACCES/EPERM on a target that EXISTS (runner-verified); `expect: "allow"`
 * rows must succeed.
 * @returns {{name:string, op:string, path?:string, argv?:string[], expect:"allow"|"deny"}[]}
 */
export function buildCanaryProbes({
  runDir,
  workspaceDir,
  tmpDir,
  binDir,
  accordionRepo,
  completionLogFile,
  ownHarnessFiles = [],
  decoyFile,
  runsRoot,
  bellowsRoot = REPO_ROOT,
  homeDir = os.homedir(),
  runnerPid = process.pid,
  existsSync = fs.existsSync,
  readdirSync = fs.readdirSync,
}) {
  const probes = [];
  const allow = (name, op, extra) => probes.push({ name, op, expect: "allow", ...extra });
  const deny = (name, op, p) => {
    if (p && existsSync(p)) probes.push({ name, op, path: p, expect: "deny" });
  };
  // A "create" target must NOT exist yet; gate on its parent instead.
  const denyCreate = (name, p) => {
    if (existsSync(path.dirname(p)) && !existsSync(p)) probes.push({ name, op: "create", path: p, expect: "deny" });
  };

  allow("write+read workspace", "write", { path: workspaceDir });
  allow("TMPDIR is the run tmp + writable", "tmpdir", { path: tmpDir });
  allow("exec node -v", "exec", { argv: ["node", "-v"] });
  allow("exec python3 -V", "exec", { argv: ["python3", "-V"] });
  if (binDir && existsSync(path.join(binDir, "python"))) allow("exec python -V (shim)", "exec", { argv: ["python", "-V"] });
  const ext = path.join(accordionRepo, "extension", "accordion.ts");
  if (existsSync(ext)) allow("read accordion extension", "read", { path: ext });
  allow("append-open completion log", "open-wo", { path: completionLogFile });

  deny("read another run's workspace (decoy)", "read", decoyFile);
  // Real sibling runs of this trial, if any exist yet.
  const trialDir = path.dirname(runDir);
  let siblings = [];
  try {
    siblings = readdirSync(trialDir)
      .map((n) => path.join(trialDir, n, "workspace"))
      .filter((w) => path.resolve(w) !== path.resolve(workspaceDir) && existsSync(w))
      .slice(0, 2);
  } catch {
    /* no trial dir listing — the decoy still covers the cross-run case */
  }
  for (const w of siblings) deny(`list sibling run ${path.basename(path.dirname(w))}/workspace`, "list", w);
  deny("list trial dir (sibling runs)", "list", trialDir);
  deny("list runs root", "list", runsRoot);
  deny("list bellows checkout's parent dir", "list", path.dirname(bellowsRoot));
  deny("read env.sh next to the checkout", "read", path.join(path.dirname(bellowsRoot), "env.sh"));
  deny("list home dir", "list", homeDir);
  deny("read bench.config.json", "read", path.join(bellowsRoot, "bench.config.json"));
  deny("read bellows source", "read", path.join(bellowsRoot, "package.json"));
  for (const f of ownHarnessFiles) deny(`read own ${path.basename(f)}`, "read", f);
  deny("read back completion log (write-only)", "read", completionLogFile);
  denyCreate("create file in run dir", path.join(runDir, `.sandbox-escape-${runnerPid}`));
  deny("list /tmp", "list", "/tmp");
  denyCreate("create file in /tmp", `/tmp/bellows-sandbox-escape-${runnerPid}`);
  deny("read runner's /proc/<pid>/environ", "read", `/proc/${runnerPid}/environ`);
  deny("list runner's /proc/<pid>/cwd", "list", `/proc/${runnerPid}/cwd`);
  return probes;
}

/**
 * True iff `ip` is loopback (127.0.0.0/8, ::1), unspecified (0.0.0.0, ::), or
 * link-local (169.254.0.0/16, fe80::/10) — addresses a canary probe must
 * never be built against (2026-09-29 Fable re-review of #43, non-blocking
 * note): a poisoned/blocked resolver, a hosts-file entry, or a sinkhole can
 * make a "must be blocked" host (github.com etc.) resolve to one of these
 * instead of erroring out. buildEgressProbes' toIpProbe would then happily
 * connect to (say) 127.0.0.1 — almost certainly refused, since nothing here
 * listens there — and record that as "github.com is blocked", when in fact
 * DNS/hosts resolution for that hostname was silently hijacked and nothing
 * about the REAL github.com was ever tested. Rejecting these outright forces
 * resolveEgressHost to report "could not resolve", which buildEgressProbes
 * already treats as inconclusive-and-fail (see its caller) rather than a
 * false PASS.
 * @param {string} ip
 * @returns {boolean}
 */
export function isUnsafeEgressProbeTarget(ip) {
  if (typeof ip !== "string" || !ip) return true;
  if (ip === "0.0.0.0" || ip === "::" || ip === "::1") return true;
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [, a, b] = v4.map(Number);
    if (a === 127) return true; // 127.0.0.0/8 — loopback
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 — link-local
    return false;
  }
  // IPv6 link-local: fe80::/10 (first 10 bits of fe80 = 1111 1110 10xx...).
  if (/^fe[89ab][0-9a-f]:/i.test(ip)) return true;
  return false;
}

/**
 * Resolve one hostname to a single IPv4 address via the system resolver
 * (`getent ahostsv4` — the same tool scripts/egress-allowlist.sh uses to pin
 * /etc/hosts). ALWAYS called from the runner itself (unsandboxed), never
 * from inside the Landlock-wrapped canary process — see buildEgressProbes
 * for why that distinction is the whole point. Injectable `spawn` for tests
 * (this machine's tests run on Windows/macOS dev boxes without `getent`).
 *
 * Deliberately does NOT reject a loopback/unspecified/link-local result
 * itself (2026-09-30 Fable re-review of #45, blocking note: an earlier
 * version of this fix rejected those addresses here unconditionally, which
 * broke a legitimate `sandboxEgressAllow` entry pointing at a local model
 * proxy — e.g. `127.0.0.1:8080` — since this same resolver backs BOTH the
 * "must be blocked" default hosts and any operator-configured "must be
 * reachable" allow hosts). See buildEgressProbes: the isUnsafeEgressProbeTarget
 * check is applied there, scoped to `expect: "deny"` probes only.
 * @param {string} host
 * @param {typeof spawnSync} [spawn]
 * @returns {string|null} an IPv4 dotted-quad, or null if resolution failed
 */
export function resolveEgressHost(host, spawn = spawnSync) {
  const r = spawn("getent", ["ahostsv4", host], { encoding: "utf8", timeout: 10_000 });
  if (r.error || r.status !== 0 || !r.stdout) return null;
  const first = r.stdout.split("\n").find((l) => l.trim());
  if (!first) return null;
  const ip = first.trim().split(/\s+/)[0];
  return ip || null;
}

/**
 * Egress probes for one run (sandboxEgress: "blocked"). Run through the exact
 * same canary process as the filesystem probes (buildCanaryProbes) — bellows
 * itself cannot close the network (it runs unprivileged; see
 * bin/landlock-exec.py), so these only VERIFY that something else (a
 * host-level firewall, e.g. the iptables allowlist in TUTORIAL.md) already
 * did. `kind: "net"` tells evaluateCanary to judge these by connect
 * success/failure rather than by filesystem errno.
 *
 * Every host:port is resolved to a literal IP HERE, in the runner, before the
 * probe is ever built — not left to CANARY_PY's `socket.create_connection`
 * to resolve by hostname inside the sandboxed process. That used to be a real
 * gap (2026-09-29 Fable review, #42 note 1 / #43 note 1): evaluateCanary
 * treats ANY connect failure on a `kind:"net"` probe as "denied" (a PASS for
 * an `expect:"deny"` row), so a broken resolver, a resolver rejected by a
 * partial firewall, or any other DNS hiccup inside the sandbox would make the
 * canary report the network "blocked" even though a raw IP connection (e.g.
 * `curl --resolve github.com:443:<ip> https://github.com/...`, or hardcoding
 * the IP) would sail straight through — DNS still works for the sandboxed
 * process by design (see TUTORIAL.md "Residual gaps"), so a DNS failure there
 * proves nothing about whether TCP itself is blocked. Resolving here instead
 * means every "must be blocked"/"must be reachable" verdict is a judgment
 * about an actual TCP connect to a real address, never about whether a
 * hostname happened to resolve inside the sandbox.
 *
 * If the RUNNER itself (unsandboxed, not subject to the gap above) can't
 * resolve a host, that's anomalous — DNS keeps working for the bench user by
 * design (see TUTORIAL.md), so a failure here usually means the resolver
 * itself is down. The check is then inconclusive and must fail loudly,
 * consistent with the "throw before pi exists" posture everywhere else in
 * this file, rather than silently reporting the host "blocked" because there
 * was no IP left to probe.
 * @param {{egress: "unchecked"|"blocked", egressAllow?: string[], resolveHost?: (host:string)=>(string|null)}} a
 * @returns {{name:string, op:"tcp", path:string, kind:"net", expect:"allow"|"deny"}[]}
 */
export function buildEgressProbes({ egress, egressAllow = [], resolveHost = resolveEgressHost }) {
  if (egress !== "blocked") return [];
  const toIpProbe = (hostPort, expect, nameSuffix) => {
    const idx = hostPort.lastIndexOf(":");
    const host = hostPort.slice(0, idx);
    const port = hostPort.slice(idx + 1);
    const ip = resolveHost(host);
    if (!ip)
      throw new Error(
        `sandbox egress check: could not resolve "${host}" (for "${hostPort}") from the runner — DNS failure or an unreachable resolver. ` +
          "The egress canary always probes a literal IP it resolved itself here, never a hostname resolved inside the sandbox, so a DNS " +
          `hiccup can never masquerade as "egress is blocked". Since the runner could not resolve "${host}", the check is inconclusive and ` +
          `must fail rather than silently report it ${expect === "deny" ? "blocked" : "reachable"} — fix DNS on this host and retry.`,
      );
    // Only a DENY probe's resolution is checked against isUnsafeEgressProbeTarget
    // (2026-09-30 Fable re-review of #45, blocking note): a "must be blocked"
    // default host (github.com etc.) resolving to loopback/unspecified/
    // link-local means a hosts-file entry or DNS sinkhole hijacked it, and
    // probing that address would "confirm" a block that proves nothing about
    // the real host. An ALLOW probe (sandboxEgressAllow) has no such gap — an
    // operator pointing it at 127.0.0.1 (a local model proxy, say) means
    // exactly that, and it's a legitimate, intentional target.
    if (expect === "deny" && isUnsafeEgressProbeTarget(ip)) {
      throw new Error(
        `sandbox egress check: "${host}" (for "${hostPort}") resolved to ${ip} — a loopback/unspecified/link-local address. ` +
          `A hosts-file entry or DNS sinkhole can make a "must be blocked" host resolve to the local machine itself, which would let this ` +
          `probe "confirm" a block by finding nothing listening there, proving nothing about whether the real "${host}" is actually reachable. ` +
          "Treating this the same as an unresolvable host: the check is inconclusive and must fail rather than silently report it blocked.",
      );
    }
    return { name: `egress: ${hostPort} (${ip}) ${nameSuffix}`, op: "tcp", path: `${ip}:${port}`, kind: "net", expect };
  };
  const probes = [];
  for (const hostPort of DEFAULT_EGRESS_BLOCKED_HOSTS) probes.push(toIpProbe(hostPort, "deny", "must be blocked"));
  for (const hostPort of egressAllow) probes.push(toIpProbe(hostPort, "allow", "must be reachable (sandboxEgressAllow)"));
  return probes;
}

/**
 * Judge probe results. A filesystem deny probe passes only on EACCES/EPERM;
 * success is an isolation breach ("ESCAPED") and any other error is
 * inconclusive (e.g. ENOENT could hide a missing target). A net probe
 * (`kind: "net"`, egress checking) has no meaningful errno to check —
 * "connection refused/reset/timeout" are all just "not ok", and ANY of them
 * count as blocked. This is safe from a DNS false-"blocked" only because
 * buildEgressProbes already resolved every host to a literal IP in the
 * runner before this ever sees the probe — CANARY_PY's "tcp" op is handed an
 * IP, not a hostname, so there is no DNS lookup left to fail inside the
 * sandbox by the time a probe reaches this function. An allow probe
 * (filesystem or net) passes only on success.
 * @returns {{ok:boolean, escaped:boolean, rows:{name:string, expect:string, got:string, pass:boolean, detail:string}[]}}
 */
export function evaluateCanary(probes, results) {
  const byName = new Map((Array.isArray(results) ? results : []).map((r) => [r.name, r]));
  let escaped = false;
  const rows = probes.map((p) => {
    const r = byName.get(p.name);
    if (!r) return { name: p.name, expect: p.expect, got: "no result", pass: false, detail: "" };
    let got;
    let pass;
    if (r.ok) {
      got = "allowed";
      pass = p.expect === "allow";
      if (p.expect === "deny") escaped = true;
    } else if (p.kind === "net" || r.errno === EACCES || r.errno === EPERM) {
      got = "denied";
      pass = p.expect === "deny";
    } else {
      got = r.errno != null ? `error errno=${r.errno}` : "error";
      pass = false;
    }
    return { name: p.name, expect: p.expect, got, pass, detail: r.detail || "" };
  });
  return { ok: rows.length > 0 && rows.every((r) => r.pass), escaped, rows };
}

/** Plain-text PASS/FAIL table. */
export function formatCanaryTable(rows) {
  const w = Math.max(5, ...rows.map((r) => r.name.length));
  const lines = [`${"probe".padEnd(w)}  expect  got        result  detail`];
  for (const r of rows) {
    const result = r.pass ? "PASS" : r.expect === "deny" && r.got === "allowed" ? "ESCAPE" : "FAIL";
    lines.push(`${r.name.padEnd(w)}  ${r.expect.padEnd(6)}  ${r.got.padEnd(9)}  ${result.padEnd(6)}  ${r.detail}`);
  }
  return lines.join("\n");
}

/**
 * Run the probes through `prefix` (the exact wrapper argv pi will get) with
 * pi's env and cwd.
 * @returns {{ok:boolean, escaped:boolean, rows:object[], table:string, error?:string}}
 */
export function runCanary({ prefix, probes, env, cwd, python, spawn = spawnSync }) {
  const py = python || resolvePython3();
  const r = spawn(prefix[0], [...prefix.slice(1), py, "-I", "-S", "-c", CANARY_PY, JSON.stringify(probes)], {
    env,
    cwd,
    encoding: "utf8",
    timeout: 120_000,
    windowsHide: true,
  });
  let results = null;
  let error;
  if (r.error) error = `canary spawn failed: ${r.error.message}`;
  else if (r.status !== 0) error = `canary exited ${r.status}: ${(r.stderr || "").trim().split("\n").slice(-3).join(" | ")}`;
  else {
    try {
      results = JSON.parse(String(r.stdout).trim().split("\n").pop());
    } catch (e) {
      error = `canary output unparsable: ${e.message}`;
    }
  }
  const ev = evaluateCanary(probes, results || []);
  const table = formatCanaryTable(ev.rows);
  return { ok: !error && ev.ok, escaped: ev.escaped, rows: ev.rows, table, ...(error ? { error } : {}) };
}

/** Create an empty file if missing (never truncates). */
function touch(p) {
  fs.closeSync(fs.openSync(p, "a"));
}

/**
 * Everything executeRun (and `bellows sandbox-check`) needs to launch pi
 * sandboxed: creates <runDir>/tmp and <runDir>/bin, pre-creates the run's
 * harness files so they exist for the deny probes and the write-only grant,
 * sets piEnv.TMPDIR, builds the policy + wrapper prefix and runs the canary.
 * Throws (before pi exists) if anything is off.
 *
 * @param {object} a
 * @param {import("../types.ts").BenchConfig} a.config
 * @param {string} a.runDir
 * @param {string} a.workspaceDir
 * @param {string} a.agentDir
 * @param {string} a.accordionHome
 * @param {string} a.accordionRepo        effective checkout
 * @param {string|null} a.hostTelemetryFile
 * @param {string} a.completionLogFile
 * @param {string} a.piRpcLogFile
 * @param {string} a.runsRoot
 * @param {NodeJS.ProcessEnv} a.piEnv      mutated: TMPDIR is set
 * @param {"unchecked"|"blocked"} [a.sandboxEgress]  resolved via resolveSandboxEgress; default "unchecked"
 * @param {(m:string)=>void} [a.log]
 * @returns {{prefix:string[], piPath:string, rules:object[], tmpDir:string, canary:object, sandboxEgress:"unchecked"|"blocked"}}
 */
export function prepareLandlockRun(a) {
  const log = a.log || (() => {});
  const tmpDir = path.join(a.runDir, "tmp");
  const binDir = path.join(a.runDir, "bin");
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  touch(a.completionLogFile);
  touch(a.piRpcLogFile);
  if (a.hostTelemetryFile) touch(a.hostTelemetryFile);
  a.piEnv.TMPDIR = tmpDir;

  const piPath = resolveCommand("pi");
  if (!path.isAbsolute(piPath) || !fs.existsSync(piPath)) throw new Error(`sandbox: cannot resolve an absolute path for "pi" (got "${piPath}")`);
  const python = resolvePython3();
  const rules = buildLandlockPolicy({
    workspaceDir: a.workspaceDir,
    agentDir: a.agentDir,
    accordionHome: a.accordionHome,
    tmpDir,
    binDir,
    completionLogFile: a.completionLogFile,
    accordionRepo: a.accordionRepo,
    piPath,
    env: a.piEnv,
    extra: a.config.sandboxAllow,
  });
  const prefix = landlockArgvPrefix(rules, { python });
  const decoyFile = ensureCanaryDecoy(a.runsRoot);
  const sandboxEgress = a.sandboxEgress || "unchecked";
  const probes = [
    ...buildCanaryProbes({
      runDir: a.runDir,
      workspaceDir: a.workspaceDir,
      tmpDir,
      binDir,
      accordionRepo: a.accordionRepo,
      completionLogFile: a.completionLogFile,
      ownHarnessFiles: [a.hostTelemetryFile, a.piRpcLogFile].filter(Boolean),
      decoyFile,
      runsRoot: a.runsRoot,
    }),
    ...buildEgressProbes({ egress: sandboxEgress, egressAllow: a.config.sandboxEgressAllow }),
  ];
  const t0 = Date.now();
  const canary = runCanary({ prefix, probes, env: a.piEnv, cwd: a.workspaceDir, python });
  log(
    `[sandbox] landlock: ${rules.length} grants; egress=${sandboxEgress}; canary ${canary.ok ? "PASSED" : "FAILED"} ` +
      `in ${Date.now() - t0}ms\n${canary.table}`,
  );
  if (!canary.ok) {
    const why = canary.error
      ? canary.error
      : canary.escaped
        ? `isolation probe(s) ESCAPED: ${canary.rows.filter((r) => r.expect === "deny" && r.got === "allowed").map((r) => r.name).join("; ")}`
        : `probe(s) failed: ${canary.rows.filter((r) => !r.pass).map((r) => `${r.name} (${r.got}${r.detail ? `: ${r.detail}` : ""})`).join("; ")}`;
    throw new Error(`sandbox canary failed — refusing to start pi: ${why}`);
  }
  return { prefix, piPath, rules, tmpDir, canary, sandboxEgress };
}
