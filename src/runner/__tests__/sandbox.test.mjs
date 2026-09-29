import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  resolveSandboxMode,
  resolveSandboxEgress,
  assertLandlockAvailable,
  landlockAbi,
  buildLandlockPolicy,
  resolvePiInstallRoot,
  validateSandboxAllow,
  validateSandboxEgressAllow,
  rulesToArgs,
  landlockArgvPrefix,
  buildCanaryProbes,
  buildEgressProbes,
  evaluateCanary,
  formatCanaryTable,
  runCanary,
  CANARY_PY,
  LANDLOCK_EXEC,
  SYSTEM_RX,
  DEV_RW,
  DEFAULT_EGRESS_BLOCKED_HOSTS,
} from "../sandbox.mjs";

describe("resolveSandboxMode", () => {
  it("defaults to off when neither config nor trial says anything", () => {
    expect(resolveSandboxMode({}, {})).toBe("off");
    expect(resolveSandboxMode({ sandbox: "off" }, undefined)).toBe("off");
  });

  it("config landlock applies to every trial", () => {
    expect(resolveSandboxMode({ sandbox: "landlock" }, {})).toBe("landlock");
    expect(resolveSandboxMode({ sandbox: "landlock" }, { sandbox: "landlock" })).toBe("landlock");
  });

  it("a trial can turn the sandbox ON over a config that leaves it off", () => {
    expect(resolveSandboxMode({ sandbox: "off" }, { sandbox: "landlock" })).toBe("landlock");
    expect(resolveSandboxMode({}, { sandbox: "landlock" })).toBe("landlock");
  });

  it("a trial can NEVER turn off a sandbox the config enforces", () => {
    expect(() => resolveSandboxMode({ sandbox: "landlock" }, { sandbox: "off" })).toThrow(/can only enable the sandbox, never disable it/);
  });

  it("rejects unknown values from either side (platform-claimed specs are unvalidated)", () => {
    expect(() => resolveSandboxMode({ sandbox: "docker" }, {})).toThrow(/bench config is not one of off, landlock/);
    expect(() => resolveSandboxMode({}, { sandbox: true })).toThrow(/trial spec is not one of off, landlock/);
  });
});

