"""Device collector: SSH into a Cisco IOS device with Netmiko and return its state.

Every command sent from this module is a read-only "show" command.
"""

import socket
from dataclasses import dataclass, field

from netmiko import ConnectHandler
from netmiko.base_connection import BaseConnection
from netmiko.exceptions import (
    NetmikoAuthenticationException,
    NetmikoTimeoutException,
    ReadTimeout,
)

from app.engine import classifier

# What a parsed command returns: a list of dicts when TextFSM has a matching
# template, or the raw CLI text when it does not.
ParsedOutput = list[dict] | str


class CollectorError(Exception):
    """Base class for every error raised by the collector."""


class DeviceUnreachableError(CollectorError):
    """The device actively could not be reached (refused, no route, bad name)."""


class DeviceTimeoutError(CollectorError):
    """The device did not answer in time."""


class DeviceAuthenticationError(CollectorError):
    """The device was reached but rejected the username or password."""


class DeviceSshError(CollectorError):
    """The device and this client could not agree on SSH algorithms."""


@dataclass(frozen=True)
class Command:
    key: str  # name the output is stored under
    command: str
    scope: str  # "all", "switch" or "router"


# Everything collected from a device. Each device type only gets the commands
# that exist on it: a router rejects "show vlan brief" as invalid input.
COMMANDS = (
    Command("version", "show version", "all"),
    Command("interfaces", "show ip interface brief", "all"),
    Command("cdp_neighbors", "show cdp neighbors detail", "all"),
    Command("arp", "show ip arp", "all"),
    Command("vlans", "show vlan brief", "switch"),
    Command("trunks", "show interfaces trunk", "switch"),
    Command("spanning_tree", "show spanning-tree", "switch"),
    Command("mac_table", "show mac address-table", "switch"),
    Command("routes", "show ip route", "router"),
    Command("ospf_neighbors", "show ip ospf neighbor", "router"),
    Command("ospf_interfaces", "show ip ospf interface brief", "router"),
)
DATA_KINDS = tuple(command.key for command in COMMANDS)

# Host key types that rely on SHA-1, which modern SSH considers broken.
_LEGACY_HOST_KEYS = ("ssh-rsa", "ssh-dss")


@dataclass
class DeviceData:
    """Everything one collection read from one device."""

    device_type: str  # classifier.ROUTER or classifier.SWITCH
    type_reason: str
    data: dict[str, ParsedOutput] = field(default_factory=dict)  # by Command.key
    config: str = ""
    note: str | None = None  # something worth telling the user, e.g. weak SSH


def _check_tcp(host: str, port: int, timeout: float) -> None:
    """Open and close a TCP connection to tell 'unreachable' from 'timeout'.

    Netmiko reports every TCP-level failure as one exception, so this probe
    runs first to find out which failure it actually was.
    """
    try:
        socket.create_connection((host, port), timeout=timeout).close()
    except TimeoutError as exc:
        # No reply to the TCP SYN at all: packets are being dropped somewhere.
        raise DeviceTimeoutError(
            f"Timeout: {host} did not answer on TCP port {port} within {timeout:g}s "
            "(host down, or a firewall/ACL silently dropping packets)."
        ) from exc
    except OSError as exc:
        # An immediate failure: TCP RST (port closed), ICMP unreachable / failed
        # ARP (no route to host), or a hostname that does not resolve.
        raise DeviceUnreachableError(
            f"Unreachable: cannot open TCP port {port} on {host} ({exc.strerror or exc})."
        ) from exc


def connect(
    host: str,
    username: str,
    password: str,
    port: int = 22,
    timeout: float = 10,
) -> BaseConnection:
    """Open an SSH session to a Cisco IOS device and return the connection.

    Raises DeviceUnreachableError, DeviceTimeoutError or
    DeviceAuthenticationError, each with a message saying what went wrong.
    """
    _check_tcp(host, port, timeout)
    try:
        return ConnectHandler(
            device_type="cisco_ios",
            host=host,
            username=username,
            password=password,
            port=port,
            conn_timeout=timeout,
        )
    except NetmikoAuthenticationException as exc:
        raise DeviceAuthenticationError(
            f"Authentication failed: {host} rejected the login for user '{username}' "
            "(wrong username or password)."
        ) from exc
    except NetmikoTimeoutException as exc:
        # Netmiko also uses this exception when the two sides share no key
        # exchange or host key algorithm. That is not a timeout, and saying
        # so would send the user looking in the wrong place.
        if "Incompatible ssh" in str(exc) or "no acceptable" in str(exc):
            raise DeviceSshError(
                f"SSH negotiation failed: {host} and this client have no key exchange or "
                "host key algorithm in common. Old IOS images only offer SHA-1 algorithms, "
                "which Paramiko 4 and later cannot use (see backend/requirements.txt)."
            ) from exc
        raise DeviceTimeoutError(
            f"Timeout: TCP port {port} on {host} is open but the SSH session "
            f"was not established within {timeout:g}s."
        ) from exc


def _show(conn: BaseConnection, command: str, parse: bool = True) -> ParsedOutput:
    """Run one show command, optionally parsing the output with TextFSM."""
    if not command.startswith("show "):
        raise ValueError(f"Refusing to send non-show command: {command!r}")
    try:
        # With use_textfsm=True Netmiko returns a list of dicts, or the raw
        # string if there is no template or the template matched nothing.
        return conn.send_command(command, use_textfsm=parse)
    except ReadTimeout as exc:
        raise DeviceTimeoutError(
            f"Timeout: {conn.host} stopped responding while running '{command}'."
        ) from exc


