"""Run every collector function against the lab switch and print the results.

Usage (from anywhere):
    backend/.venv/bin/python backend/scripts/collect_switch.py [--show-config]

Only read-only show commands are sent. The running config is summarised unless
--show-config is given, because it can contain password hashes.
"""

import argparse
import json
import sys
from pathlib import Path

# Make the "app" package importable when this file is run as a script.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.core.config import get_settings  # noqa: E402
from app.engine import collector  # noqa: E402


def print_section(title: str, data: collector.ParsedOutput) -> None:
    print(f"\n=== {title} ===")
    if isinstance(data, str):
        print("(TextFSM could not parse this output, showing raw text)")
        print(data)
    else:
        print(json.dumps(data, indent=2))
        print(f"({len(data)} entries)")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--show-config",
        action="store_true",
        help="print the full running config (may contain password hashes)",
    )
    args = parser.parse_args()

    settings = get_settings()
    print(f"Connecting to {settings.lab_switch_host} as {settings.lab_switch_username} ...")
    try:
        conn = collector.connect(
            host=settings.lab_switch_host,
            username=settings.lab_switch_username,
            password=settings.lab_switch_password.get_secret_value(),
        )
    except collector.CollectorError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    try:
        print(f"Connected. Prompt: {conn.find_prompt()}")
        print_section("show ip interface brief", collector.get_interfaces(conn))
        print_section("show vlan brief", collector.get_vlans(conn))
        print_section("show mac address-table", collector.get_mac_table(conn))
        print_section("show version", collector.get_version(conn))

        config = collector.get_running_config(conn)
        print("\n=== show running-config ===")
        if args.show_config:
            print(config)
        else:
            print(f"({len(config.splitlines())} lines collected, use --show-config to print)")
    except collector.CollectorError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    finally:
        conn.disconnect()
    return 0


if __name__ == "__main__":
    sys.exit(main())
