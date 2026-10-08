"""Collection service: run the Netmiko collector and save what it read.

Collecting from one device and from every device share the same two steps:
the engine reads the device (collector.collect_host, network only), and this
module stores the outcome (record_success / record_failure, database only).
"""

import threading
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor, as_completed
from ipaddress import IPv4Address, IPv4Network

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.credentials import Credentials
from app.db.models import ConfigBackup, Device, DeviceCollection, NetworkCollection, utcnow
from app.engine import classifier, collector, discovery
from app.engine.config_diff import config_hash

# How many devices are logged in to at the same time. Collection is almost
# all waiting for devices to answer, so threads help even in Python. The
# limit is kept small on purpose: each login uses one of a device's few vty
# lines, a Raspberry Pi has little memory, and a burst of simultaneous SSH
# logins across a network looks like an attack to monitoring systems.
MAX_PARALLEL_DEVICES = 4

# Held while checking for a running collection and creating the new one, so
# two requests arriving together cannot both start one (single process only).
_start_lock = threading.Lock()


class CollectionInProgressError(Exception):
    """A network collection is already running."""


class NoNetworkDevicesError(Exception):
    """No device is classified as a network device, so there is nothing to collect."""


def _device_for_host(session: Session, host: str) -> Device | None:
    """The scanned device currently at this address, if discovery has seen it."""
    return session.scalars(
        select(Device).where(Device.last_ip == host).order_by(Device.last_seen.desc()).limit(1)
    ).first()


def confirm_device_type(session: Session, device: Device, version, vlans) -> None:
    """Set a device's type from what it reported about itself after a login.

    This replaces the scan's guess, and later scans do not overwrite it.
    """
    confirmed = classifier.classify_collected(version, vlans)
    device.device_type = confirmed["type"]
    device.type_reason = confirmed["reason"]
    device.type_source = Device.TYPE_FROM_COLLECTION
    session.commit()


def network_inventory(session: Session, allowed: list[IPv4Network] | None = None) -> list[Device]:
    """The devices to collect from: routers, switches and likely network devices.

    "network device" (a scan's guess from an SSH banner) is included so that
    a device's first collection can confirm it as a router or switch. Each is
    reached at its management IP, the address the scan last saw it at. Only
    addresses inside ALLOWED_SUBNETS are returned, one device per address
    (the most recently seen), ordered by IP.
    """
    devices = session.scalars(
        select(Device)
        .where(Device.device_type.in_(classifier.NETWORK_TYPES))
        .order_by(Device.last_seen.desc(), Device.id.desc())
    )
    by_ip: dict[str, Device] = {}
    for device in devices:
        try:
            discovery.check_allowed(IPv4Network(device.last_ip), allowed)
        except discovery.SubnetNotAllowedError:
            continue
        by_ip.setdefault(device.last_ip, device)
    return sorted(by_ip.values(), key=lambda device: IPv4Address(device.last_ip))


def record_success(
    session: Session, row: DeviceCollection, outcome: collector.DeviceData
) -> tuple[ConfigBackup, bool]:
    """Store what a collection read, confirm the device's type, back up its config.

    Returns (backup, created): the backup that now holds the device's config,
    and whether this collection stored it as a new one.
    """
    row.status = DeviceCollection.STATUS_SUCCESS
    row.error = None
    row.note = outcome.note
    row.data = outcome.data
    row.collected_at = utcnow()
    if row.device is not None:
        # The device answered its own show commands: this beats any scan guess.
        row.device.device_type = outcome.device_type
        row.device.type_reason = outcome.type_reason
        row.device.type_source = Device.TYPE_FROM_COLLECTION
    session.add(row)
    session.commit()

    backup, created = save_config_backup(session, row.host, outcome.config, device=row.device)
    previous = latest_backup(session, row.host, before_id=backup.id)
    row.config_backup_id = backup.id
    row.config_changed = created and previous is not None
    session.commit()
    return backup, created


def record_failure(session: Session, row: DeviceCollection, error: str) -> None:
    """Store why a device could not be collected from. Its type is left alone."""
    row.status = DeviceCollection.STATUS_FAILED
    row.error = error
    row.collected_at = utcnow()
    session.add(row)
    session.commit()


