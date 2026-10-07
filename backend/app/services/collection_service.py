"""Collection service: save what the Netmiko collector read from a device."""

import hashlib
import re

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import ConfigBackup, Device, DeviceCollection, utcnow


REDACTED = "<redacted>"

# Keywords that are followed by a secret somewhere on the rest of the line.
# The rest of the line is masked, not just the next word: the secret is not
# always the next word ("key 1 md5 7 <hash>"), and losing a trailing "RO" is
# better than leaking a hash. "password-encryption" and "key chain NAME" are
# settings, not secrets, and do not match.
_SECRET = re.compile(
    r"(\b(?:secret|password|community|key-string|pre-shared-key|key(?!\s+chain\b))\s+).*",
    re.IGNORECASE,
)


def redact_config(config: str) -> str:
    """Mask password hashes, SNMP communities and keys in a Cisco IOS config.

    Best effort, for display only: it covers the common secret-bearing
    commands, not every possible one. The stored backup is left untouched.
    """
    return "\n".join(_SECRET.sub(rf"\g<1>{REDACTED}", line) for line in config.splitlines())


def _device_for_host(session: Session, host: str) -> Device | None:
    """The scanned device currently at this address, if discovery has seen it."""
    return session.scalars(
        select(Device).where(Device.last_ip == host).order_by(Device.last_seen.desc()).limit(1)
    ).first()


def save_collection(
    session: Session, host: str, interfaces, vlans, mac_table, device: Device | None = None
) -> DeviceCollection:
    """Store one snapshot of a device's interfaces, VLANs and MAC table.

    The snapshot is linked to device if given, otherwise to the scanned
    device currently at that address.
    """
    collection = DeviceCollection(
        device=device or _device_for_host(session, host),
        host=host,
        interfaces=interfaces,
        vlans=vlans,
        mac_table=mac_table,
    )
    session.add(collection)
    session.commit()
    return collection


def save_config_backup(
    session: Session, host: str, config: str, device: Device | None = None
) -> tuple[ConfigBackup, bool]:
    """Store a running config unless it is identical to the host's latest one.

    Returns (backup, created). When the config is unchanged, the existing
    backup is returned with last_seen_at moved forward and created is False.
    """
    # SHA-256 turns the whole config into 64 hex characters. Equal hashes
    # mean equal configs, so comparing is cheap however long the config is.
    digest = hashlib.sha256(config.encode()).hexdigest()
    latest = session.scalars(
        select(ConfigBackup)
        .where(ConfigBackup.host == host)
        .order_by(ConfigBackup.id.desc())
        .limit(1)
    ).first()

    if latest is not None and latest.sha256 == digest:
        latest.last_seen_at = utcnow()
        session.commit()
        return latest, False

    backup = ConfigBackup(
        device=device or _device_for_host(session, host), host=host, sha256=digest, config=config
    )
    session.add(backup)
    session.commit()
    return backup, True