def get_interfaces(conn: BaseConnection) -> ParsedOutput:
    """Interfaces with IP address and status, from 'show ip interface brief'."""
    return _show(conn, "show ip interface brief")


def get_vlans(conn: BaseConnection) -> ParsedOutput:
    """VLANs with name, status and member ports, from 'show vlan brief'."""
    return _show(conn, "show vlan brief")


def get_mac_table(conn: BaseConnection) -> ParsedOutput:
    """MAC address to port mappings, from 'show mac address-table'."""
    return _show(conn, "show mac address-table")


def get_version(conn: BaseConnection) -> ParsedOutput:
    """Software version, hostname, uptime and hardware, from 'show version'."""
    return _show(conn, "show version")


def get_running_config(conn: BaseConnection) -> str:
    """The running configuration as raw text.

    The text can contain password hashes and SNMP communities: sanitize it
    before saving it anywhere that gets committed.
    """
    return _show(conn, "show running-config", parse=False)


def parse_interfaces_trunk(raw: str) -> ParsedOutput:
    """Parse 'show interfaces trunk' into one dict per trunk port.

    There is no TextFSM template for this command. The output is four small
    tables that all start with a "Port" column: the first has the trunk's
    mode and status, the other three each list VLANs. Returns the raw text
    unchanged if it does not look like that.
    """
    vlan_tables = {
        "Vlans allowed on trunk": "allowed_vlans",
        "Vlans allowed and active in management domain": "active_vlans",
        "Vlans in spanning tree forwarding state and not pruned": "forwarding_vlans",
    }
    ports: dict[str, dict] = {}
    column = None  # which table the current lines belong to
    last_port = None
    for line in raw.splitlines():
        if not line.strip():
            continue
        if line.startswith("Port"):
            title = line[4:].strip()
            column = vlan_tables.get(title, "status" if title.startswith("Mode") else None)
            continue
        if column is None:
            return raw
        if line[0].isspace():
            # A long VLAN list wraps onto continuation lines.
            if last_port and column != "status":
                ports[last_port][column] += line.strip()
            continue
        name, *rest = line.split()
        last_port = name
        if column == "status":
            if len(rest) < 4:
                return raw
            ports[name] = {
                "interface": name,
                "mode": rest[0],
                "encapsulation": rest[1],
                "status": rest[2],
                "native_vlan": rest[3],
                "allowed_vlans": "",
                "active_vlans": "",
                "forwarding_vlans": "",
            }
        elif name in ports:
            ports[name][column] = "".join(rest)
    return list(ports.values()) if ports else raw


def run_command(conn: BaseConnection, command: Command) -> ParsedOutput:
    """Run one collection command and return it structured where possible."""
    if command.key == "trunks":
        output = parse_interfaces_trunk(_show(conn, command.command, parse=False))
    else:
        output = _show(conn, command.command)
    # No output at all (for example no OSPF neighbours) is an empty table,
    # not unparseable text.
    if isinstance(output, str) and not output.strip():
        return []
    return output


def _ssh_note(conn: BaseConnection) -> str | None:
    """Say so when the session had to fall back to SHA-1 era SSH algorithms."""
    try:
        host_key = conn.remote_conn.get_transport().host_key_type
    except AttributeError:
        return None
    if host_key in _LEGACY_HOST_KEYS:
        return (
            f"Connected with legacy SSH ({host_key} host key, SHA-1): "
            "this device offers nothing stronger."
        )
    return None


def collect_device(conn: BaseConnection) -> DeviceData:
    """Read everything NetSense collects from a device. Show commands only.

    The device type is decided on the way: "show version" names the software
    image, and for an image that does not say "switch", whether the device
    accepts "show vlan brief" settles it. Only the commands for that type
    are then sent.
    """
    by_scope = {scope: [c for c in COMMANDS if c.scope == scope] for scope in ("all", "switch", "router")}
    data = {command.key: run_command(conn, command) for command in by_scope["all"]}

    kind = classifier.classify_collected(data["version"])
    vlans = None
    if kind["type"] != classifier.SWITCH:
        # Not obviously a switch from its image name. A switch answers this
        # with its VLAN table; a router with "% Invalid input".
        vlans = run_command(conn, next(c for c in by_scope["switch"] if c.key == "vlans"))
        kind = classifier.classify_collected(data["version"], vlans)

    scope = "switch" if kind["type"] == classifier.SWITCH else "router"
    for command in by_scope[scope]:
        if command.key == "vlans" and vlans is not None:
            data["vlans"] = vlans  # already fetched above
        else:
            data[command.key] = run_command(conn, command)

    return DeviceData(
        device_type=kind["type"],
        type_reason=kind["reason"],
        data=data,
        config=get_running_config(conn),
        note=_ssh_note(conn),
    )


def collect_host(host: str, username: str, password: str, timeout: float = 10) -> DeviceData:
    """Connect to a device, collect everything, and always disconnect."""
    conn = connect(host, username, password, timeout=timeout)
    try:
        return collect_device(conn)
    finally:
        conn.disconnect()
