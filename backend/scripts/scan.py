"""Scan the lab network, save the results, and report what changed.

Runs ARP discovery -> Nmap service scan of the discovered hosts -> device
classifier, stores it all as one scan in the database, then compares it with
the previous scan. Needs root for the ARP scan (and it lets Nmap use a SYN
scan). Run it with sudo and the venv's Python:
    sudo backend/.venv/bin/python -B backend/scripts/scan.py

Create the database first, as your normal user (not with sudo):
    cd backend && .venv/bin/alembic upgrade head

Only subnets inside ALLOWED_SUBNETS (.env) can be scanned.
"""

import argparse
import sys
from pathlib import Path

# Make the "app" package importable when this file is run as a script.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy.orm import Session  # noqa: E402

from app.db.database import create_db_engine, is_migrated  # noqa: E402
from app.db.models import Scan  # noqa: E402
from app.engine import discovery, scanner  # noqa: E402
from app.services import scan_service  # noqa: E402


def print_table(columns: list[str], rows: list[list[str]]) -> None:
    widths = [max(len(row[i]) for row in [columns, *rows]) for i in range(len(columns))]
    for row in [columns, ["-" * width for width in widths], *rows]:
        print("  ".join(cell.ljust(width) for cell, width in zip(row, widths)).rstrip())


def print_results(scan: Scan) -> None:
    rows = []
    for result in scan.results:
        ports = ", ".join(
            f"{port['port']}/{port['protocol']} {port['service']}".strip()
            for port in result.open_ports
        )
        rows.append(
            [
                result.ip,
                result.device.mac,
                result.device.vendor,
                result.device.virtualization or "-",
                ports or "-",
                result.device_type,
                result.reason,
            ]
        )
    print_table(["IP address", "MAC address", "Vendor", "Virtual", "Open ports", "Type", "Reason"], rows)


def print_changes(report: scan_service.ChangeReport) -> None:
    if report.previous_scan_id is None:
        print("Changes: none to report. This is the first scan of this subnet (the baseline).")
        return
    print(f"Changes since scan #{report.previous_scan_id}:")
    if not report.has_changes:
        print("  No changes.")
        return
    for device in report.new_devices:
        print(f"  + NEW      {device['ip']:<15}  {device['mac']}  {device['vendor']} ({device['type']})")
    for device in report.missing_devices:
        print(f"  - MISSING  {device['ip']:<15}  {device['mac']}  {device['vendor']} ({device['type']})")
    for change in report.ip_changes:
        print(
            f"  ~ IP CHANGED  {change['old_ip']} -> {change['new_ip']}  "
            f"{change['mac']}  {change['vendor']}"
        )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--subnet", help="CIDR to scan, e.g. 192.168.17.0/24 (default: detect)")
    parser.add_argument("--interface", help="interface to send from (default: detect)")
    parser.add_argument("--top-ports", type=int, default=100, help="how many common ports to scan")
    parser.add_argument("--host-timeout", type=int, default=60, help="seconds allowed per host")
    args = parser.parse_args()

    engine = create_db_engine()
    if not is_migrated(engine):
        print(
            "ERROR: the database has not been created. Run, without sudo:\n"
            "  cd backend && .venv/bin/alembic upgrade head",
            file=sys.stderr,
        )
        return 1

    try:
        # Checked here as well as in the service, so a refused subnet is
        # reported before the root check.
        subnet, interface = discovery.resolve_target(args.subnet, args.interface)
        discovery.check_allowed(subnet)
        if not discovery.can_open_raw_socket():
            print(
                "ERROR: the ARP scan needs root or CAP_NET_RAW. Run:\n"
                "  sudo backend/.venv/bin/python -B backend/scripts/scan.py",
                file=sys.stderr,
            )
            return 1

        print(f"Scanning {subnet} on {interface}: ARP discovery, then Nmap on the hosts found ...")
        with Session(engine) as session:
            scan, report = scan_service.run_scan(
                session, str(subnet), interface, args.top_ports, args.host_timeout
            )
            print(f"Scan #{scan.id} saved: {len(scan.results)} device(s).\n")
            if scan.results:
                print_results(scan)
                print()
            print_changes(report)
    except (
        discovery.DiscoveryError,
        scanner.ScannerError,
        scan_service.ScanInProgressError,
        scan_service.ScanInterruptedError,
        ValueError,
    ) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
