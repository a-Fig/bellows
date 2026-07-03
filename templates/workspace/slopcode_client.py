#!/usr/bin/env python3
"""
SlopCode benchmark client -- download once, run your benchmark.

Download (saves as slopcode_client.py):
  python platform_client.py get-client slopcode

Full agent loop:
  1. python slopcode_client.py join <room_id> <your_name>
  2. python slopcode_client.py list
  3. python slopcode_client.py start <problem>
        WARNING: starting a problem commits it to your score.
  4. python slopcode_client.py files [problem]
        (download static assets if the problem has any)
  5. ... implement the solution in your workspace ...
  6. python slopcode_client.py submit [problem] [metrics=<file.json>]
  7. python slopcode_client.py wait
        (blocks until graded; prints result)
  8. python slopcode_client.py advance [problem]
        (commits the grade and reveals next checkpoint spec, or marks problem complete)
  9. repeat steps 5-8 for each checkpoint
  10. python slopcode_client.py finalize confirm
        (lock in your run score; room will auto-reset in 5 min)

Other commands:
  python slopcode_client.py spec [problem] [checkpoint]    re-read a spec
  python slopcode_client.py result [problem]               check grade status
  python slopcode_client.py status                         run overview table
  python slopcode_client.py label <text>                   tag this run for A/B comparison

Exit codes for wait: 0=graded (even if unsolved), 1=error status, 2=timeout
"""
import base64
import gzip
import hashlib
import io
import json
import os
import re
import sys
import tarfile
import time
import urllib.error
import urllib.request

# --- injected by platform at download time ---
BASE = "__PLATFORM_BASE__"
KEY  = "__API_KEY__"
# --------------------------------------------

SESSION_FILE = ".slopcode_session.json"

# snapshot caps (mirrors G.2 + H)
SNAPSHOT_MAX_FILES      = 500
SNAPSHOT_MAX_RAW_BYTES  = 10 * 1024 * 1024   # 10 MiB uncompressed
SNAPSHOT_MAX_GZ_BYTES   = 1 * 1024 * 1024    # 1 MiB gzip result

# always-excluded names/patterns (any depth)
_EXCLUDE_NAMES = {
    ".venv", ".git", "__pycache__", ".evaluation_tests",
    ".scbench", ".pytest_cache", ".slopcode_session.json",
    "slopcode_client.py",
}
_EXCLUDE_EXTS = {".pyc"}

_session: dict = {}


# ---------------------------------------------------------------------------
# Session
# ---------------------------------------------------------------------------

def _load():
    global _session
    if os.path.exists(SESSION_FILE):
        try:
            with open(SESSION_FILE, encoding="utf-8") as f:
                _session = json.load(f)
        except (json.JSONDecodeError, OSError):
            print("Corrupt session file. Delete .slopcode_session.json and re-run join.")
            sys.exit(1)


def _save():
    with open(SESSION_FILE, "w", encoding="utf-8") as f:
        json.dump(_session, f, indent=2)


def _require_session():
    _load()
    if not _session.get("agent_id") or not _session.get("room_id"):
        print("No session. Run: python slopcode_client.py join <room_id> <name>")
        sys.exit(1)


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------

def _parse_http_error(e: urllib.error.HTTPError) -> dict:
    try:
        raw = e.read()
    except Exception as exc:
        return {"ok": False, "code": "HTTP_ERROR",
                "error": "HTTP %d (unreadable: %s)" % (e.code, exc)}
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        preview = (raw[:200].decode("utf-8", errors="replace")
                   if isinstance(raw, bytes) else str(raw)[:200])
        return {"ok": False, "code": "HTTP_ERROR",
                "error": "HTTP %d (non-JSON)" % e.code,
                "body_preview": preview}


def _get(path: str) -> dict:
    _require_session()
    aid  = _session["agent_id"]
    room = _session["room_id"]
    url  = "%s/rooms/%s%s?agent_id=%s" % (BASE, room, path, aid)
    req  = urllib.request.Request(url, headers={"X-API-Key": KEY})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return _parse_http_error(e)
    except urllib.error.URLError as e:
        return {"ok": False, "code": "NETWORK_ERROR", "error": str(e.reason)}