describe("resolveSandboxEgress", () => {
  const landlock = { sandbox: "landlock" };

  it("defaults to unchecked when neither config nor trial says anything", () => {
    expect(resolveSandboxEgress({}, {})).toBe("unchecked");
    expect(resolveSandboxEgress({ sandboxEgress: "unchecked" }, undefined)).toBe("unchecked");
  });

  it("config blocked applies to every trial (given sandbox: landlock)", () => {
    expect(resolveSandboxEgress({ ...landlock, sandboxEgress: "blocked" }, {})).toBe("blocked");
    expect(resolveSandboxEgress({ ...landlock, sandboxEgress: "blocked" }, { sandboxEgress: "blocked" })).toBe("blocked");
  });

  it("a trial can turn egress checking ON over a config that leaves it unchecked", () => {
    expect(resolveSandboxEgress({ ...landlock, sandboxEgress: "unchecked" }, { sandboxEgress: "blocked" })).toBe("blocked");
    expect(resolveSandboxEgress(landlock, { sandboxEgress: "blocked" })).toBe("blocked");
  });

  it("a trial can NEVER turn off egress checking the config enforces", () => {
    expect(() => resolveSandboxEgress({ ...landlock, sandboxEgress: "blocked" }, { sandboxEgress: "unchecked" })).toThrow(
      /can only tighten egress checking, never loosen it/,
    );
  });

  it("rejects unknown values from either side", () => {
    expect(() => resolveSandboxEgress({ sandboxEgress: "open" }, {})).toThrow(/bench config is not one of unchecked, blocked/);
    expect(() => resolveSandboxEgress({}, { sandboxEgress: true })).toThrow(/trial spec is not one of unchecked, blocked/);
  });

  it('requires sandbox: "landlock" when egress resolves to blocked — never silently skips the check', () => {
    expect(() => resolveSandboxEgress({ sandboxEgress: "blocked" }, {})).toThrow(/requires sandbox: "landlock"/);
    expect(() => resolveSandboxEgress({}, { sandboxEgress: "blocked" })).toThrow(/requires sandbox: "landlock"/);
    // A trial requesting sandbox:"off" while a config enforces landlock already throws
    // earlier (resolveSandboxMode) — resolveSandboxEgress surfaces that same error.
    expect(() => resolveSandboxEgress(landlock, { sandbox: "off", sandboxEgress: "blocked" })).toThrow(
      /can only enable the sandbox, never disable it/,
    );
  });

  it("unchecked never requires landlock", () => {
    expect(resolveSandboxEgress({}, { sandboxEgress: "unchecked" })).toBe("unchecked");
  });

  // Owner decision, 2026-09-28 ("dont let them have internet"): sandboxEgress
  // defaults to "blocked" whenever the sandbox is "landlock", and "unchecked"
  // is only available when the sandbox is "off".
  describe("mode-based default (2026-09-28 decision)", () => {
    it('defaults to "blocked" when sandbox resolves to landlock via config, with neither side saying anything about egress', () => {
      expect(resolveSandboxEgress(landlock, {})).toBe("blocked");
      expect(resolveSandboxEgress(landlock, undefined)).toBe("blocked");
    });

    it('defaults to "blocked" when a TRIAL turns sandbox landlock on, with neither side saying anything about egress', () => {
      expect(resolveSandboxEgress({}, { sandbox: "landlock" })).toBe("blocked");
      expect(resolveSandboxEgress({ sandbox: "off" }, { sandbox: "landlock" })).toBe("blocked");
    });

    it('still defaults to "unchecked" when the effective sandbox is off', () => {
      expect(resolveSandboxEgress({}, {})).toBe("unchecked");
      expect(resolveSandboxEgress({ sandbox: "off" }, undefined)).toBe("unchecked");
    });

    it('rejects an explicit config-level "unchecked" once sandbox resolves to landlock (config sandbox: landlock)', () => {
      expect(() => resolveSandboxEgress({ ...landlock, sandboxEgress: "unchecked" }, {})).toThrow(
        /"unchecked" is not allowed together with sandbox: "landlock"/,
      );
    });

    it('rejects an explicit trial-level "unchecked" once sandbox resolves to landlock', () => {
      expect(() => resolveSandboxEgress(landlock, { sandboxEgress: "unchecked" })).toThrow(
        /"unchecked" is not allowed together with sandbox: "landlock"/,
      );
    });

    it('rejects a stale config-level "unchecked" (written when the default was flat) when a TRIAL turns landlock on per-trial', () => {
      // This is the exact footgun the mode-based default guards against: a
      // config author set sandboxEgress: "unchecked" back when "off" was the
      // only sandbox mode in play, then later a trial adds sandbox: "landlock"
      // without touching sandboxEgress. Silently keeping "unchecked" here would
      // defeat the whole point of the 2026-09-28 fix, so this throws instead.
      expect(() => resolveSandboxEgress({ sandboxEgress: "unchecked" }, { sandbox: "landlock" })).toThrow(
        /"unchecked" is not allowed together with sandbox: "landlock"/,
      );
    });

    it('an explicit "blocked" still wins over an explicit "unchecked" on the other side (tighten-only, no throw)', () => {
      expect(resolveSandboxEgress({ ...landlock, sandboxEgress: "unchecked" }, { sandboxEgress: "blocked" })).toBe("blocked");
    });
  });
});

describe("validateSandboxEgressAllow", () => {
  it("accepts absent and well-formed host:port entries", () => {
    expect(validateSandboxEgressAllow(undefined)).toEqual([]);
    expect(validateSandboxEgressAllow(["api.deepseek.com:443", "10.0.0.1:8080"])).toEqual([]);
  });
  it("flags malformed entries", () => {
    expect(validateSandboxEgressAllow("api.deepseek.com:443")).toEqual([
      'sandboxEgressAllow: must be a string[] of "host:port" entries if present',
    ]);
    expect(validateSandboxEgressAllow(["no-port"])).toEqual(['sandboxEgressAllow: "no-port" must look like "host:port" (e.g. "api.deepseek.com:443")']);
    expect(validateSandboxEgressAllow(["host:99999"])).toEqual(['sandboxEgressAllow: "host:99999" port must be 1-65535']);
    expect(validateSandboxEgressAllow(["host:0"])).toEqual(['sandboxEgressAllow: "host:0" port must be 1-65535']);
  });
});

describe("buildEgressProbes", () => {
  it("returns nothing when egress is unchecked", () => {
    expect(buildEgressProbes({ egress: "unchecked" })).toEqual([]);
    expect(buildEgressProbes({ egress: "unchecked", egressAllow: ["api.deepseek.com:443"] })).toEqual([]);
  });

  it("adds a deny probe for every default blocked host, kind net", () => {
    const probes = buildEgressProbes({ egress: "blocked" });
    expect(probes).toHaveLength(DEFAULT_EGRESS_BLOCKED_HOSTS.length);
    for (const p of probes) expect(p).toMatchObject({ op: "tcp", kind: "net", expect: "deny" });
    expect(probes.map((p) => p.path)).toEqual(DEFAULT_EGRESS_BLOCKED_HOSTS);
  });

  it("adds an allow probe for every sandboxEgressAllow entry", () => {
    const probes = buildEgressProbes({ egress: "blocked", egressAllow: ["api.deepseek.com:443"] });
    const allow = probes.filter((p) => p.expect === "allow");
    expect(allow).toEqual([
      { name: "egress: api.deepseek.com:443 must be reachable (sandboxEgressAllow)", op: "tcp", path: "api.deepseek.com:443", kind: "net", expect: "allow" },
    ]);
  });
});

