"""Discover the lab network, port-scan what was found, and classify each device.

Runs the three engine stages in order: ARP discovery -> Nmap service scan of
the discovered hosts only -> device classifier. Needs root for the ARP scan
(and it lets Nmap use a SYN scan). Run it with sudo and the venv's Python:
    sudo backend/.venv/bin/python -B backend/scripts/scan.py

Only subnets inside ALLOWED_SUBNETS (.env) can be scanned.
"""

import argparse
import os
import sys
from pathlib import Path

# Make the "app" package importable when this file is run as a script.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.engine import classifier, discovery, scanner  # noqa: E402

COLUMNS = ["IP address", "MAC address", "Vendor", "Open ports", "Type", "Reason"]


def to_row(device: dict) -> list[str]:
    ports = ", ".join(
        f"{port['port']}/{port['protocol']} {port['service']}".strip() for port in device["ports"]
    )
    return [
        device["ip"],
        device["mac"],
        device["vendor"],
        ports or "-",
        device["type"],
        device["reason"],
    ]


def print_table(rows: list[list[str]]) -> None:
    widths = [max(len(row[i]) for row in [COLUMNS, *rows]) for i in range(len(COLUMNS))]
    for row in [COLUMNS, ["-" * width for width in widths], *rows]:
        print("  ".join(cell.ljust(width) for cell, width in zip(row, widths)).rstrip())


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--subnet", help="CIDR to scan, e.g. 192.168.17.0/24 (default: detect)")
    parser.add_argument("--interface", help="interface to send from (default: detect)")
    parser.add_argument("--top-ports", type=int, default=100, help="how many common ports to scan")
    parser.add_argument("--host-timeout", type=int, default=60, help="seconds allowed per host")
    args = parser.parse_args()

    try:
        subnet, interface = discovery.resolve_target(args.subnet, args.interface)
        discovery.check_allowed(subnet)
        if os.geteuid() != 0:
            print(
                "ERROR: the ARP scan needs root. Run:\n"
                "  sudo backend/.venv/bin/python -B backend/scripts/scan.py",
                file=sys.stderr,
            )
            return 1

        print(f"1/3 ARP scanning {subnet} on {interface} ...")
        devices = discovery.arp_scan(str(subnet), interface)
        print(f"    {len(devices)} device(s) found.")
        if not devices:
            return 0

        print(f"2/3 Nmap scanning the top {args.top_ports} ports on those hosts ...")
        scans = scanner.scan_hosts(
            [device["ip"] for device in devices], args.top_ports, args.host_timeout
        )
        print("3/3 Classifying ...\n")
        combined = classifier.classify_all(devices, scans)
    except (discovery.DiscoveryError, scanner.ScannerError, ValueError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    print_table([to_row(device) for device in combined])
    return 0


if __name__ == "__main__":
    sys.exit(main())
