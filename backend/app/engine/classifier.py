"""Device classifier: work out what a device is, and say why.

Two separate questions are answered separately:

  - What is it?  The device type, decided by the strongest evidence available:
      1. a successful login (classify_collected): the device's own
         "show version" output. Not a guess.
      2. a network-OS service fingerprint, such as a Cisco SSH banner
      3. server services on offer (HTTP, databases, ...)
      4. a banner that names Linux, or a plain OpenSSH banner
      5. the vendor of the MAC address, when it is a network equipment maker
      6. nothing usable: unknown
    Levels 2 to 6 are guesses from a scan (classify), so each comes with its
    reason.

  - How is it hosted?  The virtualisation platform, read from the MAC address
    prefix. A virtual router and a virtual Linux host can both have a
    QEMU/KVM address, so this never decides the type.
"""

import re

from app.engine import discovery

ROUTER = "router"
SWITCH = "switch"
NETWORK_DEVICE = "network device"  # from a scan: which kind is not known yet
SERVER = "server"
LINUX_HOST = "Linux/Unix host"
UNKNOWN = "unknown"

# Types that may be logged in to with the collector.
NETWORK_TYPES = (NETWORK_DEVICE, ROUTER, SWITCH)

# \b = word boundary, so "ios" matches "IOS" but not "BIOS".
_NETWORK_OS = re.compile(
    r"\b(cisco|ios|ios-xe|nx-os|juniper|junos|arista|mikrotik|routeros|fortinet)\b", re.I
)
_LINUX = re.compile(r"\b(linux|ubuntu|debian|centos|red hat|fedora|raspbian|alpine)\b", re.I)

# Nmap service names that mean "this machine serves something to others".
# SSH is left out: almost everything manageable runs it.
_SERVER_SERVICES = {
    "http", "https", "http-proxy", "ftp", "smtp", "domain", "pop3", "imap",
    "ldap", "mysql", "postgresql", "ms-sql-s", "nfs", "redis", "mongodb",
}  # fmt: skip

# In "show version": an image or model name that marks a switch. "L2" must
# stand alone between separators, as in X86_64BI_LINUX_L2-ADVENTERPRISEK9-M.
_SWITCH_IMAGE = re.compile(
    r"(?:^|[_\-\s])l2(?:$|[_\-\s])|lanbase|lanlite|catalyst|nexus|\bws-c|switch", re.I
)


def _banner(port: dict) -> str:
    """What -sV learned about a port, e.g. 'Cisco SSH 1.25'."""
    return " ".join(part for part in (port["product"], port["version"]) if part)


def classify(device: dict, scan: dict | None = None) -> dict:
    """Guess a device's type from scan evidence.

    device is a discovery result ({"ip", "mac", "vendor"}) and scan is the
    scanner result for the same IP ({"ports": [...]}), if there is one.
    Returns {"type", "reason", "virtualization"}; virtualization is the
    platform name or None, and plays no part in choosing the type.
    """
    guess = _classify(device.get("vendor", ""), scan)
    guess["virtualization"] = discovery.lookup_virtualization(device["mac"])
    return guess


def _classify(vendor: str, scan: dict | None) -> dict:
    ports = scan["ports"] if scan else []

    # 2. A service that identifies itself as a network operating system.
    #    Only fields Nmap got by probing the service are used, never the
    #    port number alone.
    for port in ports:
        if _NETWORK_OS.search(f"{port['product']} {port['os_type']} {port['extra_info']}"):
            os_note = f", OS {port['os_type']}" if port["os_type"] else ""
            return {
                "type": NETWORK_DEVICE,
                "reason": f"{port['service']} banner on port {port['port']} is "
                f"'{_banner(port)}'{os_note}",
            }

    # 3. Server services.
    served = [port for port in ports if port["service"] in _SERVER_SERVICES]
    if served:
        services = ", ".join(f"{port['service']} ({port['port']})" for port in served)
        return {"type": SERVER, "reason": f"offers server services: {services}"}

    # 4. A banner that names Linux, then a plain OpenSSH banner.
    for port in ports:
        text = f"{port['product']} {port['version']} {port['extra_info']} {port['os_type']}"
        if _LINUX.search(text):
            return {
                "type": LINUX_HOST,
                "reason": f"{port['service']} banner on port {port['port']} is "
                f"'{_banner(port)}', which reports Linux",
            }
    for port in ports:
        # A plain OpenSSH banner names no OS. OpenSSH is the standard SSH
        # server on Linux, the BSDs and macOS, so that is the likely family.
        # The Windows build identifies itself as "OpenSSH for_Windows".
        if port["product"] == "OpenSSH" and "windows" not in port["version"].lower():
            return {
                "type": LINUX_HOST,
                "reason": f"{port['service']} banner on port {port['port']} is "
                f"'{_banner(port)}', which suggests Linux/Unix",
            }

    # 5. Only now the MAC vendor: it names who made the network card, which
    #    is a hint at best, so any service evidence above outranks it.
    if _NETWORK_OS.search(vendor):
        return {"type": NETWORK_DEVICE, "reason": f"MAC vendor is {vendor}"}

    # 6. Nothing to go on.
    if scan and scan.get("timed_out"):
        return {"type": UNKNOWN, "reason": "port scan timed out before it finished"}
    found = f"{len(ports)} open port(s) with no recognisable banner" if ports else "no open ports found"
    return {
        "type": UNKNOWN,
        "reason": f"{found}, and MAC vendor '{vendor}' does not indicate a device type",
    }


def classify_collected(version, vlans=None) -> dict:
    """Classify a device that was logged in to, from its own show commands.

    This is the most reliable classification: the device answered Cisco IOS
    show commands over an authenticated session, so it is a network device,
    and "show version" says which kind. version and vlans are the collector's
    outputs: a list of dicts when TextFSM parsed them, otherwise raw text.
    Returns {"type", "reason"} with type ROUTER or SWITCH.
    """
    if isinstance(version, list) and version:
        row = version[0]
        hardware = row.get("hardware") or []
        image = row.get("software_image", "")
        described = " ".join([image, row.get("running_image", ""), *hardware])
        name = f"software image '{image}'" if image else "this device"
    else:
        described = version if isinstance(version, str) else ""
        name = "this device"

    if _SWITCH_IMAGE.search(described):
        return {
            "type": SWITCH,
            "reason": f"confirmed by login: show version reports {name}, a switch image",
        }
    # A switch keeps a VLAN table. On a router "show vlan brief" is not a
    # valid command, so it comes back as unparsed text.
    if isinstance(vlans, list) and vlans:
        return {
            "type": SWITCH,
            "reason": f"confirmed by login: show version reports {name}, and "
            f"show vlan brief lists {len(vlans)} VLANs",
        }
    return {
        "type": ROUTER,
        "reason": f"confirmed by login: show version reports {name}, with no "
        "switch image and no VLAN table",
    }


def classify_all(devices: list[dict], scans: list[dict]) -> list[dict]:
    """Merge discovery and scan results into one dict per device, with a guess.

    Returns [{"ip", "mac", "vendor", "ports", "type", "reason",
    "virtualization"}, ...] in the order of devices.
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