describe("assertLandlockAvailable — never degrades to unsandboxed", () => {
  it("throws a clear error off Linux without probing the kernel", () => {
    let probed = false;
    expect(() =>
      assertLandlockAvailable({ platform: "win32", abi: () => ((probed = true), 8) }),
    ).toThrow(/requires Linux, but this runner is on win32\. Refusing to run the agent unsandboxed/);
    expect(probed).toBe(false);
  });

  it("throws when the kernel reports ABI 0 (Landlock unavailable)", () => {
    expect(() => assertLandlockAvailable({ platform: "linux", abi: () => 0 })).toThrow(/no usable Landlock/);
  });

  it("returns the ABI when Landlock is usable", () => {
    expect(assertLandlockAvailable({ platform: "linux", abi: () => 8 })).toBe(8);
  });
});

describe("landlockAbi", () => {
  it("runs `python3 -I -S landlock-exec.py --abi` and parses the version", () => {
    let seen;
    const spawn = (file, args) => ((seen = { file, args }), { status: 0, stdout: "8\n", stderr: "" });
    expect(landlockAbi({ python: "/usr/bin/python3", spawn })).toBe(8);
    expect(seen).toEqual({ file: "/usr/bin/python3", args: ["-I", "-S", LANDLOCK_EXEC, "--abi"] });
  });

  it("throws (rather than reporting 0) when the wrapper itself fails", () => {
    const spawn = () => ({ status: 2, stdout: "", stderr: "boom" });
    expect(() => landlockAbi({ python: "/usr/bin/python3", spawn })).toThrow(/exited 2: boom/);
  });
});

// --- policy -------------------------------------------------------------------

const J = (...p) => path.join(...p);
const ROOT = path.resolve("/home/u/bench/bellows");
const RUN = J(ROOT, "runs", "t1", "keel-1");
const ACC = J(ROOT, "runs", "_accordion", "abc123");
const PI_BIN = path.resolve("/home/u/.npm-global/bin/pi");
const PI_PKG = path.resolve("/home/u/.npm-global/lib/node_modules/@x/pi-coding-agent");
const PI_REAL = J(PI_PKG, "dist", "bundle", "cli.js");

