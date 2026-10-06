"""Device classifier: guess what a device is from discovery and scan results.

These are rule-based guesses, not facts, so every guess comes with its reason.
Rules run from the strongest evidence to the weakest: what the device says
about itself in a service banner, then which services it offers, then the
vendor of its MAC address (which says who made the network card, and nothing
at all when the MAC is locally administered).
"""

import re

NETWORK_DEVICE = "network device"
SERVER = "server"
LINUX_HOST = "Linux host"
VIRTUAL = "VMware/virtual"
UNKNOWN = "unknown"

# \b = word boundary, so "ios" matches "IOS" but not "BIOS".
_NETWORK_OS = re.compile(
    r"\b(cisco|ios|ios-xe|nx-os|juniper|junos|arista|mikrotik|routeros|fortinet)\b", re.I
)
_LINUX = re.compile(r"\b(linux|ubuntu|debian|centos|red hat|fedora|raspbian)\b", re.I)
_VIRTUAL_VENDOR = re.compile(r"\b(vmware|virtualbox|qemu|xensource|parallels)\b", re.I)

# Nmap service names that mean "this machine serves something to others".
# SSH is left out: almost everything manageable runs it.
_SERVER_SERVICES = {
    "http", "https", "http-proxy", "ftp", "smtp", "domain", "pop3", "imap",
    "ldap", "mysql", "postgresql", "ms-sql-s", "nfs", "redis", "mongodb",
}  # fmt: skip


def _banner(port: dict) -> str:
    """What -sV learned about a port, e.g. 'Cisco SSH 1.25'."""
    return " ".join(part for part in (port["product"], port["version"]) if part)


def classify(device: dict, scan: dict | None = None) -> dict:
    """Return {"type", "reason"} for one device.

    device is a discovery result ({"ip", "mac", "vendor"}) and scan is the
    scanner result for the same IP ({"ports": [...]}), if there is one.
    """
    ports = scan["ports"] if scan else []
    vendor = device.get("vendor", "")

    for port in ports:
        if _NETWORK_OS.search(f"{port['product']} {port['os_type']}"):
            os_note = f", OS {port['os_type']}" if port["os_type"] else ""
            return {
                "type": NETWORK_DEVICE,
                "reason": f"{port['service']} banner on port {port['port']} is "
                f"'{_banner(port)}'{os_note}",
            }
    if _NETWORK_OS.search(vendor):
        return {"type": NETWORK_DEVICE, "reason": f"MAC vendor is {vendor}"}

    served = [port for port in ports if port["service"] in _SERVER_SERVICES]
    if served:
        services = ", ".join(f"{port['service']} ({port['port']})" for port in served)
        return {"type": SERVER, "reason": f"offers server services: {services}"}

    for port in ports:
        text = f"{port['product']} {port['version']} {port['extra_info']} {port['os_type']}"
        if _LINUX.search(text):
            return {
                "type": LINUX_HOST,
                "reason": f"{port['service']} banner on port {port['port']} is "
                f"'{_banner(port)}', which reports Linux",
            }

    if _VIRTUAL_VENDOR.search(vendor):
        return {"type": VIRTUAL, "reason": f"MAC vendor is {vendor}"}

    if scan and scan.get("timed_out"):
        return {"type": UNKNOWN, "reason": "port scan timed out before it finished"}
    found = f"{len(ports)} open port(s) with no recognisable banner" if ports else "no open ports found"
    return {"type": UNKNOWN, "reason": f"{found}, and MAC vendor '{vendor}' gives no hint"}


def classify_all(devices: list[dict], scans: list[dict]) -> list[dict]:
    """Merge discovery and scan results into one dict per device, with a guess.

    Returns [{"ip", "mac", "vendor", "ports", "type", "reason"}, ...] in the
    order of devices.
    """
    scans_by_ip = {scan["ip"]: scan for scan in scans}
    combined = []
    for device in devices:
        scan = scans_by_ip.get(device["ip"])
        combined.append(
            {
                **device,
                "ports": scan["ports"] if scan else [],
                **classify(device, scan),
            }
        )
    return combined
