"""Running-config text handling: normalise, hash, mask secrets and diff.

A device adds lines to "show running-config" that change although the
configuration did not: a banner, a byte count, timestamps. Comparing raw
text would report a change on every such line. Everything here therefore
compares the normalised text, while the database keeps the raw text.
"""

import difflib
import hashlib
import re
from dataclasses import dataclass

REDACTED = "<redacted>"

# Lines that say something about the output or the moment, not about how the
# device is configured. Each pattern must match a whole line.
_VOLATILE_LINES = re.compile(
    r"""
      Building\ configuration\.\.\.                 # banner printed before the config
    | Current\ configuration\s*:\s*\d+\ bytes       # size of the output
    | !\ Last\ configuration\ change\ at\ .*        # also moves when someone enters and
                                                    # leaves config mode without a change
    | !\ NVRAM\ config\ last\ updated\ at\ .*       # moves on every "write memory"
    | !\ No\ configuration\ change\ since\ last\ restart.*
    | ntp\ clock-period\ \d+                        # tuned by the device itself
    | !Time:\ .*                                    # NX-OS timestamp
    """,
    re.VERBOSE,
)

# Keywords that are followed by a secret somewhere on the rest of the line.
# The rest of the line is masked, not just the next word: the secret is not
# always the next word ("key 1 md5 7 <hash>"), and losing a trailing "RO" is
# better than leaking a hash. "password-encryption" and "key chain NAME" are
# settings, not secrets, and do not match.
_SECRET = re.compile(
    r"(\b(?:secret|password|community|key-string|pre-shared-key|key(?!\s+chain\b))\s+).*",
    re.IGNORECASE,
)


def normalize_config(config: str) -> str:
    """Remove everything that can differ between two reads of the same config.

    Drops the volatile lines, trailing whitespace and Windows line endings,
    and blank lines at the start and end. Real configuration lines, their
    order and their indentation are untouched.
    """
    lines = [line.rstrip() for line in config.splitlines()]
    kept = [line for line in lines if not _VOLATILE_LINES.fullmatch(line)]
    return "\n".join(kept).strip("\n")


def config_hash(config: str) -> str:
    """SHA-256 of the normalised config: equal for two reads of an unchanged config."""
    return hashlib.sha256(normalize_config(config).encode()).hexdigest()


def redact_config(config: str) -> str:
    """Mask password hashes, SNMP communities and keys in a Cisco IOS config.

    Best effort, for display only: it covers the common secret-bearing
    commands, not every possible one. Works on diff text too, because the
    leading "+", "-" or space of a diff line is kept.
    """
    return "\n".join(_SECRET.sub(rf"\g<1>{REDACTED}", line) for line in config.splitlines())


@dataclass
class ConfigDiff:
    changed: bool
    lines_added: int
    lines_removed: int
    # Unified diff text ("" when nothing changed), with secrets masked.
    diff: str


def diff_configs(
    old: str, new: str, old_label: str = "previous", new_label: str = "current"
) -> ConfigDiff:
    """Compare two running configs and return a unified diff with a summary.

    Both sides are normalised first, so timestamp-only differences give no
    diff. Secrets are masked after diffing, not before: a changed password
    then still shows as a removed and an added line, without its value.
    """
    old_lines = normalize_config(old).splitlines()
    new_lines = normalize_config(new).splitlines()
    # A unified diff shows each change with 3 unchanged lines around it for
    # context: "-" lines exist only in the old config, "+" only in the new.
    lines = list(
        difflib.unified_diff(old_lines, new_lines, old_label, new_label, n=3, lineterm="")
    )
    body = lines[2:]  # the first two lines are the "---" and "+++" file headers
    return ConfigDiff(
        changed=bool(lines),
        lines_added=sum(line.startswith("+") for line in body),
        lines_removed=sum(line.startswith("-") for line in body),
        diff=redact_config("\n".join(lines)),
    )
