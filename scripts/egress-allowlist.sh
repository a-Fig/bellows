#!/bin/bash
# scripts/egress-allowlist.sh — host-level egress allowlist for a bench host
# running Landlock-sandboxed trials (config/trial `sandbox: "landlock"`, see
# src/runner/sandbox.mjs). Run this ONCE as root on a bench host before any
# sandboxed trial (`sandboxEgress: "blocked"`, the default once landlock is
# on — see TUTORIAL.md "Verifying egress is blocked" / "Sealing a bench
# host"). Re-running is safe (idempotent).
#
# Why this exists: Landlock restricts the FILESYSTEM only. It cannot restrict
# the network, and bellows itself runs unprivileged so it cannot install
# firewall rules either. On 2026-09-28 a Landlock-sandboxed agent used the
# open internet mid-run to clone SlopCode's public repo (hidden tests +
# reference solutions) from GitHub, contaminating its own score. The
# sandboxEgress canary VERIFIES a host-level block is in place every run —
# this script IS that block. It generalizes the iptables allowlist that fixed
# the 2026-09-28 incident on the bench VM (owner-match on the bench user's
# uid; deny everything except loopback, established connections, and the
# host:port pairs you explicitly allow).
#
# Usage (as root):
#   sudo scripts/egress-allowlist.sh --user smash \
#     --allow api.deepseek.com:443 \
#     --allow your-agent-trials-instance.example.com:443
#
# Verify without touching firewall rules (runs the actual probe AS the bench
# user via sudo -u, same direction the sandbox canary checks — needs either
# root or passwordless sudo rights to --user; see "sudo -n -u ... true"
# below, which --check runs first and fails loudly on rather than silently
# reporting a false PASS):
#   scripts/egress-allowlist.sh --user smash \
#     --allow api.deepseek.com:443 --check
#
# What this does:
#   - creates/flushes an iptables chain (BENCH_EGRESS) hit only by traffic
#     from the bench user's uid (everyone else, incl. you running `git`/
#     `node bin/bellows.mjs report` as yourself, is unaffected)
#   - always allows loopback and already-established/related connections
#   - resolves each --allow host once and PINS it in /etc/hosts (CDN edge IPs
#     rotate — pinning keeps the allowlist valid across DNS changes, and
#     glibc's resolver checks /etc/hosts before DNS by default, so ordinary
#     hostname lookups from the bench user's processes land on the pinned IP)
#   - allows exactly that pinned IP on the given port, for every --allow entry
#   - rejects everything else over TCP (reset, not a silent drop, so a
#     benchmarked agent's HTTP client fails fast instead of hanging) and over
#     any other protocol
#   - blocks ALL IPv6 egress for the bench user (ip6tables) unconditionally,
#     including over ::1/loopback — nothing in this codebase binds a
#     loopback listener to anything but IPv4 127.0.0.1, so there's no
#     legitimate IPv6-loopback traffic to carve an exception out for
#     (tightened 2026-09-30 per Fable's #45 re-review: the old rule exempted
#     `-o lo`, which — combined with IPv4's own loopback exemption below —
#     left an IPv6 loopback listener reachable)
#
# DNS still works for the bench user even though NOTHING else does: on a
# systemd-resolved host, the actual upstream DNS query is made by
# systemd-resolved itself — a DIFFERENT uid — over loopback (127.0.0.53),
# which this chain always accepts (`-o lo -d 127.0.0.0/8 -j ACCEPT`). The
# bench user's own process just talks to systemd-resolved's stub over lo and
# never itself opens a socket to an upstream resolver.
#
# What this does NOT do (see TUTORIAL.md "Residual gaps"):
#   - it is not a firewall audit — --check only spot-checks the hosts you
#     give it (the exact ones the 2026-09-28 incident used, plus your
#     --allow list), not "is this box airtight"
#   - an --allow host on a shared CDN edge is reachable by anything else
#     fronting on that same edge IP (TLS SNI is inside the encrypted
#     handshake, invisible to iptables) — allowlisting by IP+port can't tell
#     those apart
#   - DNS resolution of arbitrary hostnames still works for the bench user
#     (UDP/TCP 53 to the stub resolver is not blocked) — only TCP connect to
#     an unlisted IP is blocked
#   - a LOOPBACK proxy bound to 127.0.0.0/8 (e.g. tailscaled's SOCKS5
#     listener if it happens to bind there, a local squid/mitm) is a bypass
#     this script cannot see by itself: `-o lo -d 127.0.0.0/8 -j ACCEPT`
#     above allows all TCP to 127.0.0.0/8 over loopback unconditionally (it
#     has to, for DNS — see below), so the bench user can reach any such
#     listener regardless of the allowlist. `--check` lists loopback TCP
#     listeners (via `ss -ltnp`, including dual-stack `::ffff:127.x.x.x`
#     listeners) not attributable to the bench user itself and FAILS unless
#     each is explicitly accepted with `--allow-loopback host:port`
#     (2026-09-29 Fable re-review of #43, non-blocking note; tightened
#     2026-09-30 per Fable's #45 re-review, blocking note 1 — the rule used
#     to be plain `-o lo -j ACCEPT` with no destination match, which is far
#     broader than "loopback": Linux routes a packet addressed to ANY of the
#     host's own configured addresses over `lo`, not just 127.0.0.0/8, so the
#     old rule also admitted traffic to the host's real eth0/Tailscale/
#     docker0 addresses — e.g. a tailscaled SOCKS5 proxy bound to its 100.x
#     address, or any proxy bound to the LAN IP, was reachable too, entirely
#     outside the allowlist. `-d 127.0.0.0/8` restricts the ACCEPT to true
#     loopback destinations only. A wildcard-bound listener (`0.0.0.0:PORT`,
#     or dual-stack `[::]:PORT`/`[::ffff:127.x]:PORT`) is, after this
#     tightening, reachable by the bench user ONLY via 127.0.0.0/8 — never
#     via the host's other addresses. IPv6 gets no equivalent carve-out: it's
#     rejected outright for the bench user, loopback included — see above.)
#   - rules do NOT survive a reboot. This script only calls iptables/
#     ip6tables directly and does not persist them (no iptables-persistent/
#     netfilter-persistent integration, no systemd unit). Re-run it after
#     every reboot, or wire that in yourself.
#   - assumes systemd-resolved is doing DNS for the bench user (see "DNS
#     still works" below) — on a host WITHOUT it, where /etc/resolv.conf
#     points straight at an external nameserver IP, the bench user's own
#     process makes that DNS query itself, as its own uid, over a real
#     socket rather than to a same-host stub over loopback. That query isn't
#     covered by any ACCEPT rule here (only --allow host:port pairs are
#     opened) and gets rejected like everything else: an --allow'd host
#     still resolves fine (its IP is pinned in /etc/hosts, checked before
#     DNS), but any OTHER hostname lookup fails outright at the resolver
#     step instead of connecting-then-being-blocked.
#   - re-applying to an already-configured host has a brief open window
#     (2026-10-01 Fable re-review of #45, cheap note — left as is, documented
#     rather than fixed): `iptables -N "$CHAIN" || iptables -F "$CHAIN"`
#     empties an EXISTING chain's rules first, and that chain is still linked
#     into OUTPUT from the previous run, so between the flush and the first
#     `-A "$CHAIN" ... REJECT` immediately after it, traffic from the bench
#     uid falls through the now-empty chain to OUTPUT's own default policy
#     (commonly ACCEPT) instead of being rejected. This window is a handful
#     of iptables calls wide (not interruptible by anything this script
#     itself does), unlike the old whole-loop-wide fail-open bug the
#     reordering above fixes — but it is not zero, so don't re-apply this
#     script on a host with a benchmark actively running as the bench user.
#
# See src/runner/sandbox.mjs DEFAULT_EGRESS_BLOCKED_HOSTS for the exact hosts
# the per-run canary independently checks are blocked (kept in sync below).

