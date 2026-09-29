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
#   - blocks ALL IPv6 egress for the bench user (ip6tables), since none of
#     the IPv4 rules above apply to it
#
# DNS still works for the bench user even though NOTHING else does: on a
# systemd-resolved host, the actual upstream DNS query is made by
# systemd-resolved itself — a DIFFERENT uid — over loopback (127.0.0.53),
# which this chain always accepts (`-o lo -j ACCEPT`). The bench user's own
# process just talks to systemd-resolved's stub over lo and never itself
# opens a socket to an upstream resolver.
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
#   - a LOOPBACK proxy (e.g. tailscaled's SOCKS5 listener, a local squid/mitm,
#     anything bound to 127.0.0.1/::1) is a bypass this script cannot see:
#     `-o lo -j ACCEPT` above allows ALL loopback traffic unconditionally (it
#     has to, for DNS — see below), so the bench user can reach any such
#     listener regardless of the allowlist. `--check` lists loopback TCP
#     listeners (via `ss -ltnp`) not attributable to the bench user itself and
#     FAILS unless each is explicitly accepted with `--allow-loopback
#     host:port` (2026-09-29 Fable re-review of #43, non-blocking note).
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

usage() {
  cat >&2 <<'EOF'
Usage:
  sudo egress-allowlist.sh --user <name> [--allow host:port]...
  egress-allowlist.sh --user <name> [--allow host:port]... --check

  --user <name>      the bench OS user whose egress is restricted (required)
  --allow host:port   a host:port that must stay reachable (repeatable) —
                       typically the model API and the Agent Trials platform
  --allow-loopback host:port
                       (--check only) a loopback (127.x/::1) TCP listener
                       that is expected/intentional (repeatable) — e.g. a
                       deliberate local proxy. Without this, --check FAILS on
                       any loopback listener it can't attribute to the bench
                       user itself, since loopback is always reachable
                       regardless of the allowlist (-o lo -j ACCEPT).
  --check             do not touch firewall rules; report whether
                       github.com/raw.githubusercontent.com/pypi.org are
                       blocked, every --allow host is reachable (probed AS
                       the bench user via sudo -u, or directly if you already
                       are that user), and no unexpected loopback listener
                       exists. Requires root, to already BE --user, or
                       passwordless sudo to --user — exits 2 (not a PASS) if
                       none of those can be confirmed, rather than silently
                       reporting everything as "blocked".

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
# blocked by the chain we're about to build).
resolve_ip() {
  # `|| true` on the left side of the pipe keeps a resolution failure (getent
  # exits non-zero for an unknown host) from tripping `set -e`/`pipefail` on
  # the caller's `ip="$(resolve_ip "$host")"` — the empty-result case is
  # handled explicitly by the caller instead.
  { getent ahostsv4 "$1" 2>/dev/null || true; } | awk '{print $1; exit}'
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

# Loopback TCP listeners are reachable by the bench user regardless of the
# allowlist below: `-o lo -j ACCEPT` has to allow ALL loopback traffic
# unconditionally (DNS to systemd-resolved's stub depends on it), so any
# other process listening on 127.x/::1/wildcard is a bypass invisible to
# every iptables rule this script installs (e.g. tailscaled's SOCKS5
# listener, a forgotten local squid/mitm). Enumerates LISTEN-state sockets
# via `ss -ltnp`, attributes each to a uid via its pid where the `Process`
# column is visible, and FAILS on anything not owned by the bench user
# itself and not explicitly accepted via --allow-loopback (systemd-resolved's
# own stub is pre-seeded into ALLOW_LOOPBACK above). A socket whose owner
# can't be determined (ss/ps couldn't attribute it — e.g. no permission to
# see another user's process) is treated the same as "not the bench user":
# fails closed, since the whole point is catching a listener the operator
# doesn't already know about (2026-09-29 Fable re-review of #43, non-blocking
# note). Degrades to a WARN (not a FAIL) if `ss` isn't installed at all,
# since this is a bonus check layered on top of the primary probes above,
# not itself the firewall verification.
check_loopback_listeners() {
  if ! command -v ss >/dev/null 2>&1; then
    echo "  WARN: 'ss' not found — cannot check for loopback listeners (a local proxy bound to 127.x/::1/wildcard would bypass the allowlist undetected)"
    return 0
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
  done < <(ss -ltnp 2>/dev/null | awk '
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
      is_loop = (host ~ /^127\./) || host == "::1" || host == "*" || host == "0.0.0.0" || host == "::"
      if (!is_loop) next
      pid = ""
      if (match($0, /pid=[0-9]+/)) pid = substr($0, RSTART + 4, RLENGTH - 4)
      printf "%s:%s\t%s\n", host, port, pid
    }
  ')
  return "$fail"
}

do_check() {
  require_sudo_to_bench_user || return 2
  echo "Checking egress as uid $UID_N ($BENCH_USER)..."
  local ok=0
  local result
  for h in "${DEFAULT_BLOCKED_HOSTS[@]}"; do
    result="$(probe_tcp "$h" 443)"
    case "$result" in
      refused | unreachable) echo "  ok:   $h:443 blocked ($result)" ;;
      open) echo "  FAIL: $h:443 is REACHABLE (must be blocked)"; ok=1 ;;
      timeout) echo "  FAIL: $h:443 timed out — inconclusive (a silent drop looks the same as a dead host; this is NOT confirmed as blocked)"; ok=1 ;;
      *) echo "  FAIL: $h:443 could not be probed (unexpected error — this is NOT confirmed as blocked)"; ok=1 ;;
    esac
  done
  for hp in "${ALLOW[@]}"; do
    local host="${hp%:*}" port="${hp##*:}"
    result="$(probe_tcp "$host" "$port")"
    if [ "$result" = "open" ]; then
      echo "  ok:   $hp reachable"
    else
      echo "  FAIL: $hp is NOT reachable ($result) — must be allowed"
      ok=1
    fi
  done
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
iptables -C OUTPUT -m owner --uid-owner "$UID_N" -j "$CHAIN" 2>/dev/null ||
  iptables -I OUTPUT 1 -m owner --uid-owner "$UID_N" -j "$CHAIN"
iptables -A "$CHAIN" -o lo -j ACCEPT
iptables -A "$CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

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
    sed -i -E "${hosts_line}s/^[0-9A-Fa-f:.]+/${ip}/" /etc/hosts
  else
    echo "$ip $host" >>/etc/hosts
  fi
  iptables -A "$CHAIN" -p tcp -d "$ip" --dport "$port" -j ACCEPT
  echo "allowed: $host ($ip):$port"
done

iptables -A "$CHAIN" -p tcp -j REJECT --reject-with tcp-reset
iptables -A "$CHAIN" -j REJECT
ip6tables -C OUTPUT -m owner --uid-owner "$UID_N" ! -o lo -j REJECT 2>/dev/null ||
  ip6tables -I OUTPUT 1 -m owner --uid-owner "$UID_N" ! -o lo -j REJECT

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
