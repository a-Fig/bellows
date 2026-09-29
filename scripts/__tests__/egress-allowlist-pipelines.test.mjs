// In-repo tests for the shell (awk/sed) pipelines embedded in
// scripts/egress-allowlist.sh (2026-09-30 Fable re-review of #45: "add
// in-repo tests for the shell pipelines: feed sample `ss -ltnp` output and
// hosts files to the extracted awk/sed, run under bash in `npm test` if bash
// is available, and skip otherwise").
//
// These pull the pipeline TEXT straight out of the shipped script (via
// plain string extraction between fixed marker strings, asserted below) so
// the tests track the real production pipelines rather than a hand-copied
// duplicate that could silently drift out of sync — the exact failure mode
// several comments elsewhere in egress-allowlist.sh already call out
// ("kept in sync by hand"). If the script's surrounding text ever changes
// enough to move a marker, extraction throws immediately at module load
// (loudly, at test-collection time) instead of silently testing stale text.
//
// This never runs egress-allowlist.sh itself, never touches iptables/
// ip6tables, and never runs anything as root — it only ever invokes `awk`/
// `sed` on synthetic fixtures, exactly like a bench host's own `ss -ltnp`
// or `/etc/hosts` would look.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const SCRIPT_PATH = new URL("../egress-allowlist.sh", import.meta.url);
const scriptText = fs.readFileSync(SCRIPT_PATH, "utf8");

function bashAvailable() {
  try {
    const r = spawnSync("bash", ["--version"], { encoding: "utf8" });
    return r.status === 0;
  } catch {
    return false;
  }
}
const HAS_BASH = bashAvailable();

function extractBetween(marker, closer, label) {
  const startIdx = scriptText.indexOf(marker);
  if (startIdx === -1) {
    throw new Error(
      `egress-allowlist-pipelines.test.mjs: could not find the start marker for "${label}" in scripts/egress-allowlist.sh — ` +
        "the script's surrounding text changed shape; update this test's extraction marker to match.",
    );
  }
  const bodyStart = startIdx + marker.length;
  const closerIdx = scriptText.indexOf(closer, bodyStart);
  if (closerIdx === -1) {
    throw new Error(
      `egress-allowlist-pipelines.test.mjs: could not find the end marker for "${label}" in scripts/egress-allowlist.sh — ` +
        "the script's surrounding text changed shape; update this test's extraction marker to match.",
    );
  }
  const body = scriptText.slice(bodyStart, closerIdx);
  if (!body.trim()) {
    throw new Error(`egress-allowlist-pipelines.test.mjs: extracted an empty "${label}" pipeline — markers matched the wrong spot.`);
  }
  return body;
}

// check_loopback_listeners()'s `ss -ltnp | awk '...'` classifier — extracted
// from between `done < <(awk '` and `' <<<"$ss_out")`.
const LOOPBACK_AWK = extractBetween('done < <(awk \'', '\' <<<"$ss_out")', "check_loopback_listeners ss classifier awk");

// The --allow host /etc/hosts pin-line finder — extracted from between
// `hosts_line="$(awk -v h="$host" '` and `' /etc/hosts)"`.
const HOSTS_LINE_AWK = extractBetween('hosts_line="$(awk -v h="$host" \'', '\' /etc/hosts)"', "hosts-pin-line-finder awk");

// The --allow host /etc/hosts pin-line IP replacement — extracted from
// between `sed -i -E "${hosts_line}` and `" /etc/hosts` (the captured
// fragment still contains the literal `${ip}` placeholder text, substituted
// with a concrete test value below rather than left to shell expansion).
const HOSTS_SED_FRAGMENT = extractBetween('sed -i -E "${hosts_line}', '" /etc/hosts', "hosts-pin sed substitution");

// probe_tcp()'s rc/stderr-text classification if/elif chain — extracted from
// between `  if [ "$rc" -eq 0 ]; then` and the function's closing `\n}`.
// Deliberately excludes the /dev/tcp connect attempt itself (real network
// I/O, not something a unit test should do) — just the pure classification
// logic that turns an exit code + captured stderr text into one of
// open/timeout/refused/unreachable/error.
const PROBE_TCP_CLASSIFY = extractBetween('  if [ "$rc" -eq 0 ]; then', "\n}", "probe_tcp classification if/elif chain");

// resolve_ip()'s `resolvectl query -t A ... | awk '...'` A-record parser —
// extracted from between `2>/dev/null | awk '` and `')" || true` (2026-10-03
// Fable re-review of #46, cheap note: parse the address field properly
// instead of grabbing the first dotted-quad on the whole line, which could
// land inside a hostname or a CNAME target instead of the actual address).
const RESOLVECTL_A_PARSER = extractBetween("2>/dev/null | awk '", "')\" || true", "resolve_ip resolvectl A-record parser awk");