set -euo pipefail

CHAIN="BENCH_EGRESS"
BENCH_USER=""
ALLOW=()
ALLOW_LOOPBACK=()
CHECK=false

# Mirrors DEFAULT_EGRESS_BLOCKED_HOSTS in src/runner/sandbox.mjs — the exact
# hosts a contaminated benchmark used on 2026-09-28. Kept in sync by hand;
# both lists exist to fail loudly if either the host-level block (here) or
# the per-run canary (sandbox.mjs) regresses.
DEFAULT_BLOCKED_HOSTS=(github.com raw.githubusercontent.com pypi.org)

# DNS-independent deny probes (2026-09-30 Fable re-review of #45, blocking
# note 2) — literal IPs, never resolved via getent/DNS at all, so --check
# still catches an open egress even if hostname resolution itself were
# somehow neutralized. See do_check(). IPv6 literal (2606:4700:4700::1111,
# Cloudflare's other public resolver) added 2026-10-01 (Fable re-review of
# #45, blocking note 1) alongside check_ipv6_blocked() below, as a
# behavioral (probe-based) signal to pair with that function's structural
# one — bracketed here for human readability and unambiguous host:port
# splitting on the LAST colon (`${hp%:*}`/`${hp##*:}` below), stripped
# before probe_tcp is called since /dev/tcp/HOST/PORT does not use bracket
# notation.
LITERAL_BLOCKED_PROBES=("1.1.1.1:443" "8.8.8.8:53" "140.82.112.3:443" "[2606:4700:4700::1111]:443")

usage() {
  cat >&2 <<'EOF'
Usage:
  sudo egress-allowlist.sh --user <name> [--allow host:port]...
  egress-allowlist.sh --user <name> [--allow host:port]... --check

  --user <name>      the bench OS user whose egress is restricted (required)
  --allow host:port   a host:port that must stay reachable (repeatable) —
                       typically the model API and the Agent Trials platform
  --allow-loopback host:port
                       (--check only) a loopback (127.0.0.0/8, or bracketed
                       IPv6 form for a dual-stack listener, e.g. "[::]:22" or
                       "[::ffff:127.0.0.1]:22") TCP listener that is
                       expected/intentional (repeatable) — e.g. a deliberate
                       local proxy, or stock sshd, which binds BOTH
                       "0.0.0.0:22" and "[::]:22" as two separate listeners
                       (pass both). An IPv4 wildcard bind may be reported as
                       either "0.0.0.0:PORT" or the literal "*:PORT" form
                       some ss/util-linux versions print instead — match
                       whichever form the FAIL line actually shows you.
                       Without this, --check FAILS on any
                       loopback listener it can't attribute to the bench user
                       itself, since 127.0.0.0/8 is always reachable
                       regardless of the allowlist (-o lo -d 127.0.0.0/8 -j
                       ACCEPT) — a wildcard listener is reachable only via
                       127.0.0.0/8, never via the host's other addresses (see
                       header comment). A listener bound to the literal IPv6
                       address "::1" (not the "[::]" wildcard above) is never
                       flagged at all: IPv6 is fully rejected for the bench
                       user regardless of --allow-loopback, so it is
                       unreachable by definition.
  --check             do not touch firewall rules; report whether
                       github.com/raw.githubusercontent.com/pypi.org (each
                       resolved HERE, as you the invoker, via DNS directly
                       (getent -s dns) — never by the bench user's own
                       possibly-hijacked resolution, and never by reading
                       back a stale /etc/hosts pin)
                       plus a few fixed literal IPs (1.1.1.1:443, 8.8.8.8:53,
                       140.82.112.3:443, and an IPv6 literal
                       [2606:4700:4700::1111]:443 — DNS-independent, so they
                       still catch an open egress even if hostname resolution
                       itself were somehow neutralized) are blocked, every
                       --allow host is reachable (probed AS the bench user
                       via sudo -u, or directly if you already are that
                       user), no unexpected loopback listener exists, and
                       (when run as root) that ip6tables actually has its
                       own OUTPUT REJECT rule for the bench uid — a
                       structural check, since the IPv6 literal probe above
                       alone can't tell "blocked by our rule" apart from "no
                       IPv6 route exists at all" (degrades to a WARN, not a
                       FAIL, when not root).
                       Requires root, to already BE --user, or passwordless
                       sudo to --user — exits 2 (not a PASS) if none of those
                       can be confirmed, rather than silently reporting
                       everything as "blocked".

