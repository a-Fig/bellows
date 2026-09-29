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
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const SCRIPT_PATH = new URL("../egress-allowlist.sh", import.meta.url);
// Normalized to LF: this file is checked out with CRLF line endings on this
// Windows dev machine. \r turned out NOT to be the cause of the blocker-2
// crash investigated below (see runBash's comment for the actual cause and
// how it was isolated) -- bash tolerates embedded \r in a script body just
// fine. Left in anyway as cheap, harmless insurance against some other bash
// or awk implementation someday caring, since there is no reason for the
// extracted pipeline text to carry Windows line endings regardless.
const scriptText = fs.readFileSync(SCRIPT_PATH, "utf8").replace(/\r\n/g, "\n");

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

// check_loopback_listeners()'s `ss -ltnpe | awk '...'` classifier — extracted
// from between `\n  done < <(awk '` (2-space indent: the function ALSO
// contains a second, unrelated `done < <(awk '...')` at 4-space indent, for
// the /proc/net/tcp inode-uid map build below — the indent-sensitive marker
// disambiguates the two) and `' <<<"$ss_out")`. Emits a THIRD field, the
// listening socket's inode (2026-10-04 Fable re-review of #46, blocker 2,
// round 2 — NOT a uid: token; see CHECK_LOOPBACK_LISTENERS's own comment
// below for why).
const LOOPBACK_AWK = extractBetween('\n  done < <(awk \'', '\' <<<"$ss_out")', "check_loopback_listeners ss classifier awk");

// check_loopback_listeners() in full, including the systemd-resolve
// owner-uid gate for the 127.0.0.53:53/127.0.0.54:53 stub addresses —
// extracted from the function's opening brace to its own closing brace
// (2026-10-04 Fable re-review of #46, blocker 2: address:port alone used to
// be enough to auto-allow those two addresses, so a rogue listener bound to
// the same address — root-owned or otherwise — passed unflagged too).
const CHECK_LOOPBACK_LISTENERS = extractBetween("check_loopback_listeners() {", "\n}", "check_loopback_listeners (full function, stub owner-uid gate)");

// check_ipv6_loopback_behavioral() in full — extracted from the function's
// opening brace to its own closing brace (2026-10-04 Fable re-review of #46,
// cheap note: a [::1] bind failure alone only proves loopback v6 is gone,
// not that IPv6 is blocked system-wide, if a global-scope v6 address exists
// on some other interface).
const CHECK_IPV6_LOOPBACK_BEHAVIORAL = extractBetween("check_ipv6_loopback_behavioral() {", "\n}", "check_ipv6_loopback_behavioral (full function, global-v6-address gate)");

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

// check_loopback_listeners()'s `ss`-not-found guard — extracted from the
// function's opening brace to just before `local ss_out` (2026-10-03
// coordinator review, pre-Fable: a skipped listener audit lets a loopback
// proxy on 127.0.0.1 pass undetected, so missing `ss` must FAIL by default;
// --skip-listener-audit is the explicit, loud escape hatch).
const LISTENER_AUDIT_GUARD = extractBetween("check_loopback_listeners() {", "\n  local ss_out", "check_loopback_listeners ss-missing guard");

function runBash(cmd, input) {
  // Written to a temp file and run as `bash <file>`, NOT passed inline as
  // `bash -c <string>` (2026-10-04 Fable re-review of #46, blocker 2, round
  // 2 -- reproduced directly, on this Windows dev machine): a large,
  // quote-and-heredoc-heavy multi-line command (the new whole-function
  // CHECK_LOOPBACK_LISTENERS extraction this round is the first pipeline
  // test big enough to hit it) reliably broke with a bogus "unexpected EOF
  // while looking for matching `'`" when passed via spawnSync("bash", ["-c",
  // cmd]) -- Node's spawnSync on Windows has to flatten the argv array back
  // into a single CreateProcess command-line string using Windows' own
  // quoting rules, and MSYS2 bash.exe re-parses that string back into argv
  // using its own, different rules; the two disagree for some inputs and
  // silently corrupt the content in transit. The exact same string, run via
  // `bash -n` on a file, or typed into an interactive shell, or run here as
  // `bash <tempfile>` (argv is then just a short file path, never the
  // script body itself), parses correctly every time. \r\n vs \n line
  // endings were investigated first and ruled out: normalizing them changed
  // nothing.
  const tmpFile = path.join(os.tmpdir(), `egress-allowlist-pipelines-test-${process.pid}-${runBashCounter++}.sh`);
  fs.writeFileSync(tmpFile, cmd);
  try {
    const r = spawnSync("bash", [tmpFile], { input, encoding: "utf8" });
    if (r.error) throw r.error;
    return r;
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // best-effort cleanup only
    }
  }
}
let runBashCounter = 0;