// check_ipv6_blocked()'s root-vs-non-root branch, including the `ip6tables`
// on-PATH guard's placement — extracted from `check_ipv6_blocked() {` to the
// function's own closing brace (2026-10-03 Fable re-review of #46,
// BLOCKER: the guard used to run before the root/non-root branch, so a
// non-root invoker with a PATH lacking /usr/sbin — cron's default, and
// Ubuntu's login.defs ENV_PATH — never reached the behavioral fallback at
// all and could silently PASS with IPv6 actually open).
const CHECK_IPV6_BLOCKED = extractBetween("check_ipv6_blocked() {", "\n}", "check_ipv6_blocked (ip6tables guard placement)");

function runBash(cmd, input) {
  const r = spawnSync("bash", ["-c", cmd], { input, encoding: "utf8" });
  if (r.error) throw r.error;
  return r;
}

describe.skipIf(!HAS_BASH)("egress-allowlist.sh shell pipelines (extracted from the real script)", () => {
  describe("check_loopback_listeners' ss -ltnp classifier awk", () => {
    const SAMPLE = [
      "State  Recv-Q Send-Q Local Address:Port  Peer Address:Port  Process",
      'LISTEN 0      128    127.0.0.1:8080     0.0.0.0:*      users:(("proxy",pid=1234,fd=3))',
      'LISTEN 0      128    0.0.0.0:22         0.0.0.0:*      users:(("sshd",pid=1,fd=3))',
      'LISTEN 0      128    [::]:22            [::]:*         users:(("sshd",pid=1,fd=4))',
      'LISTEN 0      128    [::ffff:127.0.0.1]:9000 [::]:*    users:(("java",pid=5555,fd=6))',
      'LISTEN 0      128    10.0.0.5:443       0.0.0.0:*      users:(("nginx",pid=99,fd=3))',
      'LISTEN 0      128    127.0.0.53:53      0.0.0.0:*      users:(("systemd-resolve",pid=2,fd=3))',
      // Literal "*:PORT" form (2026-10-01 Fable re-review of #45, cheap
      // note: "document and test the *:PORT form") — some ss/util-linux
      // versions print a bare "*" for an IPv4 wildcard bind instead of
      // "0.0.0.0", already matched by the classifier's `host == "*"` arm.
      'LISTEN 0      128    *:8005             *:*            users:(("legacytool",pid=77,fd=3))',
      // Literal ::1 (NOT the "::" wildcard below) deliberately excluded from
      // the SAMPLE's expectations, not from the SAMPLE itself: kept here so
      // the "excludes ::1" test right below can assert on the exact same
      // fixture the "flags everything else" test uses.
      'LISTEN 0      128    [::1]:9999         [::]:*         users:(("localtool",pid=42,fd=3))',
      "",
    ].join("\n");

    it("flags every loopback/wildcard/dual-stack form, excludes a real LAN address, and reconstructs bracketed IPv6 host:port", () => {
      const r = runBash(`awk '${LOOPBACK_AWK}'`, SAMPLE);
      expect(r.status).toBe(0);
      const lines = r.stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .sort();
      expect(lines).toEqual(
        [
          "0.0.0.0:22\t1",
          "127.0.0.1:8080\t1234",
          "127.0.0.53:53\t2",
          "[::]:22\t1",
          "[::ffff:127.0.0.1]:9000\t5555",
          "*:8005\t77",
        ].sort(),
      );
      // The one real (non-loopback) LAN listener in the sample must never
      // be reported — the whole point of the classifier.
      expect(r.stdout).not.toContain("10.0.0.5");
    });

    it("does NOT flag a literal ::1 listener (2026-10-01 Fable re-review of #45, cheap note — IPv6 is fully ip6tables-rejected for the bench uid before any --allow processing, so a listener bound to literal ::1, unlike the \"::\" wildcard, is unreachable by the bench user; dropped from the classifier deliberately)", () => {
      const r = runBash(`awk '${LOOPBACK_AWK}'`, SAMPLE);
      expect(r.status).toBe(0);
      expect(r.stdout).not.toContain("::1");
    });

    it("produces nothing when there are no loopback listeners at all", () => {
      const noLoopback = [
        "State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process",
        'LISTEN 0 128 10.0.0.5:443 0.0.0.0:* users:(("nginx",pid=99,fd=3))',
        "",
      ].join("\n");
      const r = runBash(`awk '${LOOPBACK_AWK}'`, noLoopback);
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe("");
    });
  });

  describe("--allow host /etc/hosts pin-line finder awk", () => {
    function findLine(host, hostsText) {
      const r = runBash(`awk -v h="${host}" '${HOSTS_LINE_AWK}'`, hostsText);
      expect(r.status).toBe(0);
      return r.stdout.trim();
    }

    it("finds a plain pinned line", () => {
      expect(findLine("api.deepseek.com", "127.0.0.1 localhost\n1.2.3.4 api.deepseek.com\n")).toBe("2");
    });

    it("finds a line with leading whitespace (an indented /etc/hosts entry)", () => {
      expect(findLine("example.com", "127.0.0.1 localhost\n  10.0.0.5 example.com www.example.com\n")).toBe("2");
    });

    it("finds the host even when it's a trailing alias, not the first hostname on the line", () => {
      expect(findLine("www.example.com", "127.0.0.1 localhost\n10.0.0.5 example.com www.example.com\n")).toBe("2");
    });

    it("ignores a host name that only appears after a # comment", () => {
      expect(findLine("api.deepseek.com", "127.0.0.1 localhost\n1.2.3.4 something-else # api.deepseek.com\n")).toBe("");
    });

    it("returns nothing when the host isn't pinned at all", () => {
      expect(findLine("nowhere.invalid", "127.0.0.1 localhost\n1.2.3.4 api.deepseek.com\n")).toBe("");
    });
  });

  describe("--allow host /etc/hosts pin-line IP replacement sed", () => {
    function replaceIp(line, ip) {
      const fragment = HOSTS_SED_FRAGMENT.replace("${ip}", ip);
      const r = runBash(`sed -E '1${fragment}'`, `${line}\n`);
      expect(r.status).toBe(0);
      return r.stdout.trimEnd();
    }

    it("replaces the address on a plain (non-indented) line", () => {
      expect(replaceIp("1.2.3.4 api.deepseek.com", "9.9.9.9")).toBe("9.9.9.9 api.deepseek.com");
    });

    it("replaces the address on a line with leading whitespace, instead of silently no-op'ing (2026-09-30 Fable re-review of #45, cheap note)", () => {
      expect(replaceIp("  1.2.3.4 api.deepseek.com", "9.9.9.9")).toBe("9.9.9.9 api.deepseek.com");
    });

    it("replaces an IPv6 address form too", () => {
      expect(replaceIp("::1 ip6-localhost", "::2")).toBe("::2 ip6-localhost");
    });
  });

  // 2026-10-02 Fable re-review of #45 round 3, blocking note 2: under
  // `net.ipv6.conf.all.disable_ipv6=1`, a v6 connect attempt gets
  // EADDRNOTAVAIL ("cannot assign requested address"), which the classifier
  // used to bucket as inconclusive "error" — meaning `--check` could never
  // PASS on such a host even though IPv6 genuinely is blocked. Also confirms
  // the same text is NOT treated as blocked for a v4 target, since an
  // unrelated local resource issue (e.g. ephemeral port exhaustion) could in
  // principle raise EADDRNOTAVAIL there without meaning anything about the
  // firewall.
  describe("probe_tcp's rc/stderr classification", () => {
    function classify(rc, out, isV6) {
      const script = `rc=${rc}\nout=${JSON.stringify(out)}\nis_v6=${isV6 ? "true" : "false"}\nif [ "$rc" -eq 0 ]; then${PROBE_TCP_CLASSIFY}\n`;
      const r = runBash(script);
      expect(r.status).toBe(0);
      return r.stdout.trim();
    }

    it("open on rc=0, timeout on rc=124", () => {
      expect(classify(0, "", false)).toBe("open");
      expect(classify(124, "", false)).toBe("timeout");
    });

    it("refused / unreachable on their strerror text, for either family", () => {
      expect(classify(1, "bash: connect: Connection refused", false)).toBe("refused");
      expect(classify(1, "bash: connect: Network is unreachable", false)).toBe("unreachable");
      expect(classify(1, "bash: connect: Network is unreachable", true)).toBe("unreachable");
    });

    it("EADDRNOTAVAIL ('cannot assign requested address') counts as unreachable for a v6 target", () => {
      expect(classify(1, "bash: connect: Cannot assign requested address", true)).toBe("unreachable");
    });

    it("the same EADDRNOTAVAIL text is left as inconclusive 'error' for a v4 target", () => {
      expect(classify(1, "bash: connect: Cannot assign requested address", false)).toBe("error");
    });

    it("anything else is inconclusive 'error', never silently blocked", () => {
      expect(classify(1, "bash: connect: Operation not permitted", false)).toBe("error");
    });
  });

  // 2026-10-03 Fable re-review of #46, cheap note: `resolvectl query -t A`
  // prints `<name> IN <type> <address>  -- link: <iface>` per matched
  // record — the owner NAME comes first (and can itself contain digits,
  // e.g. a numeric subdomain) and a CNAME chain prints its own `IN CNAME
  // <target>` line(s) ahead of the final `IN A` line(s). Filtering on
  // `$3 == "A"` (not "the first dotted-quad anywhere in the output") is
  // required so a CNAME target or a digit-bearing hostname can never be
  // mistaken for the address.
  describe("resolve_ip's resolvectl -t A output parser awk", () => {
    function parse(resolvectlOutput) {
      const r = runBash(`awk '${RESOLVECTL_A_PARSER}'`, resolvectlOutput);
      expect(r.status).toBe(0);
      return r.stdout.trim();
    }

    it("parses a single A record", () => {
      expect(parse("example.com IN A 104.20.23.154                              -- link: eth0\n")).toBe("104.20.23.154");
    });

    it("takes the first A record when there are several", () => {
      const out = ["example.com IN A 104.20.23.154 -- link: eth0", "example.com IN A 104.20.23.155 -- link: eth0", ""].join("\n");
      expect(parse(out)).toBe("104.20.23.154");
    });

    it("skips CNAME line(s) and picks the final A record's address, not text from the CNAME target hostname", () => {
      const out = ["foo.example.com IN CNAME bar-104.example.net -- link: eth0", "bar-104.example.net IN A 93.184.216.34 -- link: eth0", ""].join("\n");
      expect(parse(out)).toBe("93.184.216.34");
    });

    it("does not mistake digits inside the owner hostname for the address", () => {
      expect(parse("s3.example.com IN A 1.2.3.4 -- link: eth0\n")).toBe("1.2.3.4");
    });

    it("produces nothing on empty/error output", () => {
      expect(parse("")).toBe("");
    });
  });

  // 2026-10-03 Fable re-review of #46, BLOCKER (reproduced: with the v6
  // REJECT rule deleted, `--check` as non-root with a PATH lacking
  // /usr/sbin printed the ip6tables-missing WARN, then PASS, exit 0). The
  // guard now only applies inside the root branch; non-root must always
  // reach the behavioral fallback regardless of whether ip6tables happens
  // to be on PATH.
  describe("check_ipv6_blocked's root-vs-non-root branch (ip6tables guard placement)", () => {
    function run({ uid, ip6tablesOnPath, ruleFound, behavioralRc = 0 }) {
      const script = `
UID_N=1001
BENCH_USER=bench
id() { echo ${uid}; }
command() {
  if [ "\${1:-}" = "-v" ] && [ "\${2:-}" = "ip6tables" ]; then
    ${ip6tablesOnPath ? "return 0" : "return 1"}
  fi
  builtin command "$@"
}
ip6tables() { ${ruleFound ? "return 0" : "return 1"}; }
check_ipv6_loopback_behavioral() { echo "BEHAVIORAL_CALLED"; return ${behavioralRc}; }
check_ipv6_blocked() {
${CHECK_IPV6_BLOCKED}
}
check_ipv6_blocked
echo "RC:$?"
`;
      const r = runBash(script);
      expect(r.status).toBe(0);
      return r.stdout;
    }

    it("root, ip6tables missing from PATH: WARNs and passes (0) WITHOUT ever falling through to the behavioral check", () => {
      const out = run({ uid: 0, ip6tablesOnPath: false, ruleFound: true });
      expect(out).toContain("WARN");
      expect(out).not.toContain("BEHAVIORAL_CALLED");
      expect(out).toContain("RC:0");
    });

    it("root, ip6tables present, rule present: ok, RC 0", () => {
      const out = run({ uid: 0, ip6tablesOnPath: true, ruleFound: true });
      expect(out).toContain("ok:");
      expect(out).not.toContain("BEHAVIORAL_CALLED");
      expect(out).toContain("RC:0");
    });

    it("root, ip6tables present, rule absent: FAIL, RC 1", () => {
      const out = run({ uid: 0, ip6tablesOnPath: true, ruleFound: false });
      expect(out).toContain("FAIL");
      expect(out).not.toContain("BEHAVIORAL_CALLED");
      expect(out).toContain("RC:1");
    });

    it("non-root, ip6tables missing from PATH (the reproduced regression): reaches the behavioral fallback, never WARNs/PASSes on its own", () => {
      const out = run({ uid: 1001, ip6tablesOnPath: false, ruleFound: true, behavioralRc: 1 });
      expect(out).toContain("BEHAVIORAL_CALLED");
      expect(out).not.toContain("WARN");
      expect(out).toContain("RC:1");
    });

    it("non-root, ip6tables present on PATH too: still reaches the behavioral fallback (root-ness gates the branch, not tool availability)", () => {
      const out = run({ uid: 1001, ip6tablesOnPath: true, ruleFound: true, behavioralRc: 0 });
      expect(out).toContain("BEHAVIORAL_CALLED");
      expect(out).toContain("RC:0");
    });
  });
});
