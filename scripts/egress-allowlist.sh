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
# Verify without touching firewall rules (as any user; runs the actual probe
# AS the bench user via sudo -u, same direction the sandbox canary checks):
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
#
# See src/runner/sandbox.mjs DEFAULT_EGRESS_BLOCKED_HOSTS for the exact hosts
# the per-run canary independently checks are blocked (kept in sync below).

set -euo pipefail

CHAIN="BENCH_EGRESS"
BENCH_USER=""
ALLOW=()
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
  --check             do not touch firewall rules; report whether
                       github.com/raw.githubusercontent.com/pypi.org are
                       blocked and every --allow host is reachable, probed AS
                       the bench user (sudo -u) — does not require root
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

[ -n "$BENCH_USER" ] || usage
id -u "$BENCH_USER" >/dev/null 2>&1 || {
  echo "egress-allowlist.sh: no such user: $BENCH_USER" >&2
  exit 1
}
UID_N="$(id -u "$BENCH_USER")"

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

# TCP-connect probe with no dependencies beyond bash's /dev/tcp — `:` (a
# no-op builtin) as the command means we never try to read/write the socket,
# just open it, so a server that accepts but never speaks first (e.g. bare
# HTTPS without our ClientHello) can't hang the check.
tcp_reachable() {
  local host="$1" port="$2"
  timeout 5 bash -c ": < /dev/tcp/${host}/${port}" >/dev/null 2>&1
}

do_check() {
  echo "Checking egress as uid $UID_N ($BENCH_USER)..."
  local ok=0
  for h in "${DEFAULT_BLOCKED_HOSTS[@]}"; do
    if sudo -u "$BENCH_USER" bash -c "$(declare -f tcp_reachable); tcp_reachable '$h' 443"; then
      echo "  FAIL: $h:443 is REACHABLE (must be blocked)"
      ok=1
    else
      echo "  ok:   $h:443 blocked"
    fi
  done
  for hp in "${ALLOW[@]}"; do
    local host="${hp%:*}" port="${hp##*:}"
    if sudo -u "$BENCH_USER" bash -c "$(declare -f tcp_reachable); tcp_reachable '$host' '$port'"; then
      echo "  ok:   $hp reachable"
    else
      echo "  FAIL: $hp is NOT reachable (must be allowed)"
      ok=1
    fi
  done
  return "$ok"
}

if $CHECK; then
  if do_check; then
    echo "PASS"
    exit 0
  else
    echo "FAIL — see above"
    exit 1
  fi
fi

if [ "$(id -u)" != "0" ]; then
  echo "egress-allowlist.sh: must run as root to modify firewall rules (use --check to only verify, as any user)" >&2
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

for hp in "${ALLOW[@]}"; do
  host="${hp%:*}"
  port="${hp##*:}"
  ip="$(resolve_ip "$host")"
  if [ -z "$ip" ]; then
    echo "egress-allowlist.sh: could not resolve '$host' — skipping (fix DNS and re-run)" >&2
    continue
  fi
  # Pin host -> ip in /etc/hosts (update in place if already pinned and the
  # resolved address drifted; append otherwise).
  if grep -qE "^[0-9.]+[[:space:]]+${host}\$" /etc/hosts; then
    sed -i -E "s/^[0-9.]+([[:space:]]+${host})\$/${ip}\1/" /etc/hosts
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
