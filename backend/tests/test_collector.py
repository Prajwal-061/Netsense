"""Collector tests. Netmiko and the TCP probe are mocked, so no lab is needed."""

from unittest.mock import MagicMock, patch

import pytest
from netmiko.exceptions import (
    NetmikoAuthenticationException,
    NetmikoTimeoutException,
    ReadTimeout,
)
from netmiko.utilities import get_structured_data_textfsm

from app.engine import collector

SHOW_IP_INT_BRIEF = """\
Interface              IP-Address      OK? Method Status                Protocol
GigabitEthernet0/0     unassigned      YES unset  up                    up
GigabitEthernet0/1     unassigned      YES unset  administratively down down
Vlan10                 192.168.17.10   YES NVRAM  up                    up
"""


@pytest.fixture
def conn():
    """A stand-in for a Netmiko connection."""
    fake = MagicMock()
    fake.host = "192.0.2.1"
    return fake


@pytest.fixture
def tcp_ok():
    """Make the TCP reachability probe succeed without touching the network."""
    with patch("app.engine.collector.socket.create_connection") as probe:
        yield probe


# --- connect() -------------------------------------------------------------


def test_connect_opens_cisco_ios_session(tcp_ok):
    with patch("app.engine.collector.ConnectHandler") as handler:
        result = collector.connect("192.0.2.1", "admin", "pw")

    assert result is handler.return_value
    kwargs = handler.call_args.kwargs
    assert kwargs["device_type"] == "cisco_ios"
    assert kwargs["host"] == "192.0.2.1"
    assert kwargs["username"] == "admin"
    assert kwargs["password"] == "pw"


@pytest.mark.parametrize(
    "os_error",
    [ConnectionRefusedError(111, "Connection refused"), OSError(113, "No route to host")],
)
def test_connect_unreachable(os_error):
    with patch("app.engine.collector.socket.create_connection", side_effect=os_error):
        with pytest.raises(collector.DeviceUnreachableError, match="Unreachable"):
            collector.connect("192.0.2.1", "admin", "pw")


def test_connect_tcp_timeout():
    with patch("app.engine.collector.socket.create_connection", side_effect=TimeoutError()):
        with pytest.raises(collector.DeviceTimeoutError, match="Timeout"):
            collector.connect("192.0.2.1", "admin", "pw")


def test_connect_ssh_timeout(tcp_ok):
    with patch("app.engine.collector.ConnectHandler", side_effect=NetmikoTimeoutException()):
        with pytest.raises(collector.DeviceTimeoutError, match="SSH session"):
            collector.connect("192.0.2.1", "admin", "pw")


def test_connect_wrong_credentials(tcp_ok):
    with patch(
        "app.engine.collector.ConnectHandler", side_effect=NetmikoAuthenticationException()
    ):
        with pytest.raises(collector.DeviceAuthenticationError) as excinfo:
            collector.connect("192.0.2.1", "admin", "s3cret-pw")

    assert "Authentication failed" in str(excinfo.value)
    assert "s3cret-pw" not in str(excinfo.value)


# --- show commands ---------------------------------------------------------


@pytest.mark.parametrize(
    "function, command",
    [
        (collector.get_interfaces, "show ip interface brief"),
        (collector.get_vlans, "show vlan brief"),
        (collector.get_mac_table, "show mac address-table"),
        (collector.get_version, "show version"),
    ],
)
def test_parsed_commands_use_textfsm(conn, function, command):
    conn.send_command.return_value = [{"key": "value"}]

    assert function(conn) == [{"key": "value"}]
    conn.send_command.assert_called_once_with(command, use_textfsm=True)


def test_falls_back_to_raw_text_when_textfsm_cannot_parse(conn):
    # Netmiko hands back the raw string when no template matches.
    conn.send_command.return_value = "some output TextFSM has no template for"

    assert collector.get_vlans(conn) == "some output TextFSM has no template for"


def test_running_config_is_raw_text(conn):
    conn.send_command.return_value = "hostname SW1\n!\nend"

    assert collector.get_running_config(conn) == "hostname SW1\n!\nend"
    conn.send_command.assert_called_once_with("show running-config", use_textfsm=False)


def test_command_timeout(conn):
    conn.send_command.side_effect = ReadTimeout()

    with pytest.raises(collector.DeviceTimeoutError, match="show version"):
        collector.get_version(conn)


def test_refuses_non_show_commands(conn):
    with pytest.raises(ValueError):
        collector._show(conn, "configure terminal")

    conn.send_command.assert_not_called()


# --- TextFSM itself --------------------------------------------------------


def test_textfsm_template_parses_sample_output():
    """Run real sample CLI text through the real ntc-templates template."""
    rows = get_structured_data_textfsm(
        SHOW_IP_INT_BRIEF, platform="cisco_ios", command="show ip interface brief"
    )

    assert len(rows) == 3
    assert rows[2]["interface"] == "Vlan10"
    assert rows[2]["ip_address"] == "192.168.17.10"
    assert rows[1]["status"] == "administratively down"