Exit codes: 0 PASS, 1 a probe failed or was inconclusive (timeout/error —
never counted as blocked), 2 --check could not run anything as --user
(nothing was probed).
EOF
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --user)
      [ $# -ge 2 ] || usage
      BENCH_USER="$2"
      shift 2
      ;;
    --allow)
      [ $# -ge 2 ] || usage
      ALLOW+=("$2")
      shift 2
      ;;
    --allow-loopback)
      [ $# -ge 2 ] || usage
      ALLOW_LOOPBACK+=("$2")
      shift 2
      ;;
    --check)
      CHECK=true
      shift
      ;;
    -h | --help)
      usage
      ;;
    *)
      echo "egress-allowlist.sh: unknown argument: $1" >&2
      usage
      ;;
  esac
done

# systemd-resolved's stub resolver is a loopback listener BY DESIGN (see
# header comment) — always accepted so a normal host doesn't need
# --allow-loopback just to pass the check that the header itself describes as
# expected.
ALLOW_LOOPBACK+=("127.0.0.53:53")

[ -n "$BENCH_USER" ] || usage
id -u "$BENCH_USER" >/dev/null 2>&1 || {
  echo "egress-allowlist.sh: no such user: $BENCH_USER" >&2
  exit 1
}
UID_N="$(id -u "$BENCH_USER")"

# When the invoking user's own uid already IS the bench user's uid, every
# probe below can run directly — no sudo hop needed, and none of the
# sudo-specific error paths apply. This is what makes the script's own
# "Run this check as '$BENCH_USER' directly" suggestion (require_sudo_to_bench_user,
# probe_tcp below) actually true instead of a stale claim that never worked.
SELF_IS_BENCH_USER=false
if [ "$(id -u)" = "$UID_N" ]; then
  SELF_IS_BENCH_USER=true
fi

# Refuse --user root outright: uid 0 would put ROOT's own outbound
# connections behind this chain (every rule below is `-m owner --uid-owner
# $UID_N`), which could lock the box's own management/package-update traffic
# out from under whoever provisions it. The bench user this script is for is
# always the unprivileged account pi/bellows run as, never root.
if [ "$UID_N" = "0" ]; then
  echo "egress-allowlist.sh: refusing --user $BENCH_USER (uid 0) — this would restrict root's own outbound connections, not just the benchmarked agent's. Pick the unprivileged account bellows/pi actually runs as." >&2
  exit 1
fi

# Resolve one hostname to a single IPv4 address via the system resolver
# (getent — independent of any allowlist already in place; this call itself
# runs as whoever invoked the script, not the bench user, so it is never
# blocked by the chain we're about to build). Reused by do_check() below to
# resolve DEFAULT_BLOCKED_HOSTS too (2026-09-30 Fable re-review of #45,
# blocking note 2): the deny probes used to resolve those hostnames as the
# BENCH USER, inside its own (possibly hijacked) resolution path — a
# /etc/hosts entry or DNS sinkhole, combined with the firewall rules
# themselves simply being absent after a reboot (see "rules do NOT survive a
# reboot" above), could make github.com resolve somewhere that "refuses" the
# connection for a reason that has nothing to do with this script, and
# --check would misreport that as a confirmed block. Resolving here instead —
# as the invoker, the exact same way an --allow host is resolved for pinning
# — means the check probes the REAL address, never one the thing under test
# could have poisoned.
resolve_ip() {
  # `-s dns` (2026-10-01 Fable re-review of #45, blocking note 2): forces
  # getent to use ONLY the `dns` NSS service for this lookup, never `files`
  # (i.e. /etc/hosts). Plain `getent ahostsv4` follows nsswitch.conf's
  # configured order, which on essentially every distro checks `files`
  # BEFORE `dns` — and this same function's caller in the apply path PINS its
  # result into /etc/hosts. Without `-s dns`, a re-run's resolve_ip call for
  # an already-pinned host reads back the STALE pinned IP from /etc/hosts
  # instead of querying DNS at all, so the pin perpetuates itself forever:
  # TUTORIAL.md's "re-run to refresh a rotated CDN IP" was false, since the
  # very re-run meant to pick up the new IP would just re-confirm the old
  # one. Verified live (Fable's container repro) that `-s dns` bypasses the
  # pin and returns the real current answer. `|| true` on the left side of
  # the pipe keeps a resolution failure (getent exits non-zero for an unknown
  # host, or when the `dns` service isn't configured in nsswitch.conf at all)
  # from tripping `set -e`/`pipefail` on the caller's `ip="$(resolve_ip
  # "$host")"` — the empty-result case is handled explicitly by the caller
  # instead.
  { getent -s dns ahostsv4 "$1" 2>/dev/null || true; } | awk '{print $1; exit}'
}

