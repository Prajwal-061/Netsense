"""Launcher: start a program with this process's network capabilities passed on.

    python pass_caps.py PROGRAM [ARGS...]

Why it exists: the venv's Python holds CAP_NET_RAW as a file capability
(setcap), but Linux drops capabilities when a process starts another program,
so an Nmap started by the API would be unprivileged. Capabilities placed in
the "ambient" set do survive that step. This launcher puts its network
capabilities in the ambient set and then replaces itself with the program,
so only that one child gets them. systemd's AmbientCapabilities= does the
same thing for a whole service.

Standard library only, so it can run with python -I (isolated mode).
"""

import ctypes
import os
import sys

# Capability numbers from <linux/capability.h>.
CAP_NET_ADMIN = 12
CAP_NET_RAW = 13
NETWORK_CAPABILITIES = (CAP_NET_RAW, CAP_NET_ADMIN)

_LINUX_CAPABILITY_VERSION_3 = 0x20080522
_PR_CAP_AMBIENT = 47
_PR_CAP_AMBIENT_RAISE = 2


class _Header(ctypes.Structure):
    _fields_ = [("version", ctypes.c_uint32), ("pid", ctypes.c_int)]


class _Data(ctypes.Structure):
    _fields_ = [
        ("effective", ctypes.c_uint32),
        ("permitted", ctypes.c_uint32),
        ("inheritable", ctypes.c_uint32),
    ]


def raise_ambient(capabilities=NETWORK_CAPABILITIES) -> list[int]:
    """Make the given capabilities ambient, for those this process holds.

    Returns the ones that were raised. Holding none of them is not an error:
    the program then simply starts unprivileged.
    """
    libc = ctypes.CDLL(None, use_errno=True)
    header = _Header(_LINUX_CAPABILITY_VERSION_3, 0)
    data = (_Data * 2)()  # two 32-bit halves; capabilities 0-31 are in the first
    if libc.capget(ctypes.byref(header), data) != 0:
        return []

    held = [cap for cap in capabilities if data[0].permitted & (1 << cap)]
    if not held:
        return []
    # A capability can only become ambient if it is both permitted and
    # inheritable, so copy the held ones into the inheritable set first.
    for cap in held:
        data[0].inheritable |= 1 << cap
    if libc.capset(ctypes.byref(header), data) != 0:
        return []
    return [
        cap for cap in held if libc.prctl(_PR_CAP_AMBIENT, _PR_CAP_AMBIENT_RAISE, cap, 0, 0) == 0
    ]


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    raise_ambient()
    # exec replaces this process with the program: same PID, no Python left.
    os.execvp(sys.argv[1], sys.argv[1:])
