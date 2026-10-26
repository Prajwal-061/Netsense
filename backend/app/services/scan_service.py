"""Scan service: run the engine pipeline, save it as one scan, report changes.

The engine modules (discovery, scanner, classifier) know nothing about the
database, and the models know nothing about networking. This layer is the
only place the two meet.
"""

import os
import threading
from dataclasses import dataclass, field
from ipaddress import IPv4Network

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.db.models import Device, Scan, ScanResult, utcnow
from app.engine import classifier, discovery, scanner


# Held while checking for a running scan and creating the new one, so two
# requests arriving together cannot both pass the check. This protects one
# process; several API worker processes would need a database-level lock.
_start_lock = threading.Lock()


# Which step each running scan of this process is on, for the live progress
# view: {scan_id: {"step", "step_started_at", "hosts_found"}}. In memory
# only: it describes work in progress and is dropped when the scan ends.
_progress: dict[int, dict] = {}
_progress_lock = threading.Lock()

STEPS = ("discovery", "services", "saving")


def _set_step(scan_id: int, step: str, hosts_found: int | None = None) -> None:
    with _progress_lock:
        _progress[scan_id] = {"step": step, "step_started_at": utcnow(), "hosts_found": hosts_found}


def scan_progress(scan_id: int) -> dict | None:
    """The step a running scan is on, or None if this process is not running it."""
    with _progress_lock:
        entry = _progress.get(scan_id)
        return dict(entry) if entry else None


INTERRUPTED_MESSAGE = "Interrupted: the program stopped before the scan finished."


class ScanInterruptedError(Exception):
    """The scan was marked interrupted while it was still running; nothing was saved."""


class ScanInProgressError(Exception):
    """A scan is already running, so another one may not start."""


@dataclass
class ChangeReport:
    """How a scan differs from the previous completed scan of the same subnet."""

    scan_id: int
    # None when this is the first scan of the subnet: there is no baseline,
    # so every device is listed as new.
    previous_scan_id: int | None
    new_devices: list[dict] = field(default_factory=list)  # {"mac", "ip", "vendor", "type"}
    missing_devices: list[dict] = field(default_factory=list)  # same, with the last known IP
    ip_changes: list[dict] = field(default_factory=list)  # {"mac", "vendor", "old_ip", "new_ip"}

    @property
    def has_changes(self) -> bool:
        return bool(self.new_devices or self.missing_devices or self.ip_changes)


def save_results(session: Session, scan: Scan, devices: list[dict]) -> None:
    """Store classified devices ({"ip", "mac", "vendor", "ports", "type",
    "reason", "virtualization"}) as the results of a scan, creating or
    updating each Device."""
    seen_at = utcnow()
    saved_macs = set()
    for found in devices:
        mac = found["mac"].lower()
        # One device can answer ARP for several IPs (secondary addresses).
        # A scan holds one result per device, so only the first is kept.
        if mac in saved_macs:
            continue
        saved_macs.add(mac)

        # The MAC is the identity: look the device up by it, whatever its IP.
        device = session.scalars(select(Device).where(Device.mac == mac)).first()
        if device is None:
            device = Device(mac=mac, first_seen=seen_at)
            session.add(device)
        device.last_seen = seen_at
        device.last_ip = found["ip"]
        device.vendor = found["vendor"]
        device.virtualization = found.get("virtualization")
        # A type confirmed by logging in to the device outranks a guess from
        # a scan, so the device keeps it. The scan's own guess is still
        # recorded below, in this scan's result.
        if device.type_source != Device.TYPE_FROM_COLLECTION:
            device.device_type = found["type"]
            device.type_reason = found["reason"]
            device.type_source = Device.TYPE_FROM_SCAN

        scan.results.append(
            ScanResult(
                device=device,
                ip=found["ip"],
                open_ports=found["ports"],
                device_type=found["type"],
                reason=found["reason"],
            )
        )


def previous_scan(session: Session, scan: Scan) -> Scan | None:
    """The most recent completed scan of the same subnet before this one."""
    return session.scalars(
        select(Scan)
        .where(
            Scan.subnet == scan.subnet,
            Scan.status == Scan.STATUS_COMPLETED,
            Scan.id < scan.id,
        )
        .order_by(Scan.id.desc())
        .limit(1)
    ).first()


def _describe(result: ScanResult) -> dict:
    return {
        "mac": result.device.mac,
        "ip": result.ip,
        "vendor": result.device.vendor,
        "type": result.device_type,
    }


def compare_scans(scan: Scan, previous: Scan | None) -> ChangeReport:
    """Work out what changed between two scans, matching devices by MAC."""
    current = {result.device_id: result for result in scan.results}
    before = {result.device_id: result for result in previous.results} if previous else {}

    report = ChangeReport(scan_id=scan.id, previous_scan_id=previous.id if previous else None)
    for device_id, result in current.items():
        if device_id not in before:
            report.new_devices.append(_describe(result))
        elif before[device_id].ip != result.ip:
            report.ip_changes.append(
                {
                    "mac": result.device.mac,
                    "vendor": result.device.vendor,
                    "old_ip": before[device_id].ip,
                    "new_ip": result.ip,
                }
            )
    for device_id, result in before.items():
        if device_id not in current:
            report.missing_devices.append(_describe(result))
    return report