# Mirrors isUnsafeEgressProbeTarget in src/runner/sandbox.mjs (the IPv4-only
# slice of it — resolve_ip only ever returns an IPv4 dotted-quad, via `getent
# ahostsv4`). Used by do_check() below to reject a DEFAULT_BLOCKED_HOSTS
# resolution that lands on loopback/unspecified/link-local: if a "must be
# blocked" hostname resolves to one of these, probing that address would
# "confirm" a block by finding nothing listening there, proving nothing about
# whether the real host is actually reachable (2026-09-30 Fable re-review of
# #45, blocking note 2). NOT applied to --allow host resolution in the apply
# path below — an operator pointing --allow at a loopback address (a local
# model proxy, say) is a legitimate, intentional target, mirroring
# sandbox.mjs's buildEgressProbes, which only gates its own equivalent check
# on `expect === "deny"`.
is_unsafe_probe_ip() {
  case "$1" in
    127.*) return 0 ;;   # loopback (127.0.0.0/8)
    0.0.0.0) return 0 ;; # unspecified
    169.254.*) return 0 ;; # link-local (169.254.0.0/16)
    *) return 1 ;;
  esac
}

# --check must never report "blocked" just because it failed to even ASK the
# question. Every probe below runs as the bench user via `sudo -u`, so BEFORE
# trusting any of them, confirm sudo can actually run a command as that user
# non-interactively. Without this, a `--check` run by an operator with no
# sudo rights to $BENCH_USER (or one that would need a password, or a box
# with no `sudo` at all) gets a `sudo: ...` error on every probe indistinguishable
# from a real connection failure, and used to be reported as three
# "ok: ... blocked" lines and a PASS with nothing actually probed (2026-09-29
# Fable review, bellows #43 note 1).
require_sudo_to_bench_user() {
  if $SELF_IS_BENCH_USER; then
    return 0
  fi
  if ! command -v sudo >/dev/null 2>&1; then
    echo "egress-allowlist.sh: 'sudo' is not installed (or not on PATH) — --check cannot run probes as '$BENCH_USER' without it. Run this check as '$BENCH_USER' directly, or install sudo." >&2
    return 1
  fi
  # -n: never prompt for a password. If one would be required, this fails
  # immediately instead of hanging (or, worse, silently degrading a
  # non-interactive run's stdin into "no" and still failing fast — either
  # way we must not treat that as "blocked").
  local out
  if ! out="$(sudo -n -u "$BENCH_USER" true 2>&1)"; then
    echo "egress-allowlist.sh: cannot run a trivial command as '$BENCH_USER' via 'sudo -n -u $BENCH_USER true' (${out:-sudo gave no output}). This means the invoking user has no passwordless sudo rights to '$BENCH_USER' — every probe below would fail the exact same way a real firewall block does, which used to be misreported as PASS. Run --check as root, or as a user with passwordless sudo to '$BENCH_USER', and retry." >&2
    return 1
  fi
  return 0
}

# TCP-connect probe classifier, run AS the bench user via sudo -u so the
# result reflects exactly what a benchmarked agent's own process would see.
# `:` (a no-op builtin) as the /dev/tcp command means we never try to
# read/write the socket, just open it, so a server that accepts but never
# speaks first (e.g. bare HTTPS without our ClientHello) can't hang the
# check. Classifies into distinct outcomes instead of a bare pass/fail so a
# genuine "connection refused/reset" or "no route to host" (real signals
# that egress is blocked) can never be confused with "timed out" (the same
# symptom as a silently-dropped packet, an unreachable box, OR a sudo/DNS
# failure that never even reached the network) or any other error. Only
# "refused"/"unreachable" count as a confirmed block; everything else,
# including a plain timeout, is inconclusive and must not be reported as
# blocked.
#
# Prints exactly one word to stdout:
#   open         connection succeeded — the port IS reachable
#   refused      ECONNREFUSED (iptables REJECT --reject-with tcp-reset, or
#                nothing listening) — a confirmed block
#   unreachable  ENETUNREACH / EHOSTUNREACH — also a confirmed block
#   timeout      no response inside the 5s budget — inconclusive (a silent
#                DROP looks identical to a dead host or a routing problem)
#   error        anything else (unknown host, sudo denied, permission
#                error, ...) — inconclusive; NEVER treated as blocked
probe_tcp() {
  local host="$1" port="$2"
  local out rc
  # `&& rc=0 || rc=$?` (not a plain `out=$(...); rc=$?`) because under
  # `set -e` a bare failing assignment-from-command-substitution — which
  # EVERY blocked/refused/timed-out probe is, i.e. the common case — is a
  # plain statement, not part of a conditional, and would kill the whole
  # script right here instead of letting the caller classify the result.
  #
  # `env LC_ALL=C` forces the classification below (grep against bash's own
  # strerror-derived error text) onto the C locale regardless of the
  # invoking (or bench user's) environment — a localized "Connection
  # refused" would otherwise silently fail every `grep -qi` match and get
  # misclassified as inconclusive "error" instead of a confirmed block
  # (2026-09-29 Fable re-review of #43, non-blocking note).
  #
  # When the invoker already IS the bench user (SELF_IS_BENCH_USER), skip
  # the `sudo -n -u` hop entirely — it would otherwise still require sudo
  # rights even to run a command as yourself, defeating the "run this check
  # as $BENCH_USER directly, no sudo needed" path.
  if $SELF_IS_BENCH_USER; then
    out="$(env LC_ALL=C timeout 5 bash -c ": < /dev/tcp/${host}/${port}" 2>&1)" && rc=0 || rc=$?
  else
    out="$(sudo -n -u "$BENCH_USER" env LC_ALL=C timeout 5 bash -c ": < /dev/tcp/${host}/${port}" 2>&1)" && rc=0 || rc=$?
  fi
  if [ "$rc" -eq 0 ]; then
    echo open
  elif [ "$rc" -eq 124 ]; then
    echo timeout
  elif printf '%s' "$out" | grep -qi 'connection refused'; then
    echo refused
  elif printf '%s' "$out" | grep -qiE 'network is unreachable|no route to host'; then
    echo unreachable
  else
    echo "error"
  fi
}