function fakeFs({ exists = [], links = {}, pkgs = {} } = {}) {
  const set = new Set(exists);
  return {
    existsSync: (p) => set.has(p),
    realpathSync: (p) => {
      if (links[p]) return links[p];
      if (set.has(p)) return p;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    readFileSync: (p) => {
      if (pkgs[p]) return JSON.stringify(pkgs[p]);
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
  };
}

function policyArgs(over = {}) {
  const runPaths = {
    workspaceDir: J(RUN, "workspace"),
    agentDir: J(RUN, "agent"),
    accordionHome: J(RUN, "accordion-home"),
    tmpDir: J(RUN, "tmp"),
    binDir: J(RUN, "bin"),
    completionLogFile: J(RUN, "completions.jsonl"),
  };
  const exists = [
    "/usr", "/bin", "/lib", "/lib64", "/etc", "/proc", "/sys",
    "/dev/null", "/dev/urandom", "/dev/tty",
    "/etc/resolv.conf", "/run/systemd/resolve/stub-resolv.conf", "/run/systemd/resolve",
    "/usr/bin/node",
    PI_BIN, PI_REAL, PI_PKG, ACC,
    J(ROOT, "src", "runner", "extensions"), J(ROOT, "node_modules"),
    ...Object.values(runPaths),
    ...(over.moreExists || []),
  ];
  return {
    ...runPaths,
    accordionRepo: ACC,
    piPath: PI_BIN,
    nodePath: "/usr/bin/node",
    bellowsRoot: ROOT,
    env: {},
    fsImpl: fakeFs({
      exists,
      links: { [PI_BIN]: PI_REAL, "/etc/resolv.conf": "/run/systemd/resolve/stub-resolv.conf", ...(over.links || {}) },
      pkgs: { [J(PI_PKG, "package.json")]: { name: "@x/pi-coding-agent" } },
    }),
    ...over.args,
  };
}

const grant = (rules, p) => rules.filter((r) => r.path === p).map((r) => r.mode);

describe("buildLandlockPolicy", () => {
  it("grants exactly the run's own dirs writable, and nothing above them", () => {
    const rules = buildLandlockPolicy(policyArgs());
    for (const d of ["workspace", "agent", "accordion-home", "tmp"]) expect(grant(rules, J(RUN, d))).toEqual(["rw"]);
    expect(grant(rules, J(RUN, "bin"))).toEqual(["rx"]);
    expect(grant(rules, J(RUN, "completions.jsonl"))).toEqual(["wo"]);
    // Never the run dir itself (host.jsonl, pi-rpc.log, record.json live there),
    // the trial dir, runs root, bellows checkout, its parent, home, or /tmp.
    const forbidden = [RUN, path.dirname(RUN), J(ROOT, "runs"), ROOT, path.dirname(ROOT), path.resolve("/home/u"), "/home", "/tmp", "/"];
    for (const f of forbidden) expect(grant(rules, f)).toEqual([]);
    const writable = rules.filter((r) => r.mode === "rw").map((r) => r.path);
    expect(writable.sort()).toEqual([...DEV_RW.filter((d) => ["/dev/null", "/dev/urandom", "/dev/tty"].includes(d)), ...["workspace", "agent", "accordion-home", "tmp"].map((d) => J(RUN, d))].sort());
  });

  it("grants runtime code read+exec: pi's package root (not the whole npm prefix), accordion checkout", () => {
    const rules = buildLandlockPolicy(policyArgs());
    expect(grant(rules, PI_PKG)).toEqual(["rx"]);
    expect(grant(rules, path.resolve("/home/u/.npm-global"))).toEqual([]);
    expect(grant(rules, ACC)).toEqual(["rx"]);
    expect(grant(rules, J(ROOT, "src", "runner", "extensions"))).toEqual(["ro"]);
  });

  it("only grants bellows' node_modules when the accordion checkout lives inside the bellows tree", () => {
    const inside = buildLandlockPolicy(policyArgs());
    expect(grant(inside, J(ROOT, "node_modules"))).toEqual(["ro"]);
    const outsideAcc = path.resolve("/home/u/bench/accordion");
    const outside = buildLandlockPolicy(policyArgs({ moreExists: [outsideAcc], args: { accordionRepo: outsideAcc } }));
    expect(grant(outside, J(ROOT, "node_modules"))).toEqual([]);
    expect(grant(outside, outsideAcc)).toEqual(["rx"]);
  });

  it("includes only system paths that exist; /etc,/proc,/sys read-only; devices individually", () => {
    const rules = buildLandlockPolicy(policyArgs());
    expect(grant(rules, "/usr")).toEqual(["rx"]);
    expect(grant(rules, "/sbin")).toEqual([]); // not in the fake fs
    for (const p of ["/etc", "/proc", "/sys"]) expect(grant(rules, p)).toEqual(["ro"]);
    expect(grant(rules, "/dev")).toEqual([]);
    expect(grant(rules, "/dev/null")).toEqual(["rw"]);
    expect(SYSTEM_RX).not.toContain("/home");
  });

  it("follows /etc symlinks that leave /etc (Ubuntu resolv.conf) with a read-only dir grant", () => {
    const rules = buildLandlockPolicy(policyArgs());
    expect(grant(rules, "/run/systemd/resolve")).toEqual(["ro"]);
    expect(grant(rules, "/run")).toEqual([]);
  });

  it("grants a TLS bundle from pi's env only when it isn't already covered", () => {
    const certifi = path.resolve("/home/u/.venv/certifi/cacert.pem");
    const rules = buildLandlockPolicy(
      policyArgs({ moreExists: [certifi, "/etc/ssl/certs/ca-certificates.crt"], args: { env: { SSL_CERT_FILE: certifi, REQUESTS_CA_BUNDLE: "/etc/ssl/certs/ca-certificates.crt" } } }),
    );
    expect(grant(rules, certifi)).toEqual(["ro"]);
    expect(grant(rules, "/etc/ssl/certs/ca-certificates.crt")).toEqual([]); // under /etc already
  });

  it("grants node's own prefix when node lives outside the system dirs (nvm)", () => {
    const nvmPrefix = path.resolve("/home/u/.nvm/versions/node/v22");
    const nvmNode = J(nvmPrefix, "bin", "node");
    const rules = buildLandlockPolicy(policyArgs({ moreExists: [nvmNode, nvmPrefix], args: { nodePath: nvmNode } }));
    expect(grant(rules, nvmPrefix)).toEqual(["rx"]);
    expect(grant(rules, path.resolve("/home/u"))).toEqual([]);
  });

  it("appends config.sandboxAllow grants", () => {
    const extra = { rx: [path.resolve("/opt2/probe-venv")], ro: [path.resolve("/data/ro")] };
    const rules = buildLandlockPolicy(policyArgs({ moreExists: [...extra.rx, ...extra.ro], args: { extra } }));
    expect(grant(rules, extra.rx[0])).toEqual(["rx"]);
    expect(grant(rules, extra.ro[0])).toEqual(["ro"]);
  });

  it("throws (never silently drops) when a required path is missing", () => {
    const a = policyArgs();
    const fsImpl = { ...a.fsImpl, existsSync: (p) => p !== ACC && a.fsImpl.existsSync(p) };
    expect(() => buildLandlockPolicy({ ...a, fsImpl })).toThrow(/accordion checkout.*does not exist/);
    const extra = { rw: [path.resolve("/nope")] };
    expect(() => buildLandlockPolicy({ ...policyArgs(), extra })).toThrow(/config\.sandboxAllow path does not exist/);
  });
});

describe("resolvePiInstallRoot", () => {
  it("walks up from the bin symlink's target to the first named package.json", () => {
    const f = fakeFs({ exists: [PI_BIN, PI_REAL], links: { [PI_BIN]: PI_REAL }, pkgs: { [J(PI_PKG, "package.json")]: { name: "@x/pi" } } });
    expect(resolvePiInstallRoot(PI_BIN, f)).toBe(PI_PKG);
  });

  it("skips unnamed package.json files (e.g. dist/{\"type\":\"module\"})", () => {
    const f = fakeFs({ links: { [PI_BIN]: PI_REAL }, pkgs: { [J(PI_PKG, "dist", "package.json")]: { type: "module" }, [J(PI_PKG, "package.json")]: { name: "@x/pi" } } });
    expect(resolvePiInstallRoot(PI_BIN, f)).toBe(PI_PKG);
  });

  it("falls back to the bin's prefix when no package.json is found", () => {
    const f = fakeFs({ links: { [PI_BIN]: PI_REAL } });
    expect(resolvePiInstallRoot(PI_BIN, f)).toBe(path.resolve("/home/u/.npm-global"));
  });
});

describe("validateSandboxAllow", () => {
  it("accepts absent and well-formed values", () => {
    expect(validateSandboxAllow(undefined)).toEqual([]);
    expect(validateSandboxAllow({ ro: ["/a"], rx: [], rw: ["/b/c"] })).toEqual([]);
  });
  it("flags every problem", () => {
    expect(validateSandboxAllow({ wo: ["/a"], ro: "x", rw: ["rel"] })).toEqual([
      "sandboxAllow.wo: unknown key (allowed: ro, rx, rw)",
      "sandboxAllow.ro: must be a string[] of paths",
      'sandboxAllow.rw: "rel" must be an absolute path',
    ]);
  });
});

describe("wrapper argv", () => {
  const rules = [
    { mode: "rx", path: "/usr", why: "" },
    { mode: "rw", path: "/w", why: "" },
    { mode: "wo", path: "/w.log", why: "" },
  ];
  it("rulesToArgs emits --mode path pairs in order", () => {
    expect(rulesToArgs(rules)).toEqual(["--rx", "/usr", "--rw", "/w", "--wo", "/w.log"]);
  });
  it("landlockArgvPrefix is python3 -I -S <wrapper> <grants> -- (command appended by the caller)", () => {
    expect(landlockArgvPrefix(rules, { python: "/usr/bin/python3" })).toEqual([
      "/usr/bin/python3", "-I", "-S", LANDLOCK_EXEC, "--rx", "/usr", "--rw", "/w", "--wo", "/w.log", "--",
    ]);
  });
});

// --- canary -------------------------------------------------------------------

describe("buildCanaryProbes", () => {
  const home = path.resolve("/home/u");
  const runsRoot = J(ROOT, "runs");
  const decoy = J(runsRoot, "_sandbox_canary", "decoy-run", "workspace", "solution.py");
  const sibling = J(path.dirname(RUN), "triptych-1", "workspace");
  const existing = new Set([
    J(RUN, "workspace"), J(RUN, "bin", "python"), J(ACC, "extension", "accordion.ts"), decoy, sibling,
    path.dirname(RUN), runsRoot, path.dirname(ROOT), J(path.dirname(ROOT), "env.sh"), home,
    J(ROOT, "package.json"), J(RUN, "host.jsonl"), J(RUN, "pi-rpc.log"), J(RUN, "completions.jsonl"),
    RUN, "/tmp", "/proc/42/environ", "/proc/42/cwd",
  ]);
  const probes = buildCanaryProbes({
    runDir: RUN,
    workspaceDir: J(RUN, "workspace"),
    tmpDir: J(RUN, "tmp"),
    binDir: J(RUN, "bin"),
    accordionRepo: ACC,
    completionLogFile: J(RUN, "completions.jsonl"),
    ownHarnessFiles: [J(RUN, "host.jsonl"), J(RUN, "pi-rpc.log")],
    decoyFile: decoy,
    runsRoot,
    bellowsRoot: ROOT,
    homeDir: home,
    runnerPid: 42,
    existsSync: (p) => existing.has(p),
    readdirSync: () => ["keel-1", "triptych-1"],
  });
  const byName = Object.fromEntries(probes.map((p) => [p.name, p]));

  it("covers every isolation requirement as a deny probe on an EXISTING target", () => {
    const denies = probes.filter((p) => p.expect === "deny");
    for (const [name, op, target] of [
      ["read another run's workspace (decoy)", "read", decoy],
      ["list sibling run triptych-1/workspace", "list", sibling],
      ["list bellows checkout's parent dir", "list", path.dirname(ROOT)],
      ["read env.sh next to the checkout", "read", J(path.dirname(ROOT), "env.sh")],
      ["read own host.jsonl", "read", J(RUN, "host.jsonl")],
      ["read own pi-rpc.log", "read", J(RUN, "pi-rpc.log")],
      ["read back completion log (write-only)", "read", J(RUN, "completions.jsonl")],
      ["list /tmp", "list", "/tmp"],
      ["read runner's /proc/<pid>/environ", "read", "/proc/42/environ"],
      ["list runner's /proc/<pid>/cwd", "list", "/proc/42/cwd"],
    ]) {
      expect(byName[name], name).toMatchObject({ op, path: target, expect: "deny" });
    }
    for (const d of denies) if (d.op !== "create") expect(existing.has(d.path), d.name).toBe(true);
  });

  it("gates create probes on a missing target with an existing parent", () => {
    expect(byName["create file in run dir"]).toMatchObject({ op: "create", path: J(RUN, ".sandbox-escape-42") });
    expect(byName["create file in /tmp"]).toMatchObject({ op: "create", path: "/tmp/bellows-sandbox-escape-42" });
  });

  it("skips deny probes whose target is absent (ENOENT would look like a pass)", () => {
    expect(byName["read bench.config.json"]).toBeUndefined();
  });

  it("never probes its own workspace as a 'sibling'", () => {
    expect(probes.some((p) => p.name.includes("keel-1/workspace"))).toBe(false);
  });

  it("includes the allow probes the run needs to work", () => {
    expect(byName["write+read workspace"]).toMatchObject({ op: "write", expect: "allow" });
    expect(byName["TMPDIR is the run tmp + writable"]).toMatchObject({ op: "tmpdir", path: J(RUN, "tmp") });
    expect(byName["exec node -v"].argv).toEqual(["node", "-v"]);
    expect(byName["exec python3 -V"].argv).toEqual(["python3", "-V"]);
    expect(byName["exec python -V (shim)"].argv).toEqual(["python", "-V"]);
    expect(byName["append-open completion log"]).toMatchObject({ op: "open-wo", expect: "allow" });
  });
});

describe("evaluateCanary", () => {
  const probes = [
    { name: "a", op: "read", expect: "deny" },
    { name: "b", op: "write", expect: "allow" },
  ];
  it("passes only on EACCES/EPERM denies and successful allows", () => {
    expect(evaluateCanary(probes, [{ name: "a", ok: false, errno: 13 }, { name: "b", ok: true }]).ok).toBe(true);
    expect(evaluateCanary(probes, [{ name: "a", ok: false, errno: 1 }, { name: "b", ok: true }]).ok).toBe(true);
  });
  it("flags a deny probe that succeeded as an ESCAPE", () => {
    const ev = evaluateCanary(probes, [{ name: "a", ok: true }, { name: "b", ok: true }]);
    expect(ev).toMatchObject({ ok: false, escaped: true });
    expect(formatCanaryTable(ev.rows)).toMatch(/a\s+deny\s+allowed\s+ESCAPE/);
  });
  it("treats any other errno on a deny probe as inconclusive, not a pass", () => {
    const ev = evaluateCanary(probes, [{ name: "a", ok: false, errno: 2 }, { name: "b", ok: true }]);
    expect(ev.ok).toBe(false);
    expect(ev.escaped).toBe(false);
    expect(ev.rows[0].got).toBe("error errno=2");
  });
  it("fails on a failed allow probe or a missing result", () => {
    expect(evaluateCanary(probes, [{ name: "a", ok: false, errno: 13 }, { name: "b", ok: false, errno: 13 }]).ok).toBe(false);
    expect(evaluateCanary(probes, [{ name: "a", ok: false, errno: 13 }]).ok).toBe(false);
    expect(evaluateCanary([], []).ok).toBe(false);
  });

  describe("net probes (sandboxEgress, kind: 'net')", () => {
    const netProbes = [
      { name: "blocked-host", op: "tcp", path: "github.com:443", kind: "net", expect: "deny" },
      { name: "allowed-host", op: "tcp", path: "api.deepseek.com:443", kind: "net", expect: "allow" },
    ];
    it("a blocked-expected probe passes on ANY failure (refused/reset/timeout/DNS all count as blocked)", () => {
      for (const errno of [111, 110, null, -2]) {
        const ev = evaluateCanary(netProbes, [
          { name: "blocked-host", ok: false, errno, detail: "whatever" },
          { name: "allowed-host", ok: true },
        ]);
        expect(ev.ok, `errno=${errno}`).toBe(true);
        expect(ev.rows[0]).toMatchObject({ got: "denied", pass: true });
      }
    });
    it("a blocked-expected probe that connects is an ESCAPE, same as a filesystem escape", () => {
      const ev = evaluateCanary(netProbes, [{ name: "blocked-host", ok: true }, { name: "allowed-host", ok: true }]);
      expect(ev).toMatchObject({ ok: false, escaped: true });
      expect(ev.rows[0]).toMatchObject({ got: "allowed", pass: false });
      expect(formatCanaryTable(ev.rows)).toMatch(/blocked-host\s+deny\s+allowed\s+ESCAPE/);
    });
    it("an allow-expected probe (sandboxEgressAllow) fails if the connection could not be made", () => {
      const ev = evaluateCanary(netProbes, [{ name: "blocked-host", ok: false, errno: 111 }, { name: "allowed-host", ok: false, errno: 110 }]);
      expect(ev.ok).toBe(false);
      expect(ev.rows[1]).toMatchObject({ expect: "allow", got: "denied", pass: false });
    });
  });
});

describe("runCanary", () => {
  const probes = [{ name: "a", op: "read", path: "/x", expect: "deny" }];
  it("runs the probe program through the exact prefix with pi's env and cwd", () => {
    let seen;
    const spawn = (file, args, opts) => {
      seen = { file, args, opts };
      return { status: 0, stdout: `noise\n${JSON.stringify([{ name: "a", ok: false, errno: 13, detail: "Permission denied" }])}\n`, stderr: "" };
    };
    const prefix = ["/usr/bin/python3", "-I", "-S", LANDLOCK_EXEC, "--rx", "/usr", "--"];
    const env = { PATH: "/usr/bin", TMPDIR: "/r/tmp" };
    const res = runCanary({ prefix, probes, env, cwd: "/r/workspace", python: "/usr/bin/python3", spawn });
    expect(seen.file).toBe("/usr/bin/python3");
    expect(seen.args).toEqual([...prefix.slice(1), "/usr/bin/python3", "-I", "-S", "-c", CANARY_PY, JSON.stringify(probes)]);
    expect(seen.opts).toMatchObject({ env, cwd: "/r/workspace" });
    expect(res.ok).toBe(true);
    expect(res.table).toMatch(/PASS/);
  });
  it("fails closed when the wrapper refuses to start (exit 125)", () => {
    const spawn = () => ({ status: 125, stdout: "", stderr: "landlock-exec: Landlock is unavailable" });
    const res = runCanary({ prefix: ["p", "--"], probes, env: {}, cwd: "/", python: "py", spawn });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/exited 125: landlock-exec: Landlock is unavailable/);
  });

  it("runs fs + egress probes in ONE spawn (same process context) and judges each by its own rule", () => {
    // No real network call happens here — spawn is mocked, exactly like the
    // filesystem-only test above. This only proves the wiring: buildEgressProbes'
    // output flows through the exact same runCanary/evaluateCanary path.
    const mixed = [
      { name: "fs-deny", op: "read", path: "/other/run", expect: "deny" },
      { name: "egress: github.com:443 must be blocked", op: "tcp", path: "github.com:443", kind: "net", expect: "deny" },
    ];
    const spawn = () => ({
      status: 0,
      stdout: JSON.stringify([
        { name: "fs-deny", ok: false, errno: 13, detail: "Permission denied" },
        { name: "egress: github.com:443 must be blocked", ok: false, errno: null, detail: "timed out" },
      ]),
      stderr: "",
    });
    const res = runCanary({ prefix: ["py", "-I", "-S", LANDLOCK_EXEC, "--"], probes: mixed, env: {}, cwd: "/r/workspace", python: "py", spawn });
    expect(res.ok).toBe(true);
    expect(res.table).toMatch(/fs-deny\s+deny\s+denied\s+PASS/);
    expect(res.table).toMatch(/egress: github\.com:443 must be blocked\s+deny\s+denied\s+PASS/);
  });
});

describe("PiRpc commandPrefix", () => {
  it("spawns the prefix with pi's argv appended (and pi directly when empty)", async () => {
    const { PiRpc } = await import("../rpc.mjs");
    // A stand-in "wrapper": node -e <echo argv as an RPC line> MARK -> argv = [MARK, pi, --mode, rpc, ...]
    const echo = "process.stdout.write(JSON.stringify({type:'argv',argv:process.argv.slice(1)})+'\\n')";
    const rpc = new PiRpc({ piCommand: "fake-pi", cwd: process.cwd(), env: process.env, extraArgs: ["--x"], commandPrefix: [process.execPath, "-e", echo, "MARK"] });
    const line = await new Promise((resolve, reject) => {
      rpc.on("line", resolve);
      rpc.on("exit", () => setTimeout(() => reject(new Error("exited without output")), 200));
      rpc.start();
    });
    expect(line).toEqual({ type: "argv", argv: ["MARK", "fake-pi", "--mode", "rpc", "--x"] });
  });
});

// --- real kernel (Linux + Landlock only) -----------------------------------------

function realAbi() {
  if (process.platform !== "linux") return 0;
  try {
    return landlockAbi();
  } catch {
    return 0;
  }
}
const ABI = realAbi();

describe.skipIf(ABI < 1)("landlock-exec.py on this kernel", () => {
  let dir;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });
  const py = () => spawnSync("which", ["python3"], { encoding: "utf8" }).stdout.trim();
  const sys = () => [
    ...["/usr", "/bin", "/lib", "/lib64"].filter((p) => fs.existsSync(p)).flatMap((p) => ["--rx", p]),
    ...["/etc", "/proc"].flatMap((p) => ["--ro", p]),
    ...["/dev/null", "/dev/urandom"].flatMap((p) => ["--rw", p]),
  ];
  const prefix = (grants) => [py(), "-I", "-S", LANDLOCK_EXEC, ...sys(), ...grants, "--"];
  const wrap = (grants, cmd, opts = {}) => {
    const [file, ...args] = prefix(grants);
    return spawnSync(file, [...args, ...cmd], { encoding: "utf8", ...opts });
  };

  it("confines reads/writes to granted trees, and children inherit it", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bellows-ll-"));
    const ws = path.join(dir, "ws");
    const other = path.join(dir, "other");
    fs.mkdirSync(ws);
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, "secret.txt"), "s3cret");
    const r = wrap(["--rw", ws], ["/bin/sh", "-c", `echo ok > ${ws}/f && cat ${ws}/f; cat ${other}/secret.txt; echo x > ${dir}/escape; sh -c 'ls ${other}'`]);
    expect(r.stdout).toContain("ok");
    expect(r.stdout).not.toContain("s3cret");
    expect(r.stderr).toMatch(/secret\.txt: Permission denied/);
    expect(r.stderr).toMatch(/escape: Permission denied/);
    expect(r.stderr).toMatch(/cannot open directory.*Permission denied/);
    expect(fs.existsSync(path.join(dir, "escape"))).toBe(false);
  });

  it("--wo grants append to an existing file but never reading it", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bellows-ll-"));
    const log = path.join(dir, "log.jsonl");
    fs.writeFileSync(log, "");
    const r = wrap(["--wo", log], ["/bin/sh", "-c", `echo line >> ${log}; cat ${log}`]);
    expect(r.stderr).toMatch(/log\.jsonl: Permission denied/);
    expect(fs.readFileSync(log, "utf8")).toBe("line\n");
  });

  it("forwards the env byte-for-byte (no PEP 538 LC_CTYPE injection)", () => {
    const env = { PATH: "/usr/bin:/bin", LANG: "C", ONLY_THIS: "1" };
    const r = wrap([], ["/usr/bin/env"], { env });
    expect(r.stdout.trim().split("\n").sort()).toEqual(["LANG=C", "ONLY_THIS=1", "PATH=/usr/bin:/bin"]);
  });

  it("fails loudly, never running the command unsandboxed", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bellows-ll-"));
    const marker = path.join(dir, "ran");
    const touch = ["/bin/sh", "-c", `echo ran > ${marker}`];
    expect(wrap(["--rw", path.join(dir, "missing")], touch).status).toBe(125);
    expect(wrap(["--wo", dir], touch).status).toBe(125);
    expect(fs.existsSync(marker)).toBe(false);
    expect(wrap(["--bogus", "/x"], touch).status).toBe(2);
    expect(wrap([], ["/definitely/not/a/command"]).status).toBe(127);
  });

  it("the canary program detects an escape when the deny target is readable", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bellows-ll-"));
    const ws = path.join(dir, "ws");
    fs.mkdirSync(ws);
    fs.writeFileSync(path.join(dir, "outside.txt"), "x");
    const probes = [
      { name: "outside", op: "read", path: path.join(dir, "outside.txt"), expect: "deny" },
      { name: "ws", op: "write", path: ws, expect: "allow" },
    ];
    const env = { PATH: "/usr/bin:/bin" };
    const sandboxed = runCanary({ prefix: prefix(["--rw", ws]), probes, env, cwd: ws, python: py() });
    expect(sandboxed.table).toMatch(/outside\s+deny\s+denied\s+PASS/);
    expect(sandboxed.ok).toBe(true);
    // Same probes with an over-broad grant: the canary must catch the escape.
    const leaky = runCanary({ prefix: prefix(["--rw", dir]), probes, env, cwd: ws, python: py() });
    expect(leaky).toMatchObject({ ok: false, escaped: true });
  });
});
