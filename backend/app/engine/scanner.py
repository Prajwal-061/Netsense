"""Service scanner: find open ports and the services behind them with Nmap.

Nmap is run as a subprocess with XML output (-oX -), which is then parsed.
The XML format is stable and machine-readable; the normal text output is not.
"""

import os
import subprocess
import sys
import xml.etree.ElementTree as ET
from ipaddress import IPv4Address, IPv4Network
from pathlib import Path

from app.engine import discovery

_PASS_CAPS = Path(__file__).with_name("pass_caps.py")


class ScannerError(Exception):
    """Nmap could not be run, failed, or took too long."""


def _nmap_prefix() -> list[str]:
    """How to start Nmap, and with which scan type, for this process's privileges.

    A SYN scan needs a raw socket. There are three cases:
      - root: Nmap can simply do it.
      - not root, but this Python holds CAP_NET_RAW: Nmap is a separate
        program and would not inherit the capability, so it is started
        through pass_caps.py, which hands the capability on to it.
        --privileged tells Nmap to use raw sockets although it is not root.
      - neither: a connect scan, which uses the normal socket API.
    """
    if os.geteuid() == 0:
        return ["nmap", "-sS"]
    if discovery.can_open_raw_socket():
        # -I: isolated mode, so the launcher ignores PYTHON* environment
        # variables and the user's site-packages.
        return [sys.executable, "-I", str(_PASS_CAPS), "nmap", "--privileged", "-sS"]
    return ["nmap", "-sT"]


def _build_command(ips: list[str], top_ports: int, host_timeout: int) -> list[str]:
    return [
        *_nmap_prefix(),
        "-sV",  # probe open ports to identify the service, product and version
        "--top-ports", str(top_ports),  # the N most commonly open ports
        "-Pn",  # skip Nmap's own host discovery: ARP already proved the hosts are up
        "-n",  # no reverse DNS lookups
        "--host-timeout", f"{host_timeout}s",  # give up on a host after this long
        "-oX", "-",  # XML output to stdout
        *ips,
    ]


def parse_nmap_xml(xml_text: str) -> list[dict]:
    """Turn Nmap's XML into one dict per host, keeping only open ports."""
    hosts = []
    for host in ET.fromstring(xml_text).iter("host"):
        address = host.find("address[@addrtype='ipv4']")
        if address is None:
            continue
        ports = []
        for port in host.iter("port"):
            if port.find("state").get("state") != "open":
                continue
            # <service> attributes are only present when -sV identified them.
            service = port.find("service")
            if service is None:
                service = ET.Element("service")
            ports.append(
                {
                    "port": int(port.get("portid")),
                    "protocol": port.get("protocol"),
                    "service": service.get("name", ""),
                    "product": service.get("product", ""),
                    "version": service.get("version", ""),
                    "extra_info": service.get("extrainfo", ""),
                    "os_type": service.get("ostype", ""),
                }
            )
        hosts.append(
            {
                "ip": address.get("addr"),
                "ports": ports,
                # Nmap sets timedout="true" when --host-timeout cut the host short.
                "timed_out": host.get("timedout") == "true",
            }
        )
    return hosts


def scan_hosts(
    ips: list[str],
    top_ports: int = 100,
    host_timeout: int = 60,
    allowed: list[IPv4Network] | None = None,
) -> list[dict]:
    """Scan hosts for open TCP ports and identify the services on them.

    Takes IP addresses (normally from discovery.arp_scan) and returns, in the
    same order, [{"ip", "ports": [{"port", "protocol", "service", "product",
    "version", "extra_info", "os_type"}], "timed_out"}, ...].

    Refuses (SubnetNotAllowedError) if any IP is outside ALLOWED_SUBNETS.
    Uses a SYN scan as root or with CAP_NET_RAW, and a connect scan otherwise.
    """
    # IPv4Address() rejects anything that is not a plain address, so nothing
    # from the list can reach Nmap's command line as an option or a range.
    targets = [str(IPv4Address(ip)) for ip in ips]
    for target in targets:
        discovery.check_allowed(IPv4Network(target), allowed)
    if not targets:
        return []

    command = _build_command(targets, top_ports, host_timeout)
    try:
        # Backstop in case Nmap itself hangs: --host-timeout should end the
        # scan long before this.
        result = subprocess.run(
            command, capture_output=True, text=True, timeout=host_timeout * len(targets) + 30
        )
    except FileNotFoundError as exc:
        raise ScannerError("Nmap is not installed (sudo apt install nmap).") from exc
    except subprocess.TimeoutExpired as exc:
        raise ScannerError(f"Nmap did not finish within {exc.timeout:g}s and was stopped.") from exc
    if result.returncode != 0:
        raise ScannerError(f"Nmap failed: {result.stderr.strip() or 'no error output'}")

    try:
        found = {host["ip"]: host for host in parse_nmap_xml(result.stdout)}
    except ET.ParseError as exc:
        raise ScannerError(f"Could not parse Nmap's XML output: {exc}") from exc
    # One entry per requested IP, even if Nmap reported nothing for it.
    return [found.get(ip, {"ip": ip, "ports": [], "timed_out": False}) for ip in targets]
