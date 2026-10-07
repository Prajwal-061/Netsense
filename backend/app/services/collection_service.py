"""Collection service: save what the Netmiko collector read from a device."""

import hashlib

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import ConfigBackup, Device, DeviceCollection, utcnow


def _device_for_host(session: Session, host: str) -> Device | None:
    """The scanned device currently at this address, if discovery has seen it."""
    return session.scalars(
        select(Device).where(Device.last_ip == host).order_by(Device.last_seen.desc()).limit(1)
    ).first()


def save_collection(
    session: Session, host: str, interfaces, vlans, mac_table
) -> DeviceCollection:
    """Store one snapshot of a device's interfaces, VLANs and MAC table."""
    collection = DeviceCollection(
        device=_device_for_host(session, host),
        host=host,
        interfaces=interfaces,
        vlans=vlans,
        mac_table=mac_table,
    )
    session.add(collection)
    session.commit()
    return collection


def save_config_backup(session: Session, host: str, config: str) -> tuple[ConfigBackup, bool]:
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
        device=_device_for_host(session, host), host=host, sha256=digest, config=config
    )
    session.add(backup)
    session.commit()
    return backup, True
