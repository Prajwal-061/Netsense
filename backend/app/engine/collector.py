"""Device collector: SSH into a Cisco IOS device with Netmiko and return its state.

Every command sent from this module is a read-only "show" command.
"""

import socket

from netmiko import ConnectHandler
from netmiko.base_connection import BaseConnection
from netmiko.exceptions import (
    NetmikoAuthenticationException,
    NetmikoTimeoutException,
    ReadTimeout,
)

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
