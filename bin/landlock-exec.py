#!/usr/bin/env python3
"""landlock-exec.py -- run one command inside a Landlock filesystem sandbox.

    landlock-exec.py [--ro P]... [--rx P]... [--rw P]... [--wo P]... -- CMD [ARG]...
    landlock-exec.py --abi

Builds a Landlock ruleset that HANDLES every filesystem access right the running
kernel's ABI knows about, grants back only the listed path hierarchies, applies it
to this process (PR_SET_NO_NEW_PRIVS + landlock_restrict_self) and then execs CMD.
Landlock domains are inherited across fork/exec and can never be loosened, so CMD
and every process it spawns stay confined for their whole lives.

Access modes (each PATH covers itself and everything beneath it; a regular-file
PATH gets only the file-applicable subset of its mode's rights):

    --ro  read files, list directories
    --rx  --ro + execute
    --rw  every right the kernel handles (read, write, create, delete, rename
          within the granted trees, truncate, device ioctl, execute)
    --wo  write-only: open an EXISTING file for writing/appending, never read it

Deliberately NOT restricted (out of scope for this wrapper): network (no
LANDLOCK_ACCESS_NET_*) and scopes (no LANDLOCK_SCOPE_*). Landlock itself also
never restricts stat()/access()/chmod() and path traversal: a sandboxed process
can still learn that a guessed path exists, but can neither list a directory nor
read, write or execute anything outside the granted trees.

Failure is always loud and never degrades to an unsandboxed exec: any setup error
(no Landlock, missing PATH, rejected rule) exits 125 before CMD is started; a CMD
that cannot be found / executed exits 127 / 126.

--abi prints the kernel's Landlock ABI version (0 when Landlock is unavailable)
and exits 0; bellows uses it to fail fast before scheduling a sandboxed trial.

stdlib only (ctypes); run it as `python3 -I -S landlock-exec.py ...`.
"""

import ctypes
import os
import stat
import sys

# Syscall numbers are shared by every architecture that has Landlock except alpha
# (new syscalls got unified numbers from 424 upward).
SYS_LANDLOCK_CREATE_RULESET = 444
SYS_LANDLOCK_ADD_RULE = 445
SYS_LANDLOCK_RESTRICT_SELF = 446

LANDLOCK_CREATE_RULESET_VERSION = 1 << 0
LANDLOCK_RULE_PATH_BENEATH = 1
PR_SET_NO_NEW_PRIVS = 38

# include/uapi/linux/landlock.h
FS_EXECUTE = 1 << 0
FS_WRITE_FILE = 1 << 1
FS_READ_FILE = 1 << 2
FS_READ_DIR = 1 << 3
FS_REMOVE_DIR = 1 << 4
FS_REMOVE_FILE = 1 << 5
FS_MAKE_CHAR = 1 << 6
FS_MAKE_DIR = 1 << 7
FS_MAKE_REG = 1 << 8
FS_MAKE_SOCK = 1 << 9
FS_MAKE_FIFO = 1 << 10
FS_MAKE_BLOCK = 1 << 11
FS_MAKE_SYM = 1 << 12
FS_REFER = 1 << 13  # ABI 2
FS_TRUNCATE = 1 << 14  # ABI 3
FS_IOCTL_DEV = 1 << 15  # ABI 5

FS_ABI1 = (1 << 13) - 1  # EXECUTE .. MAKE_SYM

# Rights that are meaningful on a non-directory; the kernel rejects a rule on a
# file that asks for anything else (EINVAL).
FS_FILE_RIGHTS = FS_EXECUTE | FS_WRITE_FILE | FS_READ_FILE | FS_TRUNCATE | FS_IOCTL_DEV

EXIT_SETUP = 125
EXIT_NOEXEC = 126
EXIT_NOTFOUND = 127


def handled_rights(abi):
    """Every filesystem right the given ABI version knows how to restrict."""
    rights = FS_ABI1
    if abi >= 2:
        rights |= FS_REFER
    if abi >= 3:
        rights |= FS_TRUNCATE
    if abi >= 5:
        rights |= FS_IOCTL_DEV
    return rights


def mode_rights(mode, handled):
    if mode == "ro":
        return FS_READ_FILE | FS_READ_DIR
    if mode == "rx":
        return FS_READ_FILE | FS_READ_DIR | FS_EXECUTE
    if mode == "rw":
        return handled
    if mode == "wo":
        return FS_WRITE_FILE
    raise ValueError(mode)


class RulesetAttr(ctypes.Structure):
    # Only the first member (handled_access_fs). The kernel accepts a shorter
    # struct from older userspace, which leaves handled_access_net and scoped at
    # zero: network and scope restrictions stay off by construction.
    _fields_ = [("handled_access_fs", ctypes.c_uint64)]


class PathBeneathAttr(ctypes.Structure):
    _pack_ = 1
    _fields_ = [("allowed_access", ctypes.c_uint64), ("parent_fd", ctypes.c_int32)]


def die(msg, code=EXIT_SETUP):
    sys.stderr.write("landlock-exec: %s\n" % msg)
    sys.stderr.flush()
    os._exit(code)