# Loopback TCP listeners on 127.0.0.0/8 are reachable by the bench user
# regardless of the allowlist below: `-o lo -d 127.0.0.0/8 -j ACCEPT` has to
# allow all TCP there unconditionally (DNS to systemd-resolved's stub depends
# on it), so any other process listening on 127.x/wildcard/dual-stack
# ::ffff:127.x is a bypass invisible to every iptables rule this script
# installs (e.g. tailscaled's SOCKS5 listener, a forgotten local squid/mitm).
# Enumerates LISTEN-state sockets via `ss -ltnp`, attributes each to a uid
# via its pid where the `Process` column is visible, and FAILS on anything
# not owned by the bench user itself and not explicitly accepted via
# --allow-loopback (systemd-resolved's own stub is pre-seeded into
# ALLOW_LOOPBACK above). A socket whose owner can't be determined (ss/ps
# couldn't attribute it — e.g. no permission to see another user's process)
# is treated the same as "not the bench user": fails closed, since the whole
# point is catching a listener the operator doesn't already know about
# (2026-09-29 Fable re-review of #43, non-blocking note). Degrades to a WARN
# (not a FAIL) if `ss` isn't installed at all, since this is a bonus check
# layered on top of the primary probes above, not itself the firewall
# verification — but if `ss` IS installed and simply fails when run (wrong
# permissions in some restricted context, a broken /proc, ...), that's a
# check failure, not silently "no listeners found" (2026-09-30 Fable
# re-review of #45, cheap note).
check_loopback_listeners() {
  if ! command -v ss >/dev/null 2>&1; then
    echo "  WARN: 'ss' not found — cannot check for loopback listeners (a local proxy bound to 127.x/wildcard/::ffff:127.x would bypass the allowlist undetected)"
    return 0
  fi
  local ss_out ss_status
  if ! ss_out="$(ss -ltnp 2>/dev/null)"; then
    ss_status=$?
    echo "  FAIL: 'ss -ltnp' exited $ss_status — could not enumerate loopback listeners (NOT the same as zero listeners found; treating this as a check failure rather than a silent PASS)"
    return 1
  fi
  local fail=0 hp pid owner_uid allowed entry
  while IFS=$'\t' read -r hp pid; do
    [ -n "$hp" ] || continue
    allowed=false
    for entry in "${ALLOW_LOOPBACK[@]}"; do
      if [ "$entry" = "$hp" ]; then
        allowed=true
        break
      fi
    done
    if $allowed; then
      continue
    fi
    owner_uid=""
    if [ -n "$pid" ]; then
      # `|| true`: ps exits non-zero once the process is gone or unreadable
      # (permission denied on another user's /proc entry) — under
      # `pipefail`, that alone would make this bare assignment statement
      # fail and, under `set -e`, abort the WHOLE script instead of just
      # leaving owner_uid empty (treated as "unattributed" below).
      owner_uid="$(ps -o uid= -p "$pid" 2>/dev/null | tr -d '[:space:]')" || true
    fi
    if [ -n "$owner_uid" ] && [ "$owner_uid" = "$UID_N" ]; then
      continue
    fi
    echo "  FAIL: loopback listener $hp (pid ${pid:-unknown}, uid ${owner_uid:-unknown}) is not $BENCH_USER's own process and is not in --allow-loopback — reachable by $BENCH_USER regardless of the allowlist"
    fail=1
  done < <(awk '
    $1 != "LISTEN" { next }
    {
      la = $4
      if (la ~ /^\[/) {
        split(la, parts, "]:")
        host = substr(parts[1], 2)
        port = parts[2]
      } else {
        n = split(la, parts, ":")
        port = parts[n]
        host = parts[1]
        for (i = 2; i < n; i++) host = host ":" parts[i]
      }
      sub(/%.*/, "", host)
      # ::ffff:127.x.x.x (2026-09-30 Fable re-review of #45, blocking note
      # 1): a dual-stack listener bound explicitly to an IPv4-mapped address
      # is reachable via a plain IPv4 connect to 127.x — the old classifier
      # missed this form entirely, so such a listener passed unflagged.
      #
      # "*" and "0.0.0.0" here also cover the literal `*:PORT` form `ss`
      # prints for some wildcard-bound IPv4 listeners (equivalent to
      # "0.0.0.0:PORT") — already matched by `host == "*"` above; no
      # classifier change needed, just calling it out since it is easy to
      # misread as unhandled at a glance.
      #
      # host == "::1" deliberately dropped (2026-10-01 Fable re-review of
      # #45, cheap note): a listener bound to the LITERAL address ::1 (not
      # the "::" wildcard, which stays flagged below) is IPv6-loopback-only —
      # dual-stack IPv4-mapping only applies to a wildcard or an explicit
      # ::ffff:x.x.x.x bind, never to literal ::1 — so it does NOT accept an
      # IPv4 127.0.0.1 connection the way the old bug class (`-o lo -j
      # ACCEPT` with no destination match) made it. This is only true because
      # IPv6 is now unconditionally ip6tables-REJECTed for the bench uid
      # BEFORE any --allow processing (see the ip6tables block above
      # RESOLVE_FAILURES in the apply path) — flagging "::1" back as a loopback
      # listener would be the safer call if that ordering ever regresses, so
      # be careful touching either side of this without the other.
      is_loop = (host ~ /^127\./) || host == "*" || host == "0.0.0.0" || host == "::" || (host ~ /^::ffff:127\./)
      if (!is_loop) next
      pid = ""
      if (match($0, /pid=[0-9]+/)) pid = substr($0, RSTART + 4, RLENGTH - 4)
      # Reconstruct bracketed IPv6 notation ("[::]:22", not "::1:22" or a
      # bare "::22") for any host containing a colon, so the printed hp
      # matches the same bracketed host:port form --allow-loopback (and ss
      # itself, for IPv6) uses — an unbracketed IPv6 host:port is ambiguous
      # (where does the host end and the port begin, when the host itself
      # contains colons?) and could never be typed as a working
      # --allow-loopback value (2026-09-30 Fable re-review of #45, cheap
      # note).
      hp = (host ~ /:/) ? "[" host "]:" port : host ":" port
      printf "%s\t%s\n", hp, pid
    }
  ' <<<"$ss_out")
  return "$fail"
}

# Structural verification that IPv6 is actually rejected for the bench uid
# (2026-10-01 Fable re-review of #45, blocking note 1) — the LITERAL_BLOCKED_PROBES
# IPv6 entry above is only a behavioral signal, and ECONNREFUSED/unreachable
# to a probe is ambiguous: it cannot distinguish "our own ip6tables REJECT
# rule fired" from "nothing is listening/routable there at all" (a host with
# zero IPv6 connectivity would show the exact same "blocked" result whether
# or not the rule exists). When running as root — the only context that can
# read ip6tables' own rule set — inspect it directly instead:
# `ip6tables -C OUTPUT -m owner --uid-owner $UID_N -j REJECT` exits 0 iff
# that exact rule is present, which is the thing actually guaranteeing IPv6
# is blocked, independent of routing/connectivity. --check normally runs
# unprivileged (as the bench user, or via sudo -u — see
# require_sudo_to_bench_user), so this degrades to a WARN, not a FAIL, when
# not root: the literal-IPv6 probe is the only signal available in that
# case, with the weaker guarantee documented above — exactly why this
# function exists as a second, independent check for when it CAN run.
check_ipv6_blocked() {
  if ! command -v ip6tables >/dev/null 2>&1; then
    echo "  WARN: 'ip6tables' not found — cannot structurally verify IPv6 is blocked (relying on the literal IPv6 probe above only)"
    return 0
  fi
  if [ "$(id -u)" != "0" ]; then
    echo "  WARN: not root — cannot inspect ip6tables' own rule set to structurally verify IPv6 is blocked for $BENCH_USER (relying on the literal IPv6 probe above only, which can't tell 'blocked by our rule' apart from 'no IPv6 route exists at all')"
    return 0
  fi
  if ip6tables -C OUTPUT -m owner --uid-owner "$UID_N" -j REJECT 2>/dev/null; then
    echo "  ok:   ip6tables OUTPUT REJECT rule for uid $UID_N is present"
    return 0
  fi
  echo "  FAIL: no ip6tables OUTPUT REJECT rule for uid $UID_N — IPv6 egress is NOT blocked for $BENCH_USER (run this script in apply mode, not just --check, to install it)"
  return 1
}

do_check() {
  require_sudo_to_bench_user || return 2
  echo "Checking egress as uid $UID_N ($BENCH_USER)..."
  local ok=0
  local result ip host port
  # Resolve each default-blocked hostname HERE, as the invoker, via getent —
  # same as resolve_ip below is used for --allow pinning — and probe the
  # literal IP, never the hostname itself. The old version probed the
  # HOSTNAME as the bench user, meaning resolution happened inside the same
  # (possibly hijacked) environment under test: a /etc/hosts entry, a DNS
  # sinkhole, or simply this script's rules not having survived a reboot (see
  # "rules do NOT survive a reboot" above) could make github.com resolve
  # somewhere that "refuses" the connection for a reason unrelated to any
  # firewall rule, and that got reported as a confirmed block
  # (2026-09-30 Fable re-review of #45, blocking note 2).
  for h in "${DEFAULT_BLOCKED_HOSTS[@]}"; do
    ip="$(resolve_ip "$h")"
    if [ -z "$ip" ]; then
      echo "  FAIL: could not resolve '$h' as the invoker — inconclusive, this is NOT confirmed as blocked (fix DNS and retry)"
      ok=1
      continue
    fi
    if is_unsafe_probe_ip "$ip"; then
      echo "  FAIL: '$h' resolved (as the invoker) to $ip — loopback/unspecified/link-local. A /etc/hosts entry or DNS sinkhole may have hijacked it; probing that address would prove nothing about whether the real '$h' is reachable, so this is NOT confirmed as blocked"
      ok=1
      continue
    fi
    result="$(probe_tcp "$ip" 443)"
    case "$result" in
      refused | unreachable) echo "  ok:   $h ($ip):443 blocked ($result)" ;;
      open) echo "  FAIL: $h ($ip):443 is REACHABLE (must be blocked)"; ok=1 ;;
      timeout) echo "  FAIL: $h ($ip):443 timed out — inconclusive (a silent drop looks the same as a dead host; this is NOT confirmed as blocked)"; ok=1 ;;
      *) echo "  FAIL: $h ($ip):443 could not be probed (unexpected error — this is NOT confirmed as blocked)"; ok=1 ;;
    esac
  done
  # Fixed, DNS-independent deny probes (2026-09-30 Fable re-review of #45,
  # blocking note 2): literal IPs that don't depend on getent/DNS at all, so
  # they still catch "egress is open" even if every hostname-based probe
  # above were somehow neutralized by a resolver problem. Chosen as
  # well-known, stable services outside any org's control: Cloudflare's and
  # Google's public DNS resolvers, and one of GitHub's advertised web/API
  # IPs — the same kind of address the 2026-09-28 incident actually used.
  for hp in "${LITERAL_BLOCKED_PROBES[@]}"; do
    host="${hp%:*}"
    port="${hp##*:}"
    # Strip IPv6 brackets, if present (a plain IPv4 literal like "1.1.1.1" is
    # left untouched by both — # and % here strip a literal "[" prefix /
    # "]" suffix only if one is actually there). LITERAL_BLOCKED_PROBES
    # stores IPv6 entries bracketed (see its declaration) so the LAST-colon
    # split above unambiguously isolates the port; bash's /dev/tcp pseudo-
    # device, unlike URL syntax, does not accept bracket notation and needs
    # the raw address.
    host="${host#\[}"
    host="${host%\]}"
    result="$(probe_tcp "$host" "$port")"
    case "$result" in
      refused | unreachable) echo "  ok:   $hp blocked ($result)" ;;
      open) echo "  FAIL: $hp is REACHABLE (must be blocked)"; ok=1 ;;
      timeout) echo "  FAIL: $hp timed out — inconclusive (a silent drop looks the same as a dead host; this is NOT confirmed as blocked)"; ok=1 ;;
      *) echo "  FAIL: $hp could not be probed (unexpected error — this is NOT confirmed as blocked)"; ok=1 ;;
    esac
  done
  for hp in "${ALLOW[@]}"; do
    host="${hp%:*}"
    port="${hp##*:}"
    result="$(probe_tcp "$host" "$port")"
    if [ "$result" = "open" ]; then
      echo "  ok:   $hp reachable"
    else
      echo "  FAIL: $hp is NOT reachable ($result) — must be allowed"
      ok=1
    fi
  done
  check_ipv6_blocked || ok=1
  check_loopback_listeners || ok=1
  return "$ok"
}

