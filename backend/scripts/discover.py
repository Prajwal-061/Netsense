"""ARP-scan the lab network and print the devices found as a table.

Needs root for the raw socket. Run it with sudo and the venv's Python:
    sudo backend/.venv/bin/python -B backend/scripts/discover.py

The subnet and interface are detected from this machine's interfaces unless
given. Only subnets inside ALLOWED_SUBNETS (.env) can be scanned.
"""

import argparse
import os
import sys
from pathlib import Path

# Make the "app" package importable when this file is run as a script.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.engine import discovery  # noqa: E402


def print_table(devices: list[dict]) -> None:
    columns = [("IP address", "ip"), ("MAC address", "mac"), ("Vendor", "vendor")]
    widths = [
        max(len(title), *(len(device[key]) for device in devices)) for title, key in columns
    ]
    print("  ".join(title.ljust(width) for (title, _), width in zip(columns, widths)))
    print("  ".join("-" * width for width in widths))
    for device in devices:
        print("  ".join(device[key].ljust(width) for (_, key), width in zip(columns, widths)))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--subnet", help="CIDR to scan, e.g. 192.168.17.0/24 (default: detect)")
    parser.add_argument("--interface", help="interface to send from (default: detect)")
    parser.add_argument("--timeout", type=float, default=2, help="seconds to wait for replies")
    args = parser.parse_args()

    try:
        subnet, interface = discovery.resolve_target(args.subnet, args.interface)
        discovery.check_allowed(subnet)
        if os.geteuid() != 0:
            print(
                "ERROR: ARP scanning needs root. Run:\n"
                "  sudo backend/.venv/bin/python -B backend/scripts/discover.py",
                file=sys.stderr,
            )
            return 1
        print(f"ARP scanning {subnet} on {interface} (timeout {args.timeout:g}s) ...")
        devices = discovery.arp_scan(str(subnet), interface, args.timeout)
    except (discovery.DiscoveryError, ValueError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    if devices:
        print_table(devices)
    print(f"\n{len(devices)} device(s) found.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