def libc():
    lib = ctypes.CDLL(None, use_errno=True)
    lib.syscall.restype = ctypes.c_long
    lib.prctl.restype = ctypes.c_int
    return lib


def landlock_abi(lib):
    """Kernel Landlock ABI version, or 0 when unsupported/disabled."""
    if not sys.platform.startswith("linux"):
        return 0
    ret = lib.syscall(
        ctypes.c_long(SYS_LANDLOCK_CREATE_RULESET),
        ctypes.c_void_p(None),
        ctypes.c_size_t(0),
        ctypes.c_uint32(LANDLOCK_CREATE_RULESET_VERSION),
    )
    return ret if ret > 0 else 0


def parse_args(argv):
    rules = []  # (mode, path) in argv order
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--":
            cmd = argv[i + 1 :]
            if not cmd:
                die("missing command after --", 2)
            return rules, cmd
        if a in ("--ro", "--rx", "--rw", "--wo"):
            if i + 1 >= len(argv):
                die("%s needs a PATH" % a, 2)
            rules.append((a[2:], argv[i + 1]))
            i += 2
            continue
        die("unknown argument %r (usage: landlock-exec.py [--ro|--rx|--rw|--wo PATH]... -- CMD [ARG]...)" % a, 2)
    die("missing -- CMD", 2)


def original_environ():
    """The env block this process was exec'd with, byte-for-byte.

    CPython may setenv() at startup (PEP 538 C-locale coercion adds LC_CTYPE);
    that only rewrites libc's environ array, never the original block the kernel
    exposes in /proc/self/environ. Forward that block so the sandboxed command
    sees exactly the env bellows passed in.
    """
    try:
        with open("/proc/self/environ", "rb") as f:
            raw = f.read()
    except OSError:
        return os.environb
    env = {}
    for item in raw.split(b"\0"):
        if not item:
            continue
        k, sep, v = item.partition(b"=")
        if sep and k:
            env[k] = v
    return env


def main(argv):
    lib = libc()
    if argv == ["--abi"]:
        sys.stdout.write("%d\n" % landlock_abi(lib))
        return 0

    rules, cmd = parse_args(argv)
    if not sys.platform.startswith("linux"):
        die("Landlock requires Linux (this is %s); refusing to run unsandboxed" % sys.platform)
    abi = landlock_abi(lib)
    if abi < 1:
        die("Landlock is unavailable on this kernel (landlock_create_ruleset errno %d); refusing to run unsandboxed" % ctypes.get_errno())
    handled = handled_rights(abi)
    env = original_environ()

    attr = RulesetAttr(handled_access_fs=handled)
    ruleset_fd = lib.syscall(
        ctypes.c_long(SYS_LANDLOCK_CREATE_RULESET),
        ctypes.byref(attr),
        ctypes.c_size_t(ctypes.sizeof(attr)),
        ctypes.c_uint32(0),
    )
    if ruleset_fd < 0:
        die("landlock_create_ruleset failed: %s" % os.strerror(ctypes.get_errno()))

    for mode, p in rules:
        try:
            fd = os.open(p, os.O_PATH | os.O_CLOEXEC)
        except OSError as e:
            die("--%s %s: %s" % (mode, p, e.strerror))
        try:
            is_dir = stat.S_ISDIR(os.fstat(fd).st_mode)
            access = mode_rights(mode, handled) & handled
            if not is_dir:
                access &= FS_FILE_RIGHTS
            elif mode == "wo":
                die("--wo %s: write-only grants are for files, not directories" % p)
            if not access:
                die("--%s %s: no applicable rights on this kernel (ABI %d)" % (mode, p, abi))
            pb = PathBeneathAttr(allowed_access=access, parent_fd=fd)
            ret = lib.syscall(
                ctypes.c_long(SYS_LANDLOCK_ADD_RULE),
                ctypes.c_long(ruleset_fd),
                ctypes.c_long(LANDLOCK_RULE_PATH_BENEATH),
                ctypes.byref(pb),
                ctypes.c_uint32(0),
            )
            if ret < 0:
                die("landlock_add_rule --%s %s failed: %s" % (mode, p, os.strerror(ctypes.get_errno())))
        finally:
            os.close(fd)

    if lib.prctl(ctypes.c_int(PR_SET_NO_NEW_PRIVS), ctypes.c_ulong(1), ctypes.c_ulong(0), ctypes.c_ulong(0), ctypes.c_ulong(0)) != 0:
        die("prctl(PR_SET_NO_NEW_PRIVS) failed: %s" % os.strerror(ctypes.get_errno()))
    if lib.syscall(ctypes.c_long(SYS_LANDLOCK_RESTRICT_SELF), ctypes.c_long(ruleset_fd), ctypes.c_uint32(0)) != 0:
        die("landlock_restrict_self failed: %s" % os.strerror(ctypes.get_errno()))
    os.close(ruleset_fd)

    try:
        os.execvpe(cmd[0], cmd, env)
    except FileNotFoundError:
        die("%s: command not found" % cmd[0], EXIT_NOTFOUND)
    except OSError as e:
        die("%s: %s" % (cmd[0], e.strerror), EXIT_NOEXEC)
    return EXIT_SETUP  # unreachable


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