if $CHECK; then
  # `do_check || rc=$?` (not `do_check; rc=$?`) for the same `set -e` reason
  # as probe_tcp above: do_check's own return code is USUALLY non-zero (any
  # FAIL, or the sudo-preflight's `return 2`), and a bare non-conditional
  # statement returning non-zero would exit the script immediately, before
  # `rc=$?` ever ran.
  rc=0
  do_check || rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "PASS"
    exit 0
  elif [ "$rc" -eq 2 ]; then
    # require_sudo_to_bench_user already printed why; nothing was probed.
    exit 2
  else
    echo "FAIL — see above"
    exit 1
  fi
fi

if [ "$(id -u)" != "0" ]; then
  echo "egress-allowlist.sh: must run as root to modify firewall rules (use --check instead to only verify — as root, as $BENCH_USER itself, or with passwordless sudo to $BENCH_USER; --check still exits 2, not a PASS, if none of those apply)" >&2
  exit 1
fi

# Idempotent: create the chain if missing, else flush it — either way we
# rebuild its rules from scratch below rather than accumulating duplicates
# across re-runs (e.g. re-running after adding a host or a CDN IP rotated).
iptables -N "$CHAIN" 2>/dev/null || iptables -F "$CHAIN"

# Fail closed (2026-09-30 Fable re-review of #45, cheap note): install the
# catch-all REJECT rules FIRST — right after the chain is created/flushed,
# and BEFORE it's linked into OUTPUT or any ACCEPT rule exists — then insert
# every ACCEPT rule below at the TOP of the chain (`-I "$CHAIN" 1`, never
# `-A`), so the REJECTs always stay last. A freshly flushed chain that
# matches NO rule at all implicitly RETURNs to the calling chain (OUTPUT) and
# falls through to ITS default policy — commonly ACCEPT — so the old
# ordering (REJECT appended LAST, after the chain was already linked into
# OUTPUT and being populated) had a window where a mid-loop iptables error
# (one failed call, a killed process, a lost SSH session) left the chain
# linked but incomplete, and failed OPEN rather than closed. With REJECT
# rules installed before the chain is even linked in, every state this loop
# can be interrupted in is "reject everything" or "reject everything except
# what's been explicitly inserted so far" — never open.
iptables -A "$CHAIN" -p tcp -j REJECT --reject-with tcp-reset
iptables -A "$CHAIN" -j REJECT

