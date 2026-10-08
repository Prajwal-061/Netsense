"""Collection service: save what the Netmiko collector read from a device."""

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import ConfigBackup, Device, DeviceCollection, utcnow
from app.engine import classifier
from app.engine.config_diff import config_hash


def _device_for_host(session: Session, host: str) -> Device | None:
    """The scanned device currently at this address, if discovery has seen it."""
    return session.scalars(
        select(Device).where(Device.last_ip == host).order_by(Device.last_seen.desc()).limit(1)
    ).first()


def save_collection(
    session: Session,
    host: str,
    interfaces,
    vlans,
    mac_table,
    device: Device | None = None,
    version=None,
) -> DeviceCollection:
    """Store one snapshot of a device's interfaces, VLANs, MAC table and version.

    The snapshot is linked to device if given, otherwise to the scanned
    device currently at that address.
    """
    collection = DeviceCollection(
        device=device or _device_for_host(session, host),
        host=host,
        interfaces=interfaces,
        vlans=vlans,
        mac_table=mac_table,
        version=version,
    )
    session.add(collection)
    session.commit()
    return collection


def confirm_device_type(session: Session, device: Device, version, vlans) -> None:
    """Set a device's type from what it reported about itself after a login.

    This replaces the scan's guess, and later scans do not overwrite it.
    """
    confirmed = classifier.classify_collected(version, vlans)
    device.device_type = confirmed["type"]
    device.type_reason = confirmed["reason"]
    device.type_source = Device.TYPE_FROM_COLLECTION
    session.commit()


def latest_backup(session: Session, host: str, before_id: int | None = None) -> ConfigBackup | None:
    """The newest config backup of a host, optionally only those older than before_id."""
    query = select(ConfigBackup).where(ConfigBackup.host == host)
    if before_id is not None:
        query = query.where(ConfigBackup.id < before_id)
    return session.scalars(query.order_by(ConfigBackup.id.desc()).limit(1)).first()


def save_config_backup(
    session: Session, host: str, config: str, device: Device | None = None
) -> tuple[ConfigBackup, bool]:
    """Store a running config unless it is the same as the host's latest one.

    "The same" ignores lines that change without a config change (timestamps,
    byte count): see config_diff.normalize_config. The raw text is what gets
    stored. Returns (backup, created). When the config is unchanged, the
    existing backup is returned with last_seen_at moved forward and created
    is False.
    """
    # SHA-256 turns the whole config into 64 hex characters. Equal hashes
    # mean equal configs, so comparing is cheap however long the config is.
    digest = config_hash(config)
    latest = latest_backup(session, host)

    # The latest backup's hash is recomputed rather than read from its row,
    # so the comparison stays right if the normalisation rules ever change.
    if latest is not None and config_hash(latest.config) == digest:
        latest.last_seen_at = utcnow()
        session.commit()
        return latest, False

    backup = ConfigBackup(
        device=device or _device_for_host(session, host), host=host, sha256=digest, config=config
    )
    session.add(backup)
    session.commit()
    return backup, True
