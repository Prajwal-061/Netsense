"""Scan service: run the engine pipeline, save it as one scan, report changes.

The engine modules (discovery, scanner, classifier) know nothing about the
database, and the models know nothing about networking. This layer is the
only place the two meet.
"""

from dataclasses import dataclass, field
from ipaddress import IPv4Network

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import Device, Scan, ScanResult, utcnow
from app.engine import classifier, discovery, scanner


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
    "reason"}) as the results of a scan, creating or updating each Device."""
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
        device.device_type = found["type"]

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


def run_scan(
    session: Session,
    subnet: str | None = None,
    interface: str | None = None,
    top_ports: int = 100,
    host_timeout: int = 60,
    allowed: list[IPv4Network] | None = None,
) -> tuple[Scan, ChangeReport]:
    """Discover, port-scan and classify a subnet, save it, and report changes.

    The subnet and interface are detected when not given. Raises the engine's
    own errors (DiscoveryError, ScannerError); a scan that had already started
    is then left in the database with status "failed".
    """
    network, interface = discovery.resolve_target(subnet, interface, allowed)
    discovery.check_allowed(network, allowed)

    # Committed before any packet is sent, so an interrupted scan still
    # leaves a record of when it started.
    scan = Scan(subnet=str(network), status=Scan.STATUS_RUNNING)
    session.add(scan)
    session.commit()

    try:
        devices = discovery.arp_scan(str(network), interface, allowed=allowed)
        scans = scanner.scan_hosts(
            [device["ip"] for device in devices], top_ports, host_timeout, allowed
        )
        save_results(session, scan, classifier.classify_all(devices, scans))
        scan.status = Scan.STATUS_COMPLETED
        scan.finished_at = utcnow()
        # One commit for all results: a scan is saved completely or not at all.
        session.commit()
    except Exception as exc:
        session.rollback()
        scan.status = Scan.STATUS_FAILED
        scan.finished_at = utcnow()
        scan.error = str(exc)
        session.commit()
        raise

    return scan, compare_scans(scan, previous_scan(session, scan))