iptables -C OUTPUT -m owner --uid-owner "$UID_N" -j "$CHAIN" 2>/dev/null ||
  iptables -I OUTPUT 1 -m owner --uid-owner "$UID_N" -j "$CHAIN"

# `-d 127.0.0.0/8` (2026-09-30 Fable re-review of #45, blocking note 1): the
# old `-o lo -j ACCEPT` matched on OUTPUT interface alone, but Linux routes a
# packet addressed to ANY of the host's own configured addresses over `lo` —
# not just 127.0.0.0/8 — so that rule also admitted traffic to the host's
# real eth0/Tailscale/docker0 addresses (e.g. a tailscaled SOCKS5 proxy on
# its 100.x address, or anything bound to the LAN IP). Constraining the
# destination to 127.0.0.0/8 closes that. IPv6 gets no equivalent rule at
# all — see the unconditional ip6tables REJECT below; nothing in this
# codebase binds a loopback listener to anything but IPv4 127.0.0.1.
iptables -I "$CHAIN" 1 -o lo -d 127.0.0.0/8 -j ACCEPT
iptables -I "$CHAIN" 1 -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

# Unconditional (no `! -o lo` exception): reject ALL IPv6 for the bench user,
# loopback included (2026-09-30 Fable re-review of #45, blocking note 1) —
# nothing in this codebase binds a loopback listener to anything but IPv4
# 127.0.0.1, so there's no legitimate IPv6 loopback traffic this would break.
#
# Installed HERE — before the --allow loop below, not after it (2026-10-01
# Fable re-review of #45, blocking note 1) — because the loop can abort
# partway through under `set -e` (a malformed --allow entry, a killed
# process, a lost SSH session) exactly the same way the IPv4 chain could
# before the fail-closed reorder above. When the ip6tables REJECT lived after
# the loop, an abort meant the loop's iptables (v4) work was already applied
# but ip6tables was never reached at all: IPv6 was left fully open for the
# bench uid — verified live (Fable's Ubuntu 24.04 container repro: `--allow
# example.com` with no port aborts mid-loop, the v4 chain is closed, but
# `ip6tables -S OUTPUT` is empty and `::1:8005` is reachable). Moving this
# above the loop means every state the loop can be interrupted in already has
# IPv6 fully rejected, matching the IPv4 fail-closed guarantee above.
ip6tables -C OUTPUT -m owner --uid-owner "$UID_N" -j REJECT 2>/dev/null ||
  ip6tables -I OUTPUT 1 -m owner --uid-owner "$UID_N" -j REJECT

