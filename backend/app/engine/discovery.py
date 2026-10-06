"""Discovery engine: find devices on the local network with an ARP scan (Scapy).

ARP only works inside one Layer 2 segment, so a scan can only find devices on
a network this machine is directly connected to. Sending the packets needs
root, because they are built by hand and written to a raw socket.
"""

import json
import subprocess
from ipaddress import IPv4Interface, IPv4Network

from scapy.config import conf
from scapy.layers.l2 import ARP, Ether, srp

from app.core.config import get_settings

BROADCAST_MAC = "ff:ff:ff:ff:ff:ff"


class DiscoveryError(Exception):
    """Base class for every error raised by discovery."""


class SubnetNotAllowedError(DiscoveryError):
    """The requested subnet is not inside any network in ALLOWED_SUBNETS."""


def local_networks() -> list[tuple[str, IPv4Network]]:
    """Return (interface, network) for each IPv4 address on this machine.

    Reads the same data as 'ip addr'. Loopback is skipped. No root needed.
    """
    output = subprocess.run(
        ["ip", "-j", "-4", "addr", "show"], capture_output=True, text=True, check=True
    ).stdout
    networks = []
    for link in json.loads(output):
        if "LOOPBACK" in link.get("flags", []):
            continue
        for addr in link.get("addr_info", []):
            # IPv4Interface("192.168.17.132/24").network -> 192.168.17.0/24:
            # the address ANDed with the mask, as in subnetting by hand.
            interface = IPv4Interface(f"{addr['local']}/{addr['prefixlen']}")
            networks.append((link["ifname"], interface.network))
    return networks


def _is_allowed(subnet: IPv4Network, allowed: list[IPv4Network]) -> bool:
    return any(subnet.subnet_of(network) for network in allowed)


def check_allowed(subnet: IPv4Network, allowed: list[IPv4Network] | None = None) -> None:
    """Raise SubnetNotAllowedError unless subnet is inside an allowed network."""
    if allowed is None:
        allowed = get_settings().allowed_subnets
    if not _is_allowed(subnet, allowed):
        permitted = ", ".join(str(network) for network in allowed) or "none"
        raise SubnetNotAllowedError(
            f"Refusing to scan {subnet}: not in ALLOWED_SUBNETS ({permitted})."
        )


def resolve_target(
    subnet: str | None = None,
    interface: str | None = None,
    allowed: list[IPv4Network] | None = None,
) -> tuple[IPv4Network, str]:
    """Work out which subnet to scan and which interface to send from.

    Anything passed in explicitly is used as given. Whatever is missing is
    filled in from this machine's own interfaces:
      - no subnet, no interface: the first local network in ALLOWED_SUBNETS
      - subnet only: the interface that is connected to that subnet
      - interface only: the network configured on that interface
    """
    if allowed is None:
        allowed = get_settings().allowed_subnets
    network = IPv4Network(subnet) if subnet else None
    if network and interface:
        return network, interface

    local = local_networks()
    if network:
        for name, local_network in local:
            if network.subnet_of(local_network):
                return network, name
        raise DiscoveryError(
            f"No interface on this machine is connected to {network}. ARP cannot "
            "cross a router, so only directly connected networks can be scanned."
        )
    if interface:
        for name, local_network in local:
            if name == interface:
                return local_network, name
        raise DiscoveryError(f"Interface {interface} has no IPv4 address.")
    for name, local_network in local:
        if _is_allowed(local_network, allowed):
            return local_network, name
    raise DiscoveryError(
        "None of this machine's networks are in ALLOWED_SUBNETS, so there is nothing to scan."
    )


def lookup_vendor(mac: str) -> str:
    """Return the manufacturer that owns a MAC address's OUI, looked up offline.

    The first 3 bytes of a MAC are the OUI, a prefix the IEEE assigns to one
    manufacturer. Scapy bundles a copy of Wireshark's OUI list, so no internet
    is needed.
    """
    # Bit 1 of the first byte set = "locally administered": the address was
    # made up by software (VMs, lab images, phone MAC randomisation), so its
    # prefix is not a registered OUI.
    if int(mac.split(":")[0], 16) & 0b10:
        return "Locally administered"
    vendor = conf.manufdb.lookup(mac)[1]
    # Scapy returns the MAC itself when the OUI is not in its list.
    return "Unknown" if vendor == mac else vendor


def arp_scan(
    subnet: str,
    interface: str,
    timeout: float = 2,
    allowed: list[IPv4Network] | None = None,
) -> list[dict]:
    """ARP-scan a subnet and return [{"ip", "mac", "vendor"}, ...] sorted by IP.

    Refuses (SubnetNotAllowedError) any subnet outside ALLOWED_SUBNETS. Needs root.
    """
    network = IPv4Network(subnet)
    check_allowed(network, allowed)

    # One frame per address in the subnet: an Ethernet broadcast carrying the
    # ARP question "who has <ip>?". Scapy expands pdst="x.x.x.0/24" itself.
    request = Ether(dst=BROADCAST_MAC) / ARP(pdst=str(network))
    try:
        # srp = send and receive at Layer 2. Returns (answered, unanswered).
        answered, _ = srp(request, iface=interface, timeout=timeout, verbose=False)
    except PermissionError as exc:
        raise DiscoveryError(
            "ARP scanning needs root: sending hand-built Ethernet frames uses a "
            "raw socket. Run with sudo and the venv's Python."
        ) from exc

    # Each answer is a (sent, received) pair. In the ARP reply, psrc/hwsrc are
    # the replying device's IP and MAC. Keyed by IP to drop duplicate replies.
    devices = {}
    for _, reply in answered:
        mac = reply[ARP].hwsrc.lower()
        devices[reply[ARP].psrc] = {
            "ip": reply[ARP].psrc,
            "mac": mac,
            "vendor": lookup_vendor(mac),
        }
    return sorted(devices.values(), key=lambda device: IPv4Network(device["ip"]).network_address)