def collect_device(
    session: Session, device: Device, credentials: Credentials
) -> tuple[DeviceCollection, ConfigBackup, bool]:
    """Collect from one device now and store the result.

    Returns (collection, config backup, whether the backup is new). Raises
    the collector's own errors (unreachable, timeout, wrong credentials, SSH
    negotiation); nothing is stored in that case.
    """
    outcome = collector.collect_host(device.last_ip, credentials.username, credentials.password)
    row = DeviceCollection(device=device, host=device.last_ip)
    backup, created = record_success(session, row, outcome)
    return row, backup, created


def start_network_collection(
    session: Session, allowed: list[IPv4Network] | None = None
) -> NetworkCollection:
    """Record a new collection run with one pending result per device.

    Connects to nothing. Raises CollectionInProgressError if a run is still
    going and NoNetworkDevicesError if the inventory is empty.
    """
    with _start_lock:
        running = session.scalars(
            select(NetworkCollection)
            .where(NetworkCollection.status == NetworkCollection.STATUS_RUNNING)
            .limit(1)
        ).first()
        if running is not None:
            raise CollectionInProgressError(
                f"Collection #{running.id} is still running "
                f"(started {running.started_at:%Y-%m-%d %H:%M} UTC)."
            )
        devices = network_inventory(session, allowed)
        if not devices:
            raise NoNetworkDevicesError(
                "No device is classified as a router, switch or network device yet. "
                "Run a scan first; devices are recognised by their SSH banner."
            )
        run = NetworkCollection(status=NetworkCollection.STATUS_RUNNING)
        run.results = [
            DeviceCollection(
                device=device, host=device.last_ip, status=DeviceCollection.STATUS_PENDING
            )
            for device in devices
        ]
        session.add(run)
        session.commit()
    return run


def run_network_collection(
    session: Session,
    run: NetworkCollection,
    credentials_for_host: Callable[[str], Credentials],
    max_workers: int = MAX_PARALLEL_DEVICES,
) -> None:
    """Collect from every pending device of a run, a few at a time.

    Each device is read in its own worker thread, so a slow or unreachable
    device only holds up its own thread. The threads do nothing but talk to
    devices; every database write happens here, in the calling thread, as
    each device finishes. That keeps one writer on the database and makes
    each result visible as soon as it is in.
    """
    pending = [row for row in run.results if row.status == DeviceCollection.STATUS_PENDING]
    try:
        with ThreadPoolExecutor(max_workers=max_workers) as pool:
            futures = {}
            for row in pending:
                credentials = credentials_for_host(row.host)
                futures[
                    pool.submit(
                        collector.collect_host, row.host, credentials.username, credentials.password
                    )
                ] = row
            for future in as_completed(futures):
                row = futures[future]
                try:
                    outcome = future.result()
                except collector.CollectorError as exc:
                    record_failure(session, row, str(exc))
                except Exception as exc:
                    # A bug or an unexpected reply from one device must not
                    # take the other devices' results down with it.
                    session.rollback()
                    record_failure(session, row, f"Unexpected error: {type(exc).__name__}: {exc}")
                else:
                    record_success(session, row, outcome)
        run.status = NetworkCollection.STATUS_COMPLETED
    except BaseException:
        session.rollback()
        run.status = NetworkCollection.STATUS_FAILED
        raise
    finally:
        _close_run(session, run)


def _close_run(session: Session, run: NetworkCollection) -> None:
    for row in run.results:
        if row.status == DeviceCollection.STATUS_PENDING:
            row.status = DeviceCollection.STATUS_FAILED
            row.error = "Not collected: the run stopped before this device was reached."
    if run.status == NetworkCollection.STATUS_RUNNING:
        run.status = NetworkCollection.STATUS_FAILED
    run.finished_at = utcnow()
    session.commit()


def fail_interrupted_collections(session: Session) -> int:
    """Close runs still "running" at program start-up: a crash cut them off."""
    interrupted = session.scalars(
        select(NetworkCollection).where(NetworkCollection.status == NetworkCollection.STATUS_RUNNING)
    ).all()
    for run in interrupted:
        run.status = NetworkCollection.STATUS_FAILED
        _close_run(session, run)
    return len(interrupted)


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