def change_report(session: Session, scan: Scan) -> ChangeReport | None:
    """The change report for a scan, or None if the scan did not complete."""
    if scan.status != Scan.STATUS_COMPLETED:
        return None
    return compare_scans(scan, previous_scan(session, scan))


def start_scan(
    session: Session,
    subnet: str | None = None,
    interface: str | None = None,
    allowed: list[IPv4Network] | None = None,
) -> tuple[Scan, str]:
    """Record a new scan as "running" and return it with the interface to use.

    Sends nothing. The subnet and interface are detected when not given.
    Raises SubnetNotAllowedError for a subnet outside ALLOWED_SUBNETS and
    ScanInProgressError if another scan is still running.
    """
    network, interface = discovery.resolve_target(subnet, interface, allowed)
    discovery.check_allowed(network, allowed)

    with _start_lock:
        running = session.scalars(
            select(Scan).where(Scan.status == Scan.STATUS_RUNNING).limit(1)
        ).first()
        if running is not None:
            raise ScanInProgressError(
                f"Scan #{running.id} is still running (started {running.started_at:%Y-%m-%d %H:%M} UTC)."
            )
        # Committed before any packet is sent, so an interrupted scan still
        # leaves a record of when it started.
        scan = Scan(subnet=str(network), status=Scan.STATUS_RUNNING, pid=os.getpid())
        session.add(scan)
        session.commit()
    return scan, interface


def execute_scan(
    session: Session,
    scan: Scan,
    interface: str,
    top_ports: int = 100,
    host_timeout: int = 60,
    allowed: list[IPv4Network] | None = None,
) -> ChangeReport:
    """Run the pipeline for a scan created by start_scan and save its results.

    Raises the engine's own errors (DiscoveryError, ScannerError); the scan
    is then left in the database with status "failed" and the error message.
    """
    try:
        _set_step(scan.id, "discovery")
        devices = discovery.arp_scan(scan.subnet, interface, allowed=allowed)
        _set_step(scan.id, "services", len(devices))
        scans = scanner.scan_hosts(
            [device["ip"] for device in devices], top_ports, host_timeout, allowed
        )
        _set_step(scan.id, "saving", len(devices))
        save_results(session, scan, classifier.classify_all(devices, scans))
        if not _finish(session, scan, Scan.STATUS_COMPLETED):
            # Marked interrupted meanwhile: that stays, and so does "all or nothing".
            session.rollback()
            raise ScanInterruptedError(
                f"Scan #{scan.id} was marked interrupted before it finished; its results were not saved."
            )
        # One commit for all results: a scan is saved completely or not at all.
        session.commit()
    except ScanInterruptedError:
        raise
    except BaseException as exc:
        # BaseException so that Ctrl-C also ends the scan instead of leaving
        # it "running" forever and blocking every later scan.
        session.rollback()
        if isinstance(exc, (KeyboardInterrupt, SystemExit)):
            _finish(session, scan, Scan.STATUS_INTERRUPTED, INTERRUPTED_MESSAGE)
        else:
            _finish(session, scan, Scan.STATUS_FAILED, str(exc) or type(exc).__name__)
        session.commit()
        raise
    finally:
        with _progress_lock:
            _progress.pop(scan.id, None)
        # The final status was written with a plain UPDATE: reload it on next access.
        session.expire(scan)

    return compare_scans(scan, previous_scan(session, scan))


def run_scan(
    session: Session,
    subnet: str | None = None,
    interface: str | None = None,
    top_ports: int = 100,
    host_timeout: int = 60,
    allowed: list[IPv4Network] | None = None,
) -> tuple[Scan, ChangeReport]:
    """Start a scan and run it to the end: discover, port-scan, classify, save."""
    scan, interface = start_scan(session, subnet, interface, allowed)
    return scan, execute_scan(session, scan, interface, top_ports, host_timeout, allowed)


def _finish(session: Session, scan: Scan, status: str, error: str | None = None) -> bool:
    """Move a running scan to its final status, in the current transaction.

    Only a scan that is still "running" changes, checked and changed in one
    UPDATE, so a scan another process has marked interrupted is never turned
    into "completed" (or "failed") afterwards. Returns whether it changed.
    """
    values = {"status": status, "finished_at": utcnow()}
    if error is not None:
        values["error"] = error
    result = session.execute(
        update(Scan)
        .where(Scan.id == scan.id, Scan.status == Scan.STATUS_RUNNING)
        .values(**values)
        .execution_options(synchronize_session=False)
    )
    return result.rowcount == 1


def _process_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)  # signal 0: only checks that the process exists
    except ProcessLookupError:
        return False
    except PermissionError:
        return True  # exists, but belongs to another user
    return True


def mark_interrupted_scans(session: Session) -> int:
    """Mark "running" scans whose process is gone as interrupted; return how many.

    For program start-up. A scan whose process still runs (a scan script, or
    the old API process while --reload replaces it) is left alone: it will
    finish by itself. Scans from before the pid was recorded count as gone.
    """
    running = session.scalars(select(Scan).where(Scan.status == Scan.STATUS_RUNNING)).all()
    interrupted = [scan for scan in running if scan.pid is None or not _process_alive(scan.pid)]
    for scan in interrupted:
        _finish(session, scan, Scan.STATUS_INTERRUPTED, INTERRUPTED_MESSAGE)
    session.commit()
    return len(interrupted)