describe.skipIf(!HAS_BASH)("egress-allowlist.sh shell pipelines (extracted from the real script)", () => {
  describe("check_loopback_listeners' ss -ltnpe classifier awk", () => {
    // Realistic `ss -ltnpe` output: `-e` appends ino:/sk: tokens after the
    // `Process` column. The classifier's third field is the socket INODE,
    // not a uid (2026-10-04 Fable re-review of #46, blocker 2, round 2 —
    // the re-review's suggested `uid:NNN` token was reproduced directly
    // against a throwaway stock ubuntu:24.04 container's real iproute2 and
    // never appeared at all, for any socket, root's own included; `ino:`
    // does reliably appear regardless of privilege, so the caller joins it
    // against /proc/net/tcp[6]'s own uid column instead — see
    // check_loopback_listeners' header comment in the real script). No
    // SAMPLE line below carries a `uid:` token at all, deliberately, since
    // production ss never sends one either.
    const SAMPLE = [
      "State  Recv-Q Send-Q Local Address:Port  Peer Address:Port  Process",
      'LISTEN 0      128    127.0.0.1:8080     0.0.0.0:*      users:(("proxy",pid=1234,fd=3)) ino:100001 sk:0001',
      'LISTEN 0      128    0.0.0.0:22         0.0.0.0:*      users:(("sshd",pid=1,fd=3)) ino:100002 sk:0002',
      'LISTEN 0      128    [::]:22            [::]:*         users:(("sshd",pid=1,fd=4)) ino:100003 sk:0003',
      'LISTEN 0      128    [::ffff:127.0.0.1]:9000 [::]:*    users:(("java",pid=5555,fd=6)) ino:100004 sk:0004',
      'LISTEN 0      128    10.0.0.5:443       0.0.0.0:*      users:(("nginx",pid=99,fd=3)) ino:100005 sk:0005',
      'LISTEN 0      128    127.0.0.53:53      0.0.0.0:*      users:(("systemd-resolve",pid=2,fd=3)) ino:100006 sk:0006',
      // Literal "*:PORT" form (2026-10-01 Fable re-review of #45, cheap
      // note: "document and test the *:PORT form") — some ss/util-linux
      // versions print a bare "*" for an IPv4 wildcard bind instead of
      // "0.0.0.0", already matched by the classifier's `host == "*"` arm.
      'LISTEN 0      128    *:8005             *:*            users:(("legacytool",pid=77,fd=3)) ino:100007 sk:0007',
      // Literal ::1 (NOT the "::" wildcard below) deliberately excluded from
      // the SAMPLE's expectations, not from the SAMPLE itself: kept here so
      // the "excludes ::1" test right below can assert on the exact same
      // fixture the "flags everything else" test uses.
      'LISTEN 0      128    [::1]:9999         [::]:*         users:(("localtool",pid=42,fd=3)) ino:100008 sk:0008',
      // No ino: token at all — a genuinely malformed/unexpected ss line.
      // The classifier must still emit a (empty) third field rather than
      // drop the line, so the caller's inode lookup fails closed on it.
      'LISTEN 0      128    127.0.0.1:9100     0.0.0.0:*      users:(("mystery",pid=88,fd=3))',
      "",
    ].join("\n");

    it("flags every loopback/wildcard/dual-stack form, excludes a real LAN address, and reconstructs bracketed IPv6 host:port with its socket inode", () => {
      const r = runBash(`awk '${LOOPBACK_AWK}'`, SAMPLE);
      expect(r.status).toBe(0);
      // NOT .trim()'d before splitting: the last data line's trailing empty
      // inode field ("...|88|") is significant, and a blanket .trim() on
      // the whole blob would strip that trailing delimiter along with the
      // real trailing newline, silently corrupting the very assertion this
      // test exists to make. Split first, then drop only the truly-empty
      // lines (blank lines contain no "|" at all, so no real assertion data
      // is lost by filtering on length).
      //
      // Fields are "|"-delimited, not tab-delimited (2026-10-04 Fable
      // re-review of #46, blocker 2, round 2): reproduced directly that
      // bash's `IFS=$'\t' read` COLLAPSES a run of IFS-whitespace
      // characters — including an empty field sitting between two tabs —
      // no matter what IFS is set to, which silently misaligned an empty
      // pid field against the inode field downstream. "|" never appears in
      // any of hp/pid/ino and does not collapse.
      const lines = r.stdout
        .split("\n")
        .filter((l) => l.length > 0)
        .sort();
      expect(lines).toEqual(
        [
          "0.0.0.0:22|1|100002",
          "127.0.0.1:8080|1234|100001",
          "127.0.0.53:53|2|100006",
          "[::]:22|1|100003",
          "[::ffff:127.0.0.1]:9000|5555|100004",
          "*:8005|77|100007",
          "127.0.0.1:9100|88|",
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
        'LISTEN 0 128 10.0.0.5:443 0.0.0.0:* users:(("nginx",pid=99,fd=3)) ino:1 sk:1',
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
  //
  // 2026-10-04 Fable re-review of #46, blocker 1: root's own crontab PATH is
  // ALSO /usr/bin:/bin by default (the same gap, hitting the root branch
  // this time) — root must try /usr/sbin/ip6tables and /sbin/ip6tables
  // explicitly before giving up, and if ip6tables truly cannot be found
  // anywhere, root must fall through to the behavioral [::1] check instead
  // of WARNing and silently PASSing. The test below only mocks `command -v
  // ip6tables`, not the `[ -x /usr/sbin/ip6tables ]`/`[ -x /sbin/ip6tables ]`
  // absolute-path checks themselves (mocking `[`/`test` is impractical) —
  // it relies on neither path actually existing on the box running these
  // tests, which holds for a plain dev/CI machine without iptables
  // installed at those exact paths. The real "found via an absolute path"
  // branch is exercised separately, in the container (root's ip6tables
  // shadowed off PATH but still present under /usr/sbin).
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

    it("root, ip6tables missing from PATH/usr/sbin/sbin: WARNs, then falls through to the behavioral check, and FAILs when the behavioral check does not confirm blocked (never a silent PASS)", () => {
      const out = run({ uid: 0, ip6tablesOnPath: false, ruleFound: true, behavioralRc: 1 });
      expect(out).toContain("WARN");
      expect(out).toContain("BEHAVIORAL_CALLED");
      expect(out).toContain("RC:1");
    });

    it("root, ip6tables missing from PATH/usr/sbin/sbin: WARNs, falls through to the behavioral check, and can still ok/PASS if the behavioral check itself confirms blocked", () => {
      const out = run({ uid: 0, ip6tablesOnPath: false, ruleFound: true, behavioralRc: 0 });
      expect(out).toContain("WARN");
      expect(out).toContain("BEHAVIORAL_CALLED");
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

  // 2026-10-03 coordinator review, pre-Fable: check_loopback_listeners used
  // to degrade to a WARN (return 0) when `ss` wasn't found — a skipped
  // listener audit is exactly the bypass this check exists to catch (a
  // loopback proxy on 127.0.0.1 would pass unnoticed). `ss` ships in
  // iproute2 on every stock Ubuntu, so the FAIL below never fires on a
  // normal box; --skip-listener-audit is the explicit, loud opt-out.
  describe("check_loopback_listeners' ss-missing guard defaults to FAIL, not WARN", () => {
    function run(skipListenerAudit) {
      const script = `
SKIP_LISTENER_AUDIT=${skipListenerAudit ? "true" : "false"}
command() {
  if [ "\${1:-}" = "-v" ] && [ "\${2:-}" = "ss" ]; then
    return 1
  fi
  builtin command "$@"
}
check_loopback_listeners() {
${LISTENER_AUDIT_GUARD}
  :
}
check_loopback_listeners
echo "RC:$?"
`;
      const r = runBash(script);
      expect(r.status).toBe(0);
      return r.stdout;
    }

    it("FAILs by default when 'ss' is missing (no --skip-listener-audit)", () => {
      const out = run(false);
      expect(out).toContain("FAIL");
      expect(out).not.toContain("WARN");
      expect(out).toContain("RC:1");
    });

    it("WARNs loudly and passes (0) ONLY when --skip-listener-audit was explicitly passed", () => {
      const out = run(true);
      expect(out).toContain("WARN");
      expect(out).toContain("SKIPPING");
      expect(out).toContain("RC:0");
    });
  });

  // 2026-10-04 Fable re-review of #46, blocker 2 (reproduced: a root-owned
  // rogue listener bound to 127.0.0.53:53 PASSed the old address:port-only
  // stub auto-allow, and was reachable by the bench user). The stub
  // auto-allow for 127.0.0.53:53/127.0.0.54:53 is now gated on the listening
  // socket's owning uid — joined by socket inode against a synthetic
  // /proc/net/tcp fixture (via the $PROC_NET_TCP override; production code
  // defaults to the real /proc/net/tcp[6], see the real script) — matching
  // `id -u systemd-resolve`, never on address:port alone. The re-review's
  // suggested source, ss's own `uid:` token, is deliberately absent from
  // every ss fixture line below: reproduced directly against a throwaway
  // stock ubuntu:24.04 container, it never actually appears in real ss
  // output, root's own included (round 2 of this blocker's fix).
  describe("check_loopback_listeners' systemd-resolve stub auto-allow is gated on owning uid (via /proc/net/tcp inode join), not address:port alone", () => {
    // `procTcpRows`: array of [inode, uid] pairs, rendered into a synthetic
    // /proc/net/tcp-shaped fixture with the real file's exact column
    // layout ($8 = uid, $10 = inode — everything else is a fixed dummy
    // value the classifier never reads).
    function run({ ssLines, procTcpRows, systemdResolveUid, allowLoopback = [], uidN = 1001 }) {
      const ssOutput = ["State  Recv-Q Send-Q Local Address:Port  Peer Address:Port  Process", ...ssLines, ""].join("\n");
      const procTcpBody = [
        "  sl  local_address rem_address   st tx_queue:rx_queue tr:tm->when retrnsmt   uid  timeout inode",
        ...procTcpRows.map(
          ([inode, uid], i) =>
            `   ${i}: 00000000:0000 00000000:0000 0A 00000000:00000000 00:00000000 00000000 ${uid} 0 ${inode} 1 0000000000000000 100 0 0 10 0`,
        ),
        "",
      ].join("\n");
      const allowLoopbackDecl = `ALLOW_LOOPBACK=(${allowLoopback.map((s) => `"${s}"`).join(" ")})`;
      const script = `
UID_N=${uidN}
BENCH_USER=bench
${allowLoopbackDecl}
PROC_NET_TCP="$(mktemp)"
PROC_NET_TCP6=/nonexistent-proc-net-tcp6-for-this-test
trap 'rm -f "$PROC_NET_TCP"' EXIT
cat <<'PROCTCP' > "$PROC_NET_TCP"
${procTcpBody}
PROCTCP
command() {
  if [ "\${1:-}" = "-v" ] && [ "\${2:-}" = "ss" ]; then
    return 0
  fi
  builtin command "$@"
}
ss() { cat <<'SSOUT'
${ssOutput}
SSOUT
}
id() {
  if [ "\${1:-}" = "-u" ] && [ "\${2:-}" = "systemd-resolve" ]; then
    ${systemdResolveUid !== null ? `echo ${systemdResolveUid}; return 0` : "return 1"}
  fi
  return 1
}
check_loopback_listeners() {
${CHECK_LOOPBACK_LISTENERS}
}
check_loopback_listeners
echo "RC:$?"
`;
      const r = runBash(script);
      expect(r.status).toBe(0);
      // Stderr is folded into the returned string (not just r.stdout): the
      // crash-regression test below asserts `bad array subscript` is
      // absent, and that specific bash error goes to stderr, not stdout —
      // checking stdout alone would pass trivially regardless of whether
      // the crash actually occurred.
      return r.stdout + (r.stderr ? `\nSTDERR:${r.stderr}` : "");
    }

    it("a rogue ROOT-owned listener on 127.0.0.53:53 (uid mismatches systemd-resolve): FAILs, RC 1 — never passes by address alone", () => {
      const out = run({
        ssLines: ['LISTEN 0 128 127.0.0.53:53 0.0.0.0:* users:(("evil",pid=666,fd=3)) ino:501 sk:1'],
        procTcpRows: [[501, 0]],
        systemdResolveUid: 996,
      });
      expect(out).toContain("FAIL");
      expect(out).toContain("NOT owned by systemd-resolve");
      expect(out).toContain("RC:1");
    });

    it("the real systemd-resolve-owned stub listener on 127.0.0.53:53 (uid matches): auto-allowed, RC 0", () => {
      const out = run({
        ssLines: ['LISTEN 0 128 127.0.0.53:53 0.0.0.0:* users:(("systemd-resolve",pid=2,fd=3)) ino:502 sk:1'],
        procTcpRows: [[502, 996]],
        systemdResolveUid: 996,
      });
      expect(out).not.toContain("FAIL");
      expect(out).toContain("RC:0");
    });

    it("systemd-resolve's uid can't be determined at all: the stub address gets NO auto-allow and FAILs, even with a plausible uid", () => {
      const out = run({
        ssLines: ['LISTEN 0 128 127.0.0.53:53 0.0.0.0:* users:(("systemd-resolve",pid=2,fd=3)) ino:503 sk:1'],
        procTcpRows: [[503, 996]],
        systemdResolveUid: null,
      });
      expect(out).toContain("FAIL");
      expect(out).toContain("RC:1");
    });

    it("the listener's inode has no matching /proc/net/tcp row at all: uid can't be determined, stub address FAILs (fails closed at the inode-lookup layer too)", () => {
      const out = run({
        ssLines: ['LISTEN 0 128 127.0.0.53:53 0.0.0.0:* users:(("systemd-resolve",pid=2,fd=3)) ino:504 sk:1'],
        procTcpRows: [],
        systemdResolveUid: 996,
      });
      expect(out).toContain("FAIL");
      expect(out).toContain("uid unknown");
      expect(out).toContain("RC:1");
    });

    // Reproduced directly against a real container run (2026-10-04, this
    // fix's own verification pass): a loopback listener line with no ino:
    // token at all (ss omits it for some sockets in practice, not just the
    // synthetic "mystery" SAMPLE line in the classifier-awk tests above)
    // crashed the WHOLE script with "bad array subscript" — an empty $ino
    // used directly as `${INODE_UID[$ino]}`'s subscript is literally the
    // invalid `INODE_UID[]`, which bash treats as a fatal error, not an
    // empty lookup. Must degrade to "uid unknown" (fail closed), not crash.
    it("a loopback listener whose ss line has NO ino: token at all (not just a missing /proc/net/tcp row): fails closed, does not crash the script", () => {
      const out = run({
        ssLines: ['LISTEN 0 128 127.0.0.53:53 0.0.0.0:* users:(("mystery",pid=9,fd=3))'],
        procTcpRows: [[508, 996]],
        systemdResolveUid: 996,
      });
      expect(out).not.toContain("bad array subscript");
      expect(out).toContain("FAIL");
      expect(out).toContain("uid unknown");
      expect(out).toContain("RC:1");
    });

    it("a generic (non-stub) loopback listener owned by the bench uid itself: passes, RC 0", () => {
      const out = run({
        ssLines: ['LISTEN 0 128 127.0.0.1:9200 0.0.0.0:* users:(("benchtool",pid=42,fd=3)) ino:505 sk:1'],
        procTcpRows: [[505, 1001]],
        systemdResolveUid: 996,
        uidN: 1001,
      });
      expect(out).not.toContain("FAIL");
      expect(out).toContain("RC:0");
    });

    it("a generic (non-stub) loopback listener owned by neither the bench uid nor --allow-loopback'd: FAILs, RC 1", () => {
      const out = run({
        ssLines: ['LISTEN 0 128 127.0.0.1:9200 0.0.0.0:* users:(("othertool",pid=42,fd=3)) ino:506 sk:1'],
        procTcpRows: [[506, 5000]],
        systemdResolveUid: 996,
        uidN: 1001,
      });
      expect(out).toContain("FAIL");
      expect(out).toContain("RC:1");
    });

    it("a generic (non-stub) loopback listener explicitly --allow-loopback'd: passes regardless of uid, RC 0", () => {
      const out = run({
        ssLines: ['LISTEN 0 128 127.0.0.1:9200 0.0.0.0:* users:(("othertool",pid=42,fd=3)) ino:507 sk:1'],
        procTcpRows: [[507, 5000]],
        systemdResolveUid: 996,
        uidN: 1001,
        allowLoopback: ["127.0.0.1:9200"],
      });
      expect(out).not.toContain("FAIL");
      expect(out).toContain("RC:0");
    });
  });

  // 2026-10-04 Fable re-review of #46, cheap note (reproduced: a ULA/
  // global-scope IPv6 address configured on a non-loopback interface let a
  // [::1] bind failure falsely confirm "IPv6 is blocked" even though real
  // routable IPv6 egress still existed via that other interface). A [::1]
  // bind failure (EADDRNOTAVAIL/EAFNOSUPPORT/ENETUNREACH) now only counts as
  // confirmed-blocked when `ip -6 addr show scope global` is ALSO empty.
  describe("check_ipv6_loopback_behavioral's EADDRNOTAVAIL branch also requires no global-scope IPv6 address exists elsewhere", () => {
    function run({ ipAvailable, hasGlobalAddr }) {
      const script = `
BENCH_USER=bench
command() {
  if [ "\${1:-}" = "-v" ] && [ "\${2:-}" = "node" ]; then
    return 0
  fi
  if [ "\${1:-}" = "-v" ] && [ "\${2:-}" = "ip" ]; then
    ${ipAvailable ? "return 0" : "return 1"}
  fi
  builtin command "$@"
}
node() {
  # Mimics the real call's argv (-e '<script>' "$tmpfile") without touching
  # a real socket: write the bind-failure status straight to the tmpfile the
  # real function polls.
  local tmpfile="$3"
  printf '%s' "ERR:EADDRNOTAVAIL" > "$tmpfile"
}
ip() {
  ${hasGlobalAddr ? "printf '%s\\n' '3: eth0    inet6 fd12:3456::1/64 scope global'" : "true"}
}
probe_tcp() { echo "unreachable"; }
check_ipv6_loopback_behavioral() {
${CHECK_IPV6_LOOPBACK_BEHAVIORAL}
}
check_ipv6_loopback_behavioral
echo "RC:$?"
`;
      const r = runBash(script);
      expect(r.status).toBe(0);
      return r.stdout;
    }

    it("::1 bind fails, no global-scope IPv6 address anywhere: ok, RC 0 (genuinely confirmed blocked)", () => {
      const out = run({ ipAvailable: true, hasGlobalAddr: false });
      expect(out).toContain("ok:");
      expect(out).toContain("RC:0");
    });

    it("::1 bind fails, but a global-scope IPv6 address exists on another interface: FAIL, RC 1 (Fable's reproduced false-PASS scenario)", () => {
      const out = run({ ipAvailable: true, hasGlobalAddr: true });
      expect(out).toContain("FAIL");
      expect(out).toContain("RC:1");
    });

    it("::1 bind fails, and 'ip' itself is not available to check: FAIL, RC 1 (inconclusive, not confirmed)", () => {
      const out = run({ ipAvailable: false, hasGlobalAddr: false });
      expect(out).toContain("FAIL");
      expect(out).toContain("RC:1");
    });
  });
});
