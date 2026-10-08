"""Launcher tests. They run the real launcher as a subprocess."""

import subprocess
import sys
from pathlib import Path

from app.engine import pass_caps

LAUNCHER = Path(pass_caps.__file__)
NET_RAW = 1 << pass_caps.CAP_NET_RAW


def capability_set(name: str, status_text: str) -> int:
    """Read one capability set (e.g. "CapAmb") from /proc/<pid>/status text."""
    line = next(line for line in status_text.splitlines() if line.startswith(name + ":"))
    return int(line.split()[1], 16)


def run(*command: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-I", str(LAUNCHER), *command], capture_output=True, text=True
    )


def test_launcher_runs_the_program_with_its_arguments():
    result = run("echo", "hello", "world")

    assert result.returncode == 0
    assert result.stdout == "hello world\n"


def test_launcher_passes_on_the_exit_code():
    assert run("false").returncode == 1


def test_launcher_without_a_program_prints_usage():
    result = run()

    assert result.returncode != 0
    assert "pass_caps.py PROGRAM" in result.stderr


def test_child_gets_cap_net_raw_exactly_when_this_python_holds_it():
    # Works on any machine: with the capability set on the venv's Python the
    # child must have it, and on a plain Python (CI) the child must not.
    own = subprocess.run(
        [sys.executable, "-I", "-c", "print(open('/proc/self/status').read())"],
        capture_output=True,
        text=True,
    ).stdout
    python_holds_it = bool(capability_set("CapPrm", own) & NET_RAW)

    child = run("cat", "/proc/self/status").stdout

    assert bool(capability_set("CapAmb", child) & NET_RAW) == python_holds_it
    assert bool(capability_set("CapEff", child) & NET_RAW) == python_holds_it