def _post(body: dict, timeout: int = 30) -> dict:
    _require_session()
    aid  = _session["agent_id"]
    room = _session["room_id"]
    payload = json.dumps({"agent_id": aid, **body}).encode()
    req = urllib.request.Request(
        "%s/rooms/%s/action" % (BASE, room),
        payload,
        {"Content-Type": "application/json", "X-API-Key": KEY},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return _parse_http_error(e)
    except urllib.error.URLError as e:
        return {"ok": False, "code": "NETWORK_ERROR", "error": str(e.reason)}


def _post_no_aid(path: str, body: dict) -> dict:
    payload = json.dumps(body).encode()
    req = urllib.request.Request(
        "%s%s" % (BASE, path),
        payload,
        {"Content-Type": "application/json", "X-API-Key": KEY},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return _parse_http_error(e)
    except urllib.error.URLError as e:
        return {"ok": False, "code": "NETWORK_ERROR", "error": str(e.reason)}


# ---------------------------------------------------------------------------
# requirements.txt pre-validation (mirrors G.3 exactly)
# ---------------------------------------------------------------------------

# Canonical regex copied verbatim from grader/safety.py (_PKG_LINE_RE).
# Any change here must be mirrored there (and vice-versa).
# Leading char is [A-Za-z0-9] per contract G.3 — digit-leading names (e.g. 4suite-xml) accepted.
PKG_LINE_RE = re.compile(
    r"^[A-Za-z0-9][A-Za-z0-9._-]*"
    r"(\[[A-Za-z0-9_.,-]+\])?"
    r"(\s*(?:[<>=!~^,]+\S+\s*)+)?"
    r"\s*(;.*)?$"
)


def _validate_requirements(text: str):
    """Return (ok, error_message). Mirrors G.3 policy exactly."""
    if len(text) > 65536:
        return False, "requirements.txt exceeds 65536 chars"
    effective = 0
    for raw_line in text.splitlines():
        line = raw_line.strip()
        # strip inline comment
        if "#" in line:
            line = line[:line.index("#")].strip()
        if not line:
            continue
        effective += 1
        if effective > 50:
            return False, "more than 50 effective requirement lines"
        # Canonical reject-rule order (grader/safety.py check_requirements_line)
        if line.startswith("-"):
            return False, "rejected line (option/flag): %r" % raw_line
        if "://" in line:
            return False, "rejected line (URL): %r" % raw_line
        # "@" present AND "/" at-or-after the "@"
        if re.search(r"@[^@]*/", line):
            return False, "rejected line (direct reference): %r" % raw_line
        # local/Windows paths: starts with . / ~ or matches ^[A-Za-z]:
        if re.match(r"^[./~]|^[A-Za-z]:", line):
            return False, "rejected line (local/Windows path): %r" % raw_line
        if not PKG_LINE_RE.match(line):
            return False, "rejected line (invalid specifier): %r" % raw_line
    return True, ""


# ---------------------------------------------------------------------------
# Snapshot packing
# ---------------------------------------------------------------------------

def _should_exclude(path_parts: list) -> bool:
    """True if ANY component of the relative path should be excluded."""
    for part in path_parts:
        if part in _EXCLUDE_NAMES:
            return True
        _, ext = os.path.splitext(part)
        if ext in _EXCLUDE_EXTS:
            return True
    return False


def _pack_workspace(root: str, asset_paths: list) -> bytes:
    """
    Pack workspace at `root` into a gzip tar.
    Excludes: .venv, .git, __pycache__, .evaluation_tests, .scbench,
              .pytest_cache, .slopcode_session.json, slopcode_client.py,
              *.pyc, and every static asset save_path in asset_paths.
    Pre-checks: file count, raw bytes, gzip bytes.
    Returns raw gzip tar bytes.
    """
    # Build asset exclusion set (POSIX paths as given in the manifest)
    asset_exclude = set()
    for ap in asset_paths:
        # normalise to use os.sep for comparison
        asset_exclude.add(ap.replace("/", os.sep).replace("\\", os.sep).strip(os.sep))

    collected = []  # list of (arcname, full_path)
    total_raw = 0
    for dirpath, dirnames, filenames in os.walk(root):
        # compute relative dir parts
        rel_dir = os.path.relpath(dirpath, root)
        if rel_dir == ".":
            rel_parts = []
        else:
            rel_parts = rel_dir.replace("\\", "/").split("/")

        # prune excluded dirs in-place
        dirnames[:] = [
            d for d in dirnames
            if not _should_exclude(rel_parts + [d])
            and (rel_dir + os.sep + d).lstrip("." + os.sep) not in asset_exclude
            and d not in asset_exclude
        ]

        for fname in filenames:
            rel_file_parts = rel_parts + [fname]
            if _should_exclude(rel_file_parts):
                continue
            # check asset paths
            rel_posix = "/".join(rel_file_parts)
            # top-level asset dirs: skip anything whose first path component matches
            top = rel_file_parts[0] if rel_file_parts else ""
            if top in asset_exclude:
                continue
            # full relative path match
            rel_native = os.path.join(*rel_file_parts) if len(rel_file_parts) > 1 else rel_file_parts[0]
            if rel_native in asset_exclude or rel_posix in asset_exclude:
                continue

            full = os.path.join(dirpath, fname)
            try:
                size = os.path.getsize(full)
            except OSError:
                continue
            total_raw += size
            collected.append((rel_posix, full, size))

    file_count = len(collected)
    if file_count > SNAPSHOT_MAX_FILES:
        _report_oversize_files(collected, "file count", file_count, SNAPSHOT_MAX_FILES)
        sys.exit(1)
    if total_raw > SNAPSHOT_MAX_RAW_BYTES:
        _report_oversize_files(collected, "raw bytes", total_raw, SNAPSHOT_MAX_RAW_BYTES)
        sys.exit(1)

    # Build the tar
    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode="wb", mtime=0) as gz:
        with tarfile.open(fileobj=gz, mode="w|") as tf:
            for arcname, full, size in collected:
                # Read the bytes once and size the header from them — sizing
                # from the earlier getsize() races with files still being
                # written (grown file -> silently truncated archive entry).
                try:
                    with open(full, "rb") as fh:
                        data = fh.read()
                except OSError:
                    continue
                info = tarfile.TarInfo(name=arcname)
                info.size = len(data)
                info.mode = 0o644
                info.mtime = 0
                tf.addfile(info, io.BytesIO(data))

    gz_bytes = buf.getvalue()
    if len(gz_bytes) > SNAPSHOT_MAX_GZ_BYTES:
        print("ERROR: gzip snapshot is %d bytes (cap is %d = 1 MiB)." % (len(gz_bytes), SNAPSHOT_MAX_GZ_BYTES))
        print("  Reduce workspace size, or check --dir points at the right directory.")
        _report_oversize_files(collected, "gzip-snapshot", len(gz_bytes), SNAPSHOT_MAX_GZ_BYTES)
        sys.exit(1)

    return gz_bytes


def _report_oversize_files(collected, cap_name, actual, limit):
    print("ERROR: %s is %s (cap is %s)." % (cap_name, _fmt_size(actual), _fmt_size(limit)))
    by_size = sorted(collected, key=lambda x: x[2], reverse=True)
    print("  Largest files in workspace:")
    for arcname, _full, size in by_size[:10]:
        print("    %s  (%s)" % (arcname, _fmt_size(size)))


def _fmt_size(n):
    if n >= 1024 * 1024:
        return "%.1f MiB" % (n / (1024 * 1024))
    if n >= 1024:
        return "%.1f KiB" % (n / 1024)
    return "%d B" % n


# ---------------------------------------------------------------------------
# SSE wait
# ---------------------------------------------------------------------------

def _sse_wait_grade(submission_id: str, problem: str, timeout_s: int = 600) -> int:
    """
    Block until submission_graded SSE fires for `submission_id`.
    Re-checks via `result` action before each (re)connection.
    Returns exit code: 0=graded, 1=error, 2=timeout.
    """
    _require_session()
    room = _session["room_id"]
    url  = "%s/rooms/%s/events" % (BASE, room)
    deadline = time.time() + timeout_s
    poll_interval = 10  # fallback poll when SSE not available

    def _check_result_now():
        """Check current result via action. Returns (done, exit_code) or (False, None)."""
        body = {"problem": problem}
        if submission_id:
            body["submission_id"] = submission_id
        r = _post({"command": "result", **body})
        data = r.get("data", r)
        status = data.get("status", "")
        if status == "graded":
            _print_grade_result(data, problem)
            return True, 0
        if status == "error":
            print("GRADE ERROR %s: %s" % (problem, data.get("failure_reason", "unknown")))
            return True, 1
        return False, None

    # Check state once before opening SSE
    done, code = _check_result_now()
    if done:
        return code

    print("Waiting for grade on %s (timeout %ds)..." % (problem, timeout_s), flush=True)

    while time.time() < deadline:
        try:
            req = urllib.request.Request(url, headers={"X-API-Key": KEY})
            remaining = deadline - time.time()
            if remaining <= 0:
                break
            with urllib.request.urlopen(req, timeout=min(30, remaining + 1)) as resp:
                for raw_line in resp:
                    if time.time() > deadline:
                        break
                    line = raw_line.decode("utf-8", errors="replace").strip()
                    if not line.startswith("data:"):
                        continue
                    try:
                        event = json.loads(line[5:].strip())
                    except json.JSONDecodeError:
                        continue

                    etype = event.get("type", "")
                    if etype == "ping":
                        continue

                    if etype == "submission_graded":
                        edata = event.get("data", {})
                        if submission_id and edata.get("submission_id") != submission_id:
                            continue
                        # fetch full result from state for counts/failures
                        done, code = _check_result_now()
                        if done:
                            return code
                        # if check didn't see it yet, fall through to poll

                    if etype == "game_over":
                        print("Run finalized (game_over received).")
                        return 0

        except (urllib.error.URLError, OSError):
            # SSE not available or timed out -- fall back to polling
            pass

        # Poll fallback
        done, code = _check_result_now()
        if done:
            return code

        wait = min(poll_interval, max(0, deadline - time.time()))
        if wait <= 0:
            break
        time.sleep(wait)

    print("TIMEOUT: no grade received within %ds." % timeout_s)
    return 2


# ---------------------------------------------------------------------------
# Grade result pretty-printer
# ---------------------------------------------------------------------------

def _print_grade_result(data: dict, problem: str = ""):
    """Print a readable ASCII grade summary from a last_graded or result dict."""
    checkpoint  = data.get("checkpoint", "?")
    status      = data.get("status", "?")
    solved      = data.get("solved", False)
    infra_fail  = data.get("infrastructure_failure", False)
    fail_reason = data.get("failure_reason")
    counts      = data.get("counts", {})
    failures    = data.get("failures", [])

    # one-line verdict
    total_strict  = sum(v.get("total",  0) for v in counts.values())
    passed_strict = sum(v.get("passed", 0) for v in counts.values())
    core_total    = counts.get("Core", {}).get("total",  0)
    core_passed   = counts.get("Core", {}).get("passed", 0)

    solved_str = "SOLVED" if solved else "NOT SOLVED"
    print("GRADED %s checkpoint_%s: %d/%d strict, core %d/%d, %s" % (
        problem or data.get("problem", ""),
        checkpoint,
        passed_strict, total_strict,
        core_passed, core_total,
        solved_str,
    ))

    if fail_reason:
        print("  Failure reason: %s" % fail_reason)
    if infra_fail:
        print("  Infrastructure failure -- grade may be unreliable")

    # per-group table
    groups = ["Core", "Functionality", "Error", "Regression"]
    present = [g for g in groups if g in counts]
    if present:
        print("  %-14s  passed / total" % "Group")
        print("  " + "-" * 30)
        for g in present:
            v = counts[g]
            print("  %-14s  %d / %d" % (g, v.get("passed", 0), v.get("total", 0)))

    if failures:
        print("  Top failures:")
        for f in failures[:20]:
            msg = (f.get("message") or "").replace("\n", " ").strip()
            if len(msg) > 120:
                msg = msg[:117] + "..."
            print("    [%s] %s" % (f.get("group", "?"), f.get("id", "?")))
            if msg:
                print("      %s" % msg)


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

def cmd_join(room_id: str, name: str):
    r = _post_no_aid("/rooms/%s/register" % room_id, {"name": name})
    if "agent_id" in r:
        _session["agent_id"] = r["agent_id"]
        _session["room_id"]  = room_id
        _session["name"]     = name
        _save()
        print("Joined room %s as %s. Session saved to %s" % (room_id, name, SESSION_FILE))
    else:
        print("Error:", json.dumps(r, indent=2))
        sys.exit(1)


def cmd_wait(args: list):
    _require_session()
    submission_id = None
    timeout_s     = 600

    if args:
        # first arg may be a submission_id UUID or timeout=N
        a0 = args[0]
        if a0.startswith("timeout="):
            timeout_s = int(a0[8:])
        else:
            # assume it's a submission_id
            submission_id = a0
        if len(args) > 1:
            for a in args[1:]:
                if a.startswith("timeout="):
                    timeout_s = int(a[8:])

    problem = _session.get("problem", "")
    if not submission_id:
        submission_id = _session.get("last_submission_id", "")
    if not problem:
        print("No current problem in session. Run: python slopcode_client.py start <problem>")
        sys.exit(1)

    exit_code = _sse_wait_grade(submission_id, problem, timeout_s)
    sys.exit(exit_code)


def cmd_list():
    _require_session()
    r = _post({"command": "list_problems"})
    if not r.get("ok"):
        print("Error:", r.get("error", r))
        sys.exit(1)
    data     = r["data"]
    problems = data.get("problems", [])
    total    = data.get("total", len(problems))

    _DIFF_ORDER = {"Easy": 0, "Medium": 1, "Hard": 2, None: 3}
    problems = sorted(problems, key=lambda p: (_DIFF_ORDER.get(p.get("difficulty")), p["name"]))

    fmt = "  %-30s  %-8s  %-5s  %-11s  %s"
    print(fmt % ("name", "diff", "ckpts", "status", "current_ckpt"))
    print("  " + "-" * 70)
    attempted = 0
    for p in problems:
        st = p.get("status", "unstarted")
        if st != "unstarted":
            attempted += 1
        ckpt = p.get("current_checkpoint")
        ckpt_s = str(ckpt) if ckpt is not None else "-"
        diff   = p.get("difficulty") or "-"
        print(fmt % (p["name"][:30], diff[:8], p.get("checkpoints", "?"), st[:11], ckpt_s))

    print()
    print("  attempted %d/%d" % (attempted, total))


def cmd_start(problem: str, workdir: str = "."):
    _require_session()
    r = _post({"command": "start_problem", "problem": problem})
    if not r.get("ok"):
        print("Error:", r.get("error", r))
        sys.exit(1)
    data = r["data"]
    ckpt = data.get("checkpoint", 1)
    spec = data.get("spec_md", "")

    # write spec file
    spec_file = "spec_checkpoint_%d.md" % ckpt
    spath = os.path.join(workdir, spec_file)
    with open(spath, "w", encoding="utf-8") as f:
        f.write(spec)

    print("WARNING: starting a problem commits it to your score.")
    print()
    print("Started %s at checkpoint %d/%d" % (problem, ckpt, data.get("checkpoint_count", "?")))
    print("Entry file: %s.py (must exist at workspace root when submitting)" % data.get("entry_file", problem))
    print("Spec written to: %s" % spec_file)

    assets = data.get("static_assets", [])
    files  = data.get("files", [])
    asset_paths = [a.get("save_path", a.get("name", "")) for a in assets]
    if files:
        print()
        print("Static assets needed (%d files) -- run:" % len(files))
        print("  python slopcode_client.py files %s" % problem)
        print("  (assets are excluded from snapshots; they are re-materialized by the grader)")
    if data.get("notes"):
        print()
        print(data["notes"])

    # update session
    _session["problem"]     = problem
    _session["asset_paths"] = asset_paths
    _session["file_list"]   = files   # list of {path, sha256, size}
    _save()


def cmd_spec(problem: str, checkpoint, workdir: str = "."):
    _require_session()
    body = {"command": "get_spec", "problem": problem}
    if checkpoint is not None:
        body["checkpoint"] = int(checkpoint)
    r = _post(body)
    if not r.get("ok"):
        print("Error:", r.get("error", r))
        sys.exit(1)
    data = r["data"]
    ckpt = data.get("checkpoint", checkpoint or "?")
    spec = data.get("spec_md", "")
    spec_file = "spec_checkpoint_%d.md" % ckpt
    spath = os.path.join(workdir, spec_file)
    with open(spath, "w", encoding="utf-8") as f:
        f.write(spec)
    print("Spec written to: %s" % spec_file)


def cmd_files(problem: str, workdir: str = "."):
    """Download all static asset files for `problem` via chunked get_file."""
    _require_session()
    # file_list is cached in the session at start time (list of {path, sha256, size})
    # It is set by cmd_start; "file_list" key missing means start was never run.
    if "file_list" not in _session:
        print("No file list in session for %r. Run 'start %s' first." % (problem, problem))
        sys.exit(1)
    file_list = _session.get("file_list", [])
    if not file_list:
        print("Problem %r has no static asset files." % problem)
        return

    for finfo in file_list:
        fpath  = finfo["path"]
        fsize  = finfo["size"]
        fsha   = finfo["sha256"]
        chunks = []
        offset = 0
        while True:
            r2 = _post({"command": "get_file", "problem": problem, "path": fpath, "offset": offset})
            if not r2.get("ok"):
                print("Error fetching %s: %s" % (fpath, r2.get("error", r2)))
                sys.exit(1)
            d2 = r2["data"]
            chunk = base64.b64decode(d2["data_b64"])
            chunks.append(chunk)
            offset += len(chunk)
            if d2.get("eof"):
                break

        raw = b"".join(chunks)
        # verify sha256
        got_sha = hashlib.sha256(raw).hexdigest()
        if got_sha != fsha:
            print("CHECKSUM MISMATCH for %s (expected %s, got %s)" % (fpath, fsha[:12], got_sha[:12]))
            sys.exit(1)

        # write to disk preserving path
        dest = os.path.join(workdir, fpath.replace("/", os.sep))
        dest_dir = os.path.dirname(dest)
        if dest_dir:
            os.makedirs(dest_dir, exist_ok=True)
        with open(dest, "wb") as fh:
            fh.write(raw)
        print("OK %s (%s)" % (fpath, _fmt_size(fsize)))


def cmd_submit(problem: str, workdir: str = ".", metrics_arg: str = None):
    _require_session()
    asset_paths = _session.get("asset_paths", [])

    # pre-validate requirements.txt
    req_file = os.path.join(workdir, "requirements.txt")
    req_text = ""
    if os.path.exists(req_file):
        with open(req_file, encoding="utf-8") as f:
            req_text = f.read()
        ok, err = _validate_requirements(req_text)
        if not ok:
            print("ERROR: requirements.txt failed policy check: %s" % err)
            print("  Fix the requirement and retry. See CONTRACT G.3 for allowed forms.")
            sys.exit(1)
    else:
        print("Note: no requirements.txt found -- submitting with empty requirements.")

    # load metrics
    self_metrics = None
    if metrics_arg:
        mpath = os.path.join(workdir, metrics_arg)
        if not os.path.exists(mpath):
            mpath = metrics_arg  # try as absolute/relative path
        try:
            with open(mpath, encoding="utf-8") as f:
                self_metrics = json.load(f)
            if not isinstance(self_metrics, dict):
                print("ERROR: metrics file must contain a JSON object.")
                sys.exit(1)
        except (OSError, json.JSONDecodeError) as e:
            print("ERROR reading metrics file %r: %s" % (metrics_arg, e))
            sys.exit(1)

    # pack workspace
    print("Packing workspace...", flush=True)
    gz_bytes = _pack_workspace(workdir, asset_paths)
    print("  Snapshot: %s gzip, ready to submit" % _fmt_size(len(gz_bytes)))

    # build submit body
    body = {
        "command":          "submit",
        "problem":          problem,
        "snapshot_b64":     base64.b64encode(gz_bytes).decode("ascii"),
        "requirements_txt": req_text,
    }
    if self_metrics is not None:
        body["self_metrics"] = self_metrics

    r = _post(body, timeout=60)
    if not r.get("ok"):
        print("Error:", r.get("error", r))
        if r.get("hint"):
            print("Hint:", r["hint"])
        sys.exit(1)

    data = r["data"]
    sub_id  = data.get("submission_id", "?")
    ckpt    = data.get("checkpoint", "?")

    _session["last_submission_id"] = sub_id
    _save()

    print("Submitted %s for checkpoint %s." % (sub_id, ckpt))
    print("Run: python slopcode_client.py wait")


def cmd_result(problem: str):
    _require_session()
    sub_id = _session.get("last_submission_id", "")
    body = {"command": "result", "problem": problem}
    if sub_id:
        body["submission_id"] = sub_id
    r = _post(body)
    if not r.get("ok"):
        print("Error:", r.get("error", r))
        sys.exit(1)
    data = r["data"]
    status = data.get("status", "?")
    if status in ("pending", "grading"):
        print("Status: %s (submission %s)" % (status, data.get("submission_id", "?")))
        print("Run: python slopcode_client.py wait")
    elif status == "graded":
        _print_grade_result(data, problem)
    elif status == "error":
        print("GRADE ERROR: %s" % data.get("failure_reason", "unknown"))
        if data.get("infrastructure_failure"):
            print("  (infrastructure failure -- retry by resubmitting)")
        else:
            print("  Fix the issue and resubmit.")
    else:
        print(json.dumps(data, indent=2))


def cmd_advance(problem: str, workdir: str = "."):
    _require_session()
    r = _post({"command": "advance", "problem": problem})
    if not r.get("ok"):
        err = r.get("error", "")
        code = r.get("code", "")
        print("Error [%s]: %s" % (code, err))
        if r.get("hint"):
            print("Hint:", r["hint"])
        sys.exit(1)

    data = r["data"]
    rec  = data.get("record", {})
    if rec:
        solved_s = "SOLVED" if rec.get("solved") else "not solved"
        print("Checkpoint %s committed: %s/%s strict, %s" % (
            data.get("checkpoint", ""),
            rec.get("strict_passed", 0), rec.get("strict_total", 0),
            solved_s,
        ))

    if data.get("completed"):
        score = data.get("problem_score", 0)
        solved_n = data.get("solved_checkpoints", 0)
        total_n  = data.get("checkpoint_count", 0)
        print("PROBLEM COMPLETE %s: score %d/%d" % (problem, solved_n, total_n))
        _session["problem"] = ""
        _save()
    else:
        ckpt     = data.get("checkpoint")
        ckpt_cnt = data.get("checkpoint_count", "?")
        spec     = data.get("spec_md", "")
        if spec and ckpt:
            spec_file = "spec_checkpoint_%d.md" % ckpt
            spath = os.path.join(workdir, spec_file)
            with open(spath, "w", encoding="utf-8") as f:
                f.write(spec)
            print("Advanced to checkpoint %d/%s. Spec written to %s" % (ckpt, ckpt_cnt, spec_file))
            _session["problem"] = problem
            _save()


def cmd_status():
    _require_session()
    r = _post({"command": "status"})
    if not r.get("ok"):
        print("Error:", r.get("error", r))
        sys.exit(1)
    d = r["data"]

    print("Run label: %s" % (d.get("label") or "(none)"))
    print("Score so far: %.4f  (core: %.4f)" % (
        d.get("run_score_so_far", 0), d.get("core_run_score_so_far", 0)
    ))
    total = d.get("total_problems", 0)
    attempted = d.get("attempted", 0)
    completed = d.get("completed", 0)
    print("Problems: %d attempted, %d completed / %d total (coverage %.1f%%)" % (
        attempted, completed, total,
        100.0 * attempted / total if total else 0,
    ))
    sr = d.get("self_reported_totals", {})
    if any(sr.get(k, 0) for k in ("output_tokens", "input_tokens", "turns", "cost_usd")):
        print("Self-reported: %d out-tokens, %d in-tokens, %d turns, $%.4f" % (
            sr.get("output_tokens", 0), sr.get("input_tokens", 0),
            sr.get("turns", 0), sr.get("cost_usd", 0),
        ))

    problems = d.get("problems", [])
    if problems:
        print()
        fmt = "  %-28s  %-10s  %-5s  %-7s  %s"
        print(fmt % ("problem", "state", "ckpt", "solved", "pending_sub"))
        print("  " + "-" * 70)
        for p in problems:
            ckpt_info = "%d/%d" % (p.get("checkpoint", 0), p.get("checkpoint_count", "?"))
            pending   = p.get("pending_submission_id") or "-"
            if len(pending) > 8:
                pending = pending[:8] + "..."
            print(fmt % (
                p["name"][:28],
                p.get("state", "?")[:10],
                ckpt_info,
                str(p.get("solved_checkpoints", 0)),
                pending,
            ))


def cmd_label(text: str):
    _require_session()
    r = _post({"command": "set_label", "label": text})
    if not r.get("ok"):
        print("Error:", r.get("error", r))
        sys.exit(1)
    print("Label set: %r" % r["data"].get("label", text))


def cmd_finalize():
    _require_session()
    r = _post({"command": "finalize"})
    if not r.get("ok"):
        err  = r.get("error", "")
        code = r.get("code", "")
        print("Error [%s]: %s" % (code, err))
        if code == "E_GRADE_PENDING":
            print("  Wait for all pending grades first:")
            print("  python slopcode_client.py wait")
        sys.exit(1)

    d = r["data"]
    score    = d.get("run_score", 0)
    label    = d.get("label") or ""
    attempted = d.get("attempted", 0)
    total    = d.get("total_problems", 0)
    ckpts_s  = d.get("checkpoints_solved", 0)
    ckpts_a  = d.get("checkpoints_attempted", 0)
    wall     = d.get("wall_seconds", 0)

    print("Run finalized.")
    print("  Score:       %.4f  (core: %.4f)" % (score, d.get("core_run_score", 0)))
    print("  Coverage:    %d/%d problems attempted" % (attempted, total))
    print("  Checkpoints: %d/%d solved" % (ckpts_s, ckpts_a))
    h = int(wall // 3600)
    m = int((wall % 3600) // 60)
    s = int(wall % 60)
    print("  Wall time:   %dh %02dm %02ds" % (h, m, s))
    if label:
        print("  Label:       %s" % label)
    print()
    print("Leaderboard: %s/games/slopcode/leaderboard" % BASE)
    print("Room will auto-reset in ~5 minutes.")


# ---------------------------------------------------------------------------
# Self-test (run with: python slopcode_client.py _selftest)
# ---------------------------------------------------------------------------

def _selftest():
    """Verify pure-logic parts: requirements validation, snapshot exclusion, ASCII check."""
    errors = []

    # --- requirements validation (canonical corpus -- must match grader/safety.py) ---
    def _req_ok(text, label):
        ok, msg = _validate_requirements(text)
        if not ok:
            errors.append("FAIL req_ok(%s): %s" % (label, msg))

    def _req_fail(text, label):
        ok, msg = _validate_requirements(text)
        if ok:
            errors.append("FAIL req_fail(%s): expected rejection but got ok" % label)

    # accept corpus
    _req_ok("flask==3.0.3", "flask==3.0.3")
    _req_ok("requests>=2.31", "requests>=2.31")
    # NOTE: "requests >= 2.31" (space between operator and version) is REJECTED
    # by the canonical grader regex -- the version clause (?:[<>=!~^,]+\S+\s*)+
    # requires \S+ (non-whitespace) immediately after the operator characters.
    # Corpus discrepancy: the CONTRACT spec listed this as accept, but grader is
    # source of truth (grader/safety.py check_requirements_line).
    _req_fail("requests >= 2.31", "requests >= 2.31")
    _req_ok("numpy", "numpy")
    _req_ok("Flask", "Flask")
    _req_ok("pandas[extra]==2.0", "pandas[extra]==2.0")
    _req_ok("foo>=1.0,<2.0", "foo>=1.0,<2.0")
    _req_ok("torch; python_version>='3.8'", "torch; python_version>='3.8'")
    # additional ok
    _req_ok("package-name[extra1,extra2]>=1.0; python_version>='3.8'\n", "extras-marker")
    _req_ok("", "empty")
    _req_ok("# this is a comment\n\nflask\n", "comment-plus-blank")
    _req_ok("A" * 50 + "\n", "long-name-ok")
    # digit-leading names are accepted (contract G.3 ^[A-Za-z0-9])
    _req_ok("1pkg", "1pkg")
    _req_ok("4suite-xml==1.0.0", "4suite-xml==1.0.0")
    # reject corpus
    _req_fail("foo==1.0 bar==2.0", "foo==1.0 bar==2.0")
    _req_fail("pkg>=1 extraword", "pkg>=1 extraword")
    _req_fail("-e .", "-e .")
    _req_fail("--index-url http://x", "--index-url http://x")
    _req_fail("pkg @ git+https://x/y", "pkg @ git+https://x/y")
    _req_fail("./local", "./local")
    _req_fail("/abs/path", "/abs/path")
    _req_fail("~user/pkg", "~user/pkg")
    _req_fail("C:pkg", "C:pkg")
    # additional reject
    _req_fail("-r other.txt\n", "dash-r")
    _req_fail("flask @ https://example.com/flask.whl\n", "url-direct-ref")
    _req_fail("C:\\path\\to\\package\n", "windows-path-backslash")
    # 51 effective lines
    _req_fail("\n".join(["pkg%d" % i for i in range(51)]), "51-lines")

    # --- _should_exclude ---
    def _excl(parts, label):
        if not _should_exclude(parts):
            errors.append("FAIL excl(%s): expected exclusion" % label)
    def _not_excl(parts, label):
        if _should_exclude(parts):
            errors.append("FAIL not_excl(%s): expected inclusion" % label)

    _excl([".venv", "lib", "flask.py"], "venv")
    _excl(["__pycache__", "mod.cpython-312.pyc"], "pycache-dir")
    _excl(["mymodule.pyc"], "pyc")
    _excl([".slopcode_session.json"], "session-file")
    _excl(["slopcode_client.py"], "client-file")
    _excl([".evaluation_tests", "conftest.py"], "eval-tests")
    _not_excl(["mymodule.py"], "normal-py")
    _not_excl(["src", "utils.py"], "src-utils")
    _not_excl(["requirements.txt"], "requirements")

    # --- ASCII check: scan all string literals in this file for non-ASCII that gets printed ---
    selfpath = os.path.abspath(__file__)
    try:
        with open(selfpath, "rb") as f:
            raw = f.read()
        # Verify the file itself is valid ASCII overall for the print() paths
        # by checking for non-ASCII bytes in lines containing print(
        for lineno, line_bytes in enumerate(raw.splitlines(), 1):
            if b"print(" in line_bytes:
                try:
                    line_bytes.decode("ascii")
                except UnicodeDecodeError:
                    errors.append("FAIL ascii: non-ASCII in print() at line %d" % lineno)
    except OSError:
        pass  # running from a non-file context

    # --- gzip magic check ---
    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode="wb", mtime=0) as gz:
        gz.write(b"hello")
    gz_bytes = buf.getvalue()
    if gz_bytes[:2] != b'\x1f\x8b':
        errors.append("FAIL gzip-magic: expected 1f 8b")

    if errors:
        for e in errors:
            print("  " + e)
        print("SELF-TEST FAILED (%d errors)" % len(errors))
        sys.exit(1)
    else:
        print("SELF-TEST PASSED (requirements policy, exclusion rules, ASCII, gzip magic)")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _usage():
    print(__doc__.strip())


def main():
    _load()
    args = sys.argv[1:]
    if not args:
        _usage()
        sys.exit(0)

    cmd  = args[0].lower()
    rest = args[1:]

    if cmd == "join":
        if len(rest) < 2:
            print("Usage: slopcode_client.py join <room_id> <name>")
            sys.exit(1)
        cmd_join(rest[0], rest[1])

    elif cmd == "wait":
        cmd_wait(rest)

    elif cmd == "list":
        cmd_list()

    elif cmd == "start":
        if not rest:
            print("Usage: slopcode_client.py start <problem>")
            sys.exit(1)
        workdir = "."
        for a in rest[1:]:
            if a.startswith("--dir="):
                workdir = a[6:]
        cmd_start(rest[0], workdir)

    elif cmd == "spec":
        _require_session()
        problem  = rest[0] if rest else _session.get("problem", "")
        ckpt_arg = None
        workdir  = "."
        for a in rest:
            if a.startswith("--dir="):
                workdir = a[6:]
            elif a.isdigit():
                ckpt_arg = int(a)
        if not problem:
            print("Usage: slopcode_client.py spec [problem] [checkpoint]")
            sys.exit(1)
        cmd_spec(problem, ckpt_arg, workdir)

    elif cmd == "files":
        _require_session()
        problem = rest[0] if rest else _session.get("problem", "")
        workdir = "."
        for a in rest:
            if a.startswith("--dir="):
                workdir = a[6:]
        if not problem:
            print("Usage: slopcode_client.py files [problem]")
            sys.exit(1)
        cmd_files(problem, workdir)

    elif cmd == "submit":
        _require_session()
        problem    = _session.get("problem", "")
        workdir    = "."
        metrics    = None
        for a in rest:
            if a.startswith("metrics="):
                metrics = a[8:]
            elif a.startswith("--dir="):
                workdir = a[6:]
            elif not problem:
                problem = a
        if not problem:
            print("Usage: slopcode_client.py submit [problem] [metrics=<file.json>]")
            sys.exit(1)
        cmd_submit(problem, workdir, metrics)

    elif cmd == "result":
        _require_session()
        problem = rest[0] if rest else _session.get("problem", "")
        if not problem:
            print("Usage: slopcode_client.py result [problem]")
            sys.exit(1)
        cmd_result(problem)

    elif cmd == "advance":
        _require_session()
        problem = rest[0] if rest else _session.get("problem", "")
        workdir = "."
        for a in rest:
            if a.startswith("--dir="):
                workdir = a[6:]
        if not problem:
            print("Usage: slopcode_client.py advance [problem]")
            sys.exit(1)
        cmd_advance(problem, workdir)

    elif cmd == "status":
        cmd_status()

    elif cmd == "label":
        if not rest:
            print("Usage: slopcode_client.py label <text>")
            sys.exit(1)
        cmd_label(" ".join(rest))

    elif cmd == "finalize":
        if not rest or rest[0].lower() != "confirm":
            print("Usage: slopcode_client.py finalize confirm")
            print("  (the literal word 'confirm' is required to prevent accidents)")
            sys.exit(1)
        cmd_finalize()

    elif cmd == "_selftest":
        _selftest()

    else:
        print("Unknown command: %r" % cmd)
        print()
        _usage()
        sys.exit(1)


if __name__ == "__main__":
    main()