# Counts --allow hosts that failed to resolve so the script can exit non-zero
# below rather than silently succeeding with one or more hosts never
# allowlisted (2026-09-29 Fable re-review of #43, non-blocking note) — while
# still applying every host that DID resolve rather than aborting the whole
# run over one bad hostname.
RESOLVE_FAILURES=0

for hp in "${ALLOW[@]}"; do
  host="${hp%:*}"
  port="${hp##*:}"
  ip="$(resolve_ip "$host")"
  if [ -z "$ip" ]; then
    echo "egress-allowlist.sh: could not resolve '$host' — skipping (fix DNS and re-run)" >&2
    RESOLVE_FAILURES=$((RESOLVE_FAILURES + 1))
    continue
  fi
  # Pin host -> ip in /etc/hosts (update in place if already pinned and the
  # resolved address drifted; append otherwise). Found via awk's exact
  # whitespace-token comparison (not a regex against $host) so a literal "."
  # in the hostname can't match any character the way an unescaped ERE
  # would, and so the host is found even when it's not the sole/last token
  # on the line — e.g. other aliases sharing the address, or a trailing
  # `# comment` — cases the old `^...${host}$`-anchored match missed and
  # would append a second, ineffective line under (glibc's resolver uses the
  # FIRST matching /etc/hosts line, so an appended duplicate silently does
  # nothing) (2026-09-29 Fable re-review of #43, non-blocking note).
  hosts_line="$(awk -v h="$host" '{
    line = $0; sub(/#.*/, "", line); n = split(line, toks, /[ \t]+/)
    for (i = 2; i <= n; i++) if (toks[i] == h) { print NR; exit }
  }' /etc/hosts)"
  if [ -n "$hosts_line" ]; then
    # `^[[:space:]]*` before the address (2026-09-30 Fable re-review of #45,
    # cheap note): the old pattern `^[0-9A-Fa-f:.]+` anchored at column 1
    # silently no-ops (sed doesn't error when a substitution doesn't match)
    # on an indented /etc/hosts line, leaving the stale IP in place while
    # this script goes on to allowlist the NEW resolved address in iptables
    # — the pin and the firewall rule would then point at two different
    # IPs. Matching (and replacing away) any leading whitespace normalizes
    # the line regardless of how it was indented.
    sed -i -E "${hosts_line}s/^[[:space:]]*[0-9A-Fa-f:.]+/${ip}/" /etc/hosts
  else
    # Ensure a trailing newline exists before appending (2026-09-30 Fable
    # re-review of #45, cheap note): if /etc/hosts's last byte isn't itself
    # a newline, `echo ... >>/etc/hosts` would concatenate onto the END of
    # the previous line instead of starting a new one — silently corrupting
    # whatever that last line was AND leaving our pin unparseable as its own
    # entry. `tail -c1` reads just the final byte; an empty file has none, so
    # the `[ -s /etc/hosts ]` guard skips the check (and the `printf ''`
    # cleanly does nothing) rather than reading past an empty stream.
    if [ -s /etc/hosts ] && [ "$(tail -c1 /etc/hosts)" != "" ]; then
      printf '\n' >>/etc/hosts
    fi
    echo "$ip $host" >>/etc/hosts
  fi
  iptables -I "$CHAIN" 1 -p tcp -d "$ip" --dport "$port" -j ACCEPT
  echo "allowed: $host ($ip):$port"
done

echo "done. DNS still works for $BENCH_USER (systemd-resolved does the upstream lookup as its own uid, via lo)."
echo "Verify: $0 --user $BENCH_USER $(printf -- '--allow %s ' "${ALLOW[@]}")--check"

# Every host that DID resolve is now allowlisted and iptables was rebuilt
# above; but if any --allow host failed to resolve, exit non-zero rather
# than silently succeeding — the operator asked for that host to stay
# reachable and it isn't (2026-09-29 Fable re-review of #43, non-blocking
# note).
if [ "$RESOLVE_FAILURES" -gt 0 ]; then
  echo "egress-allowlist.sh: $RESOLVE_FAILURES --allow host(s) could not be resolved and were NOT allowlisted (see warnings above) — fix DNS and re-run" >&2
  exit 1
fi
